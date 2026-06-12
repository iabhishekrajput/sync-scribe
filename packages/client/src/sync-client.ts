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
  SYNC_STEP_1,
  SYNC_STEP_2,
  SYNC_UPDATE,
} from "@syncscribe/proto";

import { ByteCursor, encodeYjsAwarenessFrame, encodeYjsSyncFrame } from "./codec";
import { buildSyncProtocols } from "./urls";
import type { ConnectionState, DisconnectLevel, SaveState } from "./types";

const DEFAULT_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 15_000;

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

// Structural seam over the platform WebSocket so tests (and exotic runtimes)
// can inject an implementation. Method shorthand keeps the param checks
// bivariant, which is what lets both DOM WebSocket and fakes satisfy it.
type WebSocketLike = {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
};

type WebSocketCtor = new (url: string, protocols?: string[]) => WebSocketLike;

export type SyncClientOptions = {
  url: string;
  doc: Y.Doc;
  awareness?: Awareness;
  /** Fixed Sec-WebSocket-Protocol list. Ignored when getToken is set. */
  protocols?: string[];
  /**
   * Re-evaluated on every connect attempt so reconnects pick up refreshed
   * bearer tokens. Returning null parks the client offline (no retry) —
   * the caller decides how to re-authenticate.
   */
  getToken?: () => Promise<string | null>;
  autoConnect?: boolean;
  /**
   * Batch local updates for this many ms (merged via Y.mergeUpdates) before
   * shipping, so fast typing produces one persisted update per pause instead
   * of one per keystroke. 0 (default) sends each update immediately.
   */
  updateDebounceMs?: number;
  /** Injectable for tests and non-browser runtimes. */
  webSocketImpl?: WebSocketCtor;
  onAck?: () => void;
  onReadonlyChange?: (readonly: boolean) => void;
  onStateChange?: (state: ConnectionState) => void;
  /** Realtime persistence indicator — fires whenever pending↔acked moves. */
  onSaveState?: (state: SaveState) => void;
  /**
   * Fires once per mapped WS close with a user-facing reason. level is
   * "error" for revocations/expiries worth a toast, "info" for recoverable
   * cases like RESYNC.
   */
  onDisconnectReason?: (reason: string, level: DisconnectLevel) => void;
};

// SyncClient mirrors a Y.Doc against a SyncScribe server over a single WS.
// It owns reconnect with exponential backoff; the Y.Doc remains usable while
// offline because local edits queue in memory and ship on the next open.
export class SyncClient {
  private ws: WebSocketLike | null = null;
  private state: ConnectionState = "connecting";
  private retryMs = DEFAULT_RETRY_MS;
  private readonly = false;
  private destroyed = false;
  private synced = false;
  private outbox: Uint8Array[] = [];
  private awarenessOutbox: Uint8Array[] = [];
  private debouncedUpdates: Uint8Array[] = [];
  private updateFlushTimer: ReturnType<typeof setTimeout> | null = null;
  // Pending = update batches shipped but not yet ACKed by the server.
  private pendingSaves = 0;
  private saveState: SaveState = "saved";
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

  constructor(private readonly opts: SyncClientOptions) {
    // Key off transaction.local rather than origin === this so the filter
    // matches every local edit, including ones routed through editor
    // bindings that attach their own origin objects.
    this.docUpdateHandler = (update, origin, _doc, transaction) => {
      if (origin === this || this.readonly) return;
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
    if (opts.autoConnect !== false) void this.connect();
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  get isReadonly(): boolean {
    return this.readonly;
  }

  async connect(): Promise<void> {
    if (this.destroyed) return;
    this.setState(this.synced ? "syncing" : "connecting");

    let protocols = this.opts.protocols;
    if (this.opts.getToken) {
      const token = await this.opts.getToken();
      if (this.destroyed) return;
      if (!token) {
        // Unauthenticated — park offline; the caller decides what to do.
        this.setState("offline");
        return;
      }
      protocols = buildSyncProtocols(token);
    }

    const WS = this.opts.webSocketImpl ?? (WebSocket as unknown as WebSocketCtor);
    const ws = new WS(this.opts.url, protocols ?? buildSyncProtocols());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = DEFAULT_RETRY_MS;
      this.readonly = false;
      // On reconnect the old pendingSaves counter is meaningless — any ACKs
      // in flight before the drop were lost. Recompute from the outbox:
      // every queued frame is a pending save we still owe the server.
      const queued = this.outbox.splice(0);
      this.pendingSaves = queued.length;
      this.setState("syncing");
      for (const pending of queued) this.sendUpdate(pending);
      this.flushUpdates();
      this.recomputeSaveState();
      this.sendYjsSyncStep1();
      if (this.opts.awareness) {
        this.sendAwareness(encodeAwarenessUpdate(this.opts.awareness, [this.opts.awareness.clientID]));
      }
      for (const pending of this.awarenessOutbox.splice(0)) this.sendAwareness(pending);
    };

    ws.onmessage = (event) => {
      const frame = new Uint8Array(event.data as ArrayBuffer);
      if (frame.length === 0) return;
      this.handleYjsFrame(frame);
    };

    ws.onclose = (event) => {
      this.ws = null;
      if (this.destroyed) return;

      const mapped = DISCONNECT_REASONS[event.code];
      if (mapped) {
        this.opts.onDisconnectReason?.(mapped.reason, mapped.level);
      }

      // Terminal codes — stop trying. The user needs to re-auth, the doc is
      // gone, or the server explicitly said this principal can't be here.
      if (
        event.code === CLOSE_AUTH_EXPIRED ||
        event.code === CLOSE_PERMISSION_DENIED ||
        event.code === CLOSE_DOC_DELETED
      ) {
        this.destroyed = true;
        this.setState("offline");
        return;
      }

      // RESYNC means the server's view of our state has diverged (typically
      // because outbound backpressure dropped frames). Drop everything in
      // flight and let the next connect's replay rebuild from scratch.
      if (event.code === CLOSE_RESYNC) {
        this.outbox = [];
        this.awarenessOutbox = [];
        this.debouncedUpdates = [];
        this.pendingSaves = 0;
        this.synced = false;
        this.clearUpdateFlushTimer();
      }

      // Rate-limited means we're flooding. Skip straight to the long end of
      // the backoff so we don't retry-storm into the same cap.
      if (event.code === CLOSE_RATE_LIMITED) {
        this.retryMs = DEFAULT_MAX_RETRY_MS;
      }

      this.setState("offline");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, DEFAULT_MAX_RETRY_MS);
      setTimeout(() => void this.connect(), delay);
    };

    ws.onerror = () => {
      // close handler will run shortly; nothing to do here.
    };
  }

  destroy(): void {
    this.destroyed = true;
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

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
    this.recomputeSaveState();
  }

  // SaveState derives entirely from (connection live?) + (pending count).
  // Offline trumps everything — even if pending == 0 we want users to know
  // their edits aren't on the server yet.
  private recomputeSaveState(): void {
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

  private handleYjsFrame(frame: Uint8Array): void {
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
        this.opts.onReadonlyChange?.(true);
        return;
      case MSG_ACK:
        if (this.pendingSaves > 0) this.pendingSaves--;
        this.recomputeSaveState();
        this.opts.onAck?.();
        return;
    }
  }

  private scheduleUpdateFlush(): void {
    const debounce = this.opts.updateDebounceMs ?? 0;
    if (debounce <= 0) {
      this.flushUpdates();
      return;
    }
    this.clearUpdateFlushTimer();
    this.updateFlushTimer = setTimeout(() => this.flushUpdates(), debounce);
  }

  private clearUpdateFlushTimer(): void {
    if (!this.updateFlushTimer) return;
    clearTimeout(this.updateFlushTimer);
    this.updateFlushTimer = null;
  }

  private flushUpdates(): void {
    this.clearUpdateFlushTimer();
    if (this.readonly || this.debouncedUpdates.length === 0) return;
    const updates = this.debouncedUpdates.splice(0);
    const merged = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
    this.pendingSaves++;
    this.sendUpdate(merged);
    this.recomputeSaveState();
  }

  private sendUpdate(update: Uint8Array): void {
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

  private sendAwareness(update: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.awarenessOutbox.push(update);
      return;
    }
    this.ws.send(encodeYjsAwarenessFrame(update));
  }

  private sendYjsSyncStep1(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(encodeYjsSyncFrame(SYNC_STEP_1, Y.encodeStateVector(this.opts.doc)));
  }
}
