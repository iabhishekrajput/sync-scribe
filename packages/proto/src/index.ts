// Shared wire constants between web and api.
// WS framing follows y-protocols varint message types — see PLAN.md §5.2.

export const WIRE_VERSION = 1;
export const SUBPROTOCOL_YJS = "syncscribe.yjs.v1";

// y-protocols message type IDs (varint). Mirrored here for type-safety in TS
// consumers; the canonical source is github.com/yjs/y-protocols.
export const MSG_SYNC = 0;
export const MSG_AWARENESS = 1;
export const MSG_AUTH = 2;
export const MSG_QUERY_AWARENESS = 3;
export const MSG_READONLY = 4;
export const MSG_ACK = 5;

// Sub-types within MSG_SYNC.
export const SYNC_STEP_1 = 0;
export const SYNC_STEP_2 = 1;
export const SYNC_UPDATE = 2;

// WS close codes used by the server.
export const CLOSE_AUTH_EXPIRED = 4001;
export const CLOSE_UNSUPPORTED_PROTOCOL = 4002;
export const CLOSE_PERMISSION_DENIED = 4003;
export const CLOSE_RATE_LIMITED = 4008;
export const CLOSE_RESYNC = 4010;
export const CLOSE_DOC_DELETED = 4404;

export type Actor = "human" | "guest";
export type Role = "viewer" | "editor" | "owner";

export interface PresenceState {
  clientId: number;
  actor: Actor;
  principal: { id: string; name: string; color: string };
  cursor?: { anchor: number; head: number };
}
