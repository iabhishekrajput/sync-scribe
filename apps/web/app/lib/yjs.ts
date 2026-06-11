"use client";

import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import {
  CLOSE_AUTH_EXPIRED,
  CLOSE_DOC_DELETED,
  CLOSE_PERMISSION_DENIED,
  CLOSE_RATE_LIMITED,
  CLOSE_RESYNC,
  MSG_ACK,
  MSG_AWARENESS,
  MSG_READONLY,
  MSG_SYNC,
  SUBPROTOCOL_YJS,
  SYNC_STEP_1,
  SYNC_STEP_2,
  SYNC_UPDATE,
} from "@syncscribe/proto";
import { getAccessToken } from "./auth";

const UPDATE_DEBOUNCE_MS = 600;

export type ConnectionState = "connecting" | "syncing" | "live" | "readonly" | "offline";

// SaveState collapses the realtime persistence signal into the three states
// users actually care about:
//   - 'saving'  → there are local edits the server hasn't acknowledged yet
//   - 'saved'   → WS is live and every local edit has been persisted
//   - 'offline' → WS is down; edits are buffered locally and will flush on
//                 reconnect
export type SaveState = "saved" | "saving" | "offline";

const WS_BASE = process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8080";

export type DisconnectLevel = "error" | "info";

export type SyncProviderOptions = {
  docId: string;
  doc: Y.Doc;
  awareness?: Awareness;
  onState?: (s: ConnectionState) => void;
  /** Realtime persistence indicator — fires whenever pending↔acked moves. */
  onSaveState?: (s: SaveState) => void;
  /**
   * Fires once per terminal WS close with a user-facing reason mapped from
   * the close code. `level === "error"` for revocations / expiries that the
   * UI should surface as a toast; `"info"` for recoverable cases like RESYNC.
   */
  onDisconnectReason?: (reason: string, level: DisconnectLevel) => void;
  // When set, authenticate the WS via ?share_token=… instead of the user's
  // access token. Used by the public read page (/p/[token]).
  shareToken?: string;
};

const DISCONNECT_REASONS: Record<number, { reason: string; level: DisconnectLevel }> = {
  [CLOSE_AUTH_EXPIRED]: {
    reason: "Your session has expired. Sign in again to continue.",
    level: "error",
  },
  [CLOSE_PERMISSION_DENIED]: {
    reason: "Your access to this document has been revoked.",
    level: "error",
  },
  [CLOSE_DOC_DELETED]: {
    reason: "This document has been deleted.",
    level: "error",
  },
  [CLOSE_RATE_LIMITED]: {
    reason: "You're sending updates too fast — pausing briefly.",
    level: "error",
  },
  [CLOSE_RESYNC]: {
    reason: "Reconnecting to resync the document…",
    level: "info",
  },
};

// SyncProvider mirrors a Y.Doc against the server over a single WS. It owns
// reconnect with exponential backoff; the Y.Doc remains usable while offline
// because local edits queue in memory and ship on the next open.
export class SyncProvider {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "connecting";
  private retryMs = 500;
  private maxRetryMs = 15_000;
  private closed = false;
  private docUpdateHandler: (
    update: Uint8Array,
    origin: unknown,
    doc: Y.Doc,
    transaction: unknown,
  ) => void;
  private awarenessUpdateHandler?: (
    update: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  private outbox: Uint8Array[] = [];
  private awarenessOutbox: Uint8Array[] = [];
  private debouncedUpdates: Uint8Array[] = [];
  private updateFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private synced = false;
  private readonly = false;

  // Pending = local update batches we've shipped and not yet seen an ACK for.
  private pendingSaves = 0;
  private saveState: SaveState = "saved";

  constructor(private opts: SyncProviderOptions) {
    // Y.Doc's update event passes (update, origin, doc, transaction). We key
    // off transaction.local rather than origin === this so the filter
    // matches every local edit, including ones routed through editor bindings
    // that attach their own origin objects.
    this.docUpdateHandler = (update, origin, _doc, transaction) => {
      if (origin === this) return; // remote-applied, don't echo back
      if (this.readonly) return;
      const local = (transaction as { local?: boolean } | undefined)?.local;
      if (!local) return;
      this.debouncedUpdates.push(update);
      this.scheduleUpdateFlush();
      this.recomputeSaveState();
    };
    opts.doc.on("update", this.docUpdateHandler);
    if (opts.awareness) {
      this.awarenessUpdateHandler = ({ added, updated, removed }, origin) => {
        if (origin === this || !opts.awareness) return;
        const changed = added.concat(updated, removed);
        this.sendAwareness(encodeAwarenessUpdate(opts.awareness, changed));
      };
      opts.awareness.on("update", this.awarenessUpdateHandler);
    }
    this.connect();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  destroy() {
    this.closed = true;
    this.flushUpdates();
    this.opts.doc.off("update", this.docUpdateHandler);
    if (this.opts.awareness && this.awarenessUpdateHandler) {
      const clientID = this.opts.awareness.clientID;
      removeAwarenessStates(this.opts.awareness, [clientID], this);
      this.sendAwareness(encodeAwarenessUpdate(this.opts.awareness, [clientID]));
      this.opts.awareness.off("update", this.awarenessUpdateHandler);
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.clearUpdateFlushTimer();
  }

  private setState(s: ConnectionState) {
    if (this.state === s) return;
    this.state = s;
    this.opts.onState?.(s);
    this.recomputeSaveState();
  }

  // SaveState derives entirely from (connection live?) + (pending count).
  // Offline trumps everything — even if pending == 0 we want users to know
  // their edits aren't on the server yet.
  private recomputeSaveState() {
    let next: SaveState;
    if (this.state !== "live" && this.state !== "readonly") {
      next = this.state === "offline" ? "offline" : "saving";
    } else if (this.pendingSaves > 0 || this.debouncedUpdates.length > 0 || this.outbox.length > 0) {
      next = "saving";
    } else {
      next = "saved";
    }
    if (next === this.saveState) return;
    this.saveState = next;
    this.opts.onSaveState?.(next);
  }

  private async connect() {
    if (this.closed) return;
    this.setState(this.synced ? "syncing" : "connecting");

    let url: string;
    let protocols: string[];
    if (this.opts.shareToken) {
      // Public share-link path: no user session, the token in the URL is the
      // only credential. Anonymous read/edit per the link's role.
      url = `${WS_BASE}/api/sync/${this.opts.docId}?share_token=${encodeURIComponent(this.opts.shareToken)}`;
      protocols = [SUBPROTOCOL_YJS];
    } else {
      const token = await getAccessToken();
      if (!token) {
        // unauth — let the caller decide what to do
        this.setState("offline");
        return;
      }
      url = `${WS_BASE}/api/sync/${this.opts.docId}`;
      // Token rides as the second subprotocol — server's bearerToken() pulls
      // it out. Browsers refuse Authorization headers on WS upgrade.
      protocols = [SUBPROTOCOL_YJS, token];
    }
    const ws = new WebSocket(url, protocols);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = 500;
      this.readonly = false;
      // On reconnect the old pendingSaves counter is meaningless — any
      // ACKs in flight before the drop were lost. Recompute from the outbox:
      // every queued frame is a pending save we still owe the server.
      const queued = this.outbox.splice(0);
      this.pendingSaves = queued.length;
      this.setState("syncing");
      for (const u of queued) this.sendUpdate(u);
      this.flushUpdates();
      this.recomputeSaveState();
      this.sendYjsSyncStep1();
      if (this.opts.awareness) {
        this.sendAwareness(encodeAwarenessUpdate(this.opts.awareness, [this.opts.awareness.clientID]));
      }
      for (const u of this.awarenessOutbox.splice(0)) {
        this.sendAwareness(u);
      }
    };

    ws.onmessage = (ev) => {
      const data = new Uint8Array(ev.data as ArrayBuffer);
      if (data.length === 0) return;
      this.handleYjsMessage(data);
    };

    ws.onclose = (ev: CloseEvent) => {
      this.ws = null;
      if (this.closed) return;

      const mapped = DISCONNECT_REASONS[ev.code];
      if (mapped) {
        this.opts.onDisconnectReason?.(mapped.reason, mapped.level);
      }

      // Terminal codes — stop trying. The user needs to re-auth, the doc is
      // gone, or the server explicitly said this principal can't be here.
      if (
        ev.code === CLOSE_AUTH_EXPIRED ||
        ev.code === CLOSE_PERMISSION_DENIED ||
        ev.code === CLOSE_DOC_DELETED
      ) {
        this.closed = true;
        this.setState("offline");
        return;
      }

      // RESYNC means the server's view of our state has diverged (typically
      // because outbound backpressure dropped frames). Drop everything we
      // had in flight and let the next connect's replay rebuild from
      // scratch.
      if (ev.code === CLOSE_RESYNC) {
        this.outbox = [];
        this.awarenessOutbox = [];
        this.debouncedUpdates = [];
        this.pendingSaves = 0;
        this.synced = false;
        this.clearUpdateFlushTimer();
      }

      // Rate-limited means we're flooding. Skip straight to the long end of
      // the backoff so we don't retry-storm into the same cap.
      if (ev.code === CLOSE_RATE_LIMITED) {
        this.retryMs = this.maxRetryMs;
      }

      this.setState("offline");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, this.maxRetryMs);
      setTimeout(() => this.connect(), delay);
    };

    ws.onerror = () => {
      // close handler will run shortly; nothing to do here.
    };
  }

  private sendUpdate(update: Uint8Array) {
    if (this.readonly) {
      this.setState("readonly");
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    this.ws.send(encodeYjsSyncFrame(SYNC_UPDATE, update));
  }

  private scheduleUpdateFlush() {
    this.clearUpdateFlushTimer();
    this.updateFlushTimer = setTimeout(() => this.flushUpdates(), UPDATE_DEBOUNCE_MS);
  }

  private clearUpdateFlushTimer() {
    if (!this.updateFlushTimer) return;
    clearTimeout(this.updateFlushTimer);
    this.updateFlushTimer = null;
  }

  private flushUpdates() {
    this.clearUpdateFlushTimer();
    if (this.readonly || this.debouncedUpdates.length === 0) return;
    const updates = this.debouncedUpdates.splice(0);
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    this.pendingSaves++;
    this.sendUpdate(merged);
    this.recomputeSaveState();
  }

  private sendAwareness(update: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.awarenessOutbox.push(update);
      return;
    }
    this.ws.send(encodeYjsAwarenessFrame(update));
  }

  private sendYjsSyncStep1() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeYjsSyncFrame(SYNC_STEP_1, Y.encodeStateVector(this.opts.doc)));
  }

  private handleYjsMessage(frame: Uint8Array) {
    const reader = new ByteCursor(frame);
    const msgType = reader.readVarUint();
    if (msgType === null) return;
    switch (msgType) {
      case MSG_SYNC: {
        const syncType = reader.readVarUint();
        const payload = reader.readVarBytes();
        if (syncType === null || payload === null || !reader.done()) return;
        if (syncType === SYNC_UPDATE || syncType === SYNC_STEP_2) {
          Y.applyUpdate(this.opts.doc, payload, this);
          return;
        }
        if (syncType === SYNC_STEP_1) {
          if (this.ws?.readyState === WebSocket.OPEN) {
            const reply = Y.encodeStateAsUpdate(
              this.opts.doc,
              payload.length > 0 ? payload : undefined,
            );
            this.ws.send(encodeYjsSyncFrame(SYNC_STEP_2, reply));
          }
          this.synced = true;
          if (!this.readonly) this.setState("live");
        }
        return;
      }
      case MSG_AWARENESS: {
        const payload = reader.readVarBytes();
        if (payload === null || !reader.done()) return;
        if (this.opts.awareness) applyAwarenessUpdate(this.opts.awareness, payload, this);
        return;
      }
      case MSG_READONLY:
        this.readonly = true;
        this.outbox = [];
        this.debouncedUpdates = [];
        this.clearUpdateFlushTimer();
        this.pendingSaves = 0;
        this.setState("readonly");
        return;
      case MSG_ACK:
        if (this.pendingSaves > 0) this.pendingSaves--;
        this.recomputeSaveState();
        return;
    }
  }
}

class ByteCursor {
  private index = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readVarUint() {
    let value = 0;
    let shift = 0;
    while (this.index < this.bytes.length) {
      const byte = this.bytes[this.index++];
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7;
      if (shift > 35) return null;
    }
    return null;
  }

  readVarBytes() {
    const len = this.readVarUint();
    if (len === null) return null;
    if (this.index + len > this.bytes.length) return null;
    const out = this.bytes.slice(this.index, this.index + len);
    this.index += len;
    return out;
  }

  done() {
    return this.index === this.bytes.length;
  }
}

function encodeYjsSyncFrame(kind: number, payload: Uint8Array) {
  return concatBytes(encodeVarUint(MSG_SYNC), encodeVarUint(kind), encodeVarBytes(payload));
}

function encodeYjsAwarenessFrame(payload: Uint8Array) {
  return concatBytes(encodeVarUint(MSG_AWARENESS), encodeVarBytes(payload));
}

function encodeVarBytes(payload: Uint8Array) {
  return concatBytes(encodeVarUint(payload.length), payload);
}

function encodeVarUint(value: number) {
  const bytes: number[] = [];
  let next = value >>> 0;
  while (next > 0x7f) {
    bytes.push((next & 0x7f) | 0x80);
    next >>>= 7;
  }
  bytes.push(next);
  return Uint8Array.from(bytes);
}

function concatBytes(...parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
