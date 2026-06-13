export type ConnectionState = "connecting" | "syncing" | "live" | "readonly" | "offline";

// SaveState collapses the realtime persistence signal into the three states
// users actually care about:
//   - 'saving'  → there are local edits the server hasn't acknowledged yet
//   - 'saved'   → WS is live and every local edit has been persisted
//   - 'offline' → WS is down; edits are buffered locally and will flush on
//                 reconnect
export type SaveState = "saved" | "saving" | "offline";

export type DisconnectLevel = "error" | "info";

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
