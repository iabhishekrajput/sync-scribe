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

const DEFAULT_RETRY_MS = 500;
const DEFAULT_MAX_RETRY_MS = 15_000;

export type ConnectionState = "connecting" | "syncing" | "live" | "readonly" | "offline";

export type SyncClientOptions = {
  url: string;
  doc: Y.Doc;
  awareness?: Awareness;
  protocols?: string[];
  autoConnect?: boolean;
  onAck?: () => void;
  onReadonlyChange?: (readonly: boolean) => void;
  onStateChange?: (state: ConnectionState) => void;
};

export type AttributionUpdate = {
  seq: number;
  origin_user: string;
  origin_name: string;
  created_at: string;
  blob: string;
};

export type AttributionQuery = {
  fromItem?: string;
  toItem?: string;
  sinceUpdateId?: number;
  limit?: number;
};

export type AttributionResponse = {
  updates: AttributionUpdate[];
  range: {
    from_item?: string;
    to_item?: string;
  };
  cursor: {
    since_update_id: number;
    next_since_update_id: number;
    limit: number;
  };
};

export type DocumentEvent = {
  id: number;
  document_id: string;
  actor_id?: string;
  actor_label: string;
  event_type: string;
  detail: Record<string, unknown>;
  created_at: string;
};

export type EventStreamOptions = {
  sinceEventId?: number;
  signal?: AbortSignal;
};

export type BlameMark = {
  userId: string;
  name: string;
  color: string;
  seq: number;
  createdAt: string;
};

export type AttributionSpan = {
  start: number;
  end: number;
  mark: BlameMark;
};

export class SyncClient {
  private ws: WebSocket | null = null;
  private state: ConnectionState = "connecting";
  private retryMs = DEFAULT_RETRY_MS;
  private readonly = false;
  private destroyed = false;
  private synced = false;
  private outbox: Uint8Array[] = [];
  private awarenessOutbox: Uint8Array[] = [];
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
    this.docUpdateHandler = (update, origin, _doc, transaction) => {
      if (origin === this || this.readonly) return;
      const local = (transaction as { local?: boolean } | undefined)?.local;
      if (!local) return;
      this.sendUpdate(update);
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
    if (opts.autoConnect !== false) this.connect();
  }

  get connectionState() {
    return this.state;
  }

  get isReadonly() {
    return this.readonly;
  }

  connect() {
    if (this.destroyed) return;
    this.setState(this.synced ? "syncing" : "connecting");

    const ws = new WebSocket(this.opts.url, this.opts.protocols ?? buildSyncProtocols());
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.retryMs = DEFAULT_RETRY_MS;
      this.readonly = false;
      this.setState("syncing");
      this.sendYjsSyncStep1();
      for (const pending of this.outbox.splice(0)) this.sendUpdate(pending);
      for (const pending of this.awarenessOutbox.splice(0)) this.sendAwareness(pending);
      if (this.opts.awareness) {
        this.sendAwareness(encodeAwarenessUpdate(this.opts.awareness, [this.opts.awareness.clientID]));
      }
    };

    ws.onmessage = (event) => {
      const frame = new Uint8Array(event.data as ArrayBuffer);
      if (frame.length === 0) return;
      this.handleYjsFrame(frame);
    };

    ws.onclose = (event) => {
      this.ws = null;
      if (this.destroyed) return;
      if (
        event.code === CLOSE_AUTH_EXPIRED ||
        event.code === CLOSE_PERMISSION_DENIED ||
        event.code === CLOSE_DOC_DELETED
      ) {
        this.destroyed = true;
        this.setState("offline");
        return;
      }
      if (event.code === CLOSE_RESYNC) {
        this.outbox = [];
        this.awarenessOutbox = [];
        this.synced = false;
      }
      if (event.code === CLOSE_RATE_LIMITED) {
        this.retryMs = DEFAULT_MAX_RETRY_MS;
      }
      this.setState("offline");
      const delay = this.retryMs;
      this.retryMs = Math.min(this.retryMs * 2, DEFAULT_MAX_RETRY_MS);
      setTimeout(() => this.connect(), delay);
    };
  }

  destroy() {
    this.destroyed = true;
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
  }

  private setState(state: ConnectionState) {
    if (this.state === state) return;
    this.state = state;
    this.opts.onStateChange?.(state);
  }

  private handleYjsFrame(frame: Uint8Array) {
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
            const reply = Y.encodeStateAsUpdate(this.opts.doc, payload);
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
        this.setState("readonly");
        this.opts.onReadonlyChange?.(true);
        return;
      case MSG_ACK:
        this.opts.onAck?.();
        return;
    }
  }

  private sendUpdate(update: Uint8Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.outbox.push(update);
      return;
    }
    this.ws.send(encodeYjsSyncFrame(SYNC_UPDATE, update));
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
}

export class SyncScribeApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly accessToken?: string,
  ) {}

  async getAttribution(documentId: string, query: AttributionQuery = {}): Promise<AttributionResponse> {
    const search = new URLSearchParams();
    if (query.fromItem) search.set("fromItem", query.fromItem);
    if (query.toItem) search.set("toItem", query.toItem);
    if (query.sinceUpdateId !== undefined) search.set("sinceUpdateId", String(query.sinceUpdateId));
    search.set("limit", String(query.limit ?? 500));
    return this.request<AttributionResponse>(`/api/documents/${documentId}/attribution?${search.toString()}`);
  }

  async *streamEvents(documentId: string, options: EventStreamOptions = {}): AsyncGenerator<DocumentEvent> {
    const search = new URLSearchParams();
    if (options.sinceEventId !== undefined) search.set("sinceEventId", String(options.sinceEventId));
    const qs = search.toString();
    const res = await this.fetchRaw(`/api/documents/${documentId}/events${qs ? `?${qs}` : ""}`, {
      headers: { Accept: "text/event-stream" },
      signal: options.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) throw new Error("This runtime does not expose a readable response body.");

    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const event = parseDocumentEvent(part);
          if (event) yield event;
        }
      }
      buffer += decoder.decode();
      const event = parseDocumentEvent(buffer);
      if (event) yield event;
    } finally {
      reader.releaseLock();
    }
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.fetchRaw(path, init);
    return res.json() as Promise<T>;
  }

  private async fetchRaw(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers });
    if (!res.ok) {
      throw new Error((await res.text().catch(() => "")) || res.statusText);
    }
    return res;
  }
}

export function computeBlame(updates: AttributionUpdate[]): Array<BlameMark | null> {
  const blameDoc = new Y.Doc();
  const blameText = blameDoc.getText("content");
  let blame: Array<BlameMark | null> = [];

  for (const update of updates) {
    const mark: BlameMark = {
      userId: update.origin_user || "guest",
      name: update.origin_name || (update.origin_user ? "Unknown user" : "Guest"),
      color: colorForUser(update.origin_user || "guest"),
      seq: update.seq,
      createdAt: update.created_at,
    };
    const observer = (event: Y.YTextEvent) => {
      let oldIdx = 0;
      const next: Array<BlameMark | null> = [];
      for (const delta of event.delta) {
        if ("retain" in delta) {
          for (let i = 0; i < (delta.retain as number); i++) next.push(blame[oldIdx++] ?? null);
        } else if ("insert" in delta) {
          const text = typeof delta.insert === "string" ? delta.insert : "";
          for (let i = 0; i < text.length; i++) next.push(mark);
        } else if ("delete" in delta) {
          oldIdx += delta.delete as number;
        }
      }
      while (oldIdx < blame.length) next.push(blame[oldIdx++] ?? null);
      blame = next;
    };
    blameText.observe(observer);
    Y.applyUpdate(blameDoc, base64ToBytes(update.blob));
    blameText.unobserve(observer);
  }

  blameDoc.destroy();
  return blame;
}

export function compressBlame(blame: Array<BlameMark | null>): AttributionSpan[] {
  const spans: AttributionSpan[] = [];
  let start = -1;
  let current: BlameMark | null = null;

  for (let i = 0; i <= blame.length; i++) {
    const next = i < blame.length ? blame[i] : null;
    const same =
      current &&
      next &&
      current.userId === next.userId &&
      current.seq === next.seq &&
      current.createdAt === next.createdAt;
    if (current && !same) {
      spans.push({ start, end: i, mark: current });
      current = null;
      start = -1;
    }
    if (!current && next) {
      current = next;
      start = i;
    }
  }

  return spans;
}

export function buildSyncUrl(baseUrl: string, documentId: string) {
  return `${trimTrailingSlash(baseUrl)}/api/sync/${documentId}`;
}

export function buildShareSyncUrl(baseUrl: string, documentId: string, shareToken: string) {
  return `${trimTrailingSlash(baseUrl)}/api/sync/${documentId}?share_token=${encodeURIComponent(shareToken)}`;
}

export function buildSyncProtocols(bearerToken?: string) {
  return bearerToken ? [SUBPROTOCOL_YJS, bearerToken] : [SUBPROTOCOL_YJS];
}

function colorForUser(userId: string) {
  const palette = ["#0ea5e9", "#16a34a", "#ea580c", "#7c3aed", "#e11d48", "#0891b2"];
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

function base64ToBytes(value: string) {
  const typed = Uint8Array as Uint8ArrayConstructor & {
    fromBase64?: (input: string) => Uint8Array;
  };
  if (typeof typed.fromBase64 === "function") {
    return typed.fromBase64(value);
  }
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

function trimTrailingSlash(value: string) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseDocumentEvent(frame: string): DocumentEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as DocumentEvent;
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
