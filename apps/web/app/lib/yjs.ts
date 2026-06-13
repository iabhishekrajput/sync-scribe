"use client";

import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import {
  buildShareSyncUrl,
  buildSyncUrl,
  SyncClient,
  type ConnectionState,
  type DisconnectLevel,
  type SaveState,
} from "@syncscribe/client";

import { getAccessToken } from "./auth";

export type { ConnectionState, DisconnectLevel, SaveState };

const WS_BASE = process.env.NEXT_PUBLIC_WS_BASE_URL ?? "ws://localhost:8080";

// Batch local updates so fast typing persists as one update per pause
// instead of one per keystroke.
const UPDATE_DEBOUNCE_MS = 600;

export type SyncProviderOptions = {
  docId: string;
  doc: Y.Doc;
  awareness?: Awareness;
  onState?: (s: ConnectionState) => void;
  /** Realtime persistence indicator — fires whenever pending↔acked moves. */
  onSaveState?: (s: SaveState) => void;
  /** Fires once per mapped WS close with a user-facing reason. */
  onDisconnectReason?: (reason: string, level: DisconnectLevel) => void;
  // When set, authenticate the WS via ?share_token=… instead of the user's
  // access token. Used by the public share page (/p/[token]).
  shareToken?: string;
};

// Thin web adapter over the SDK's SyncClient: wires the API base URL, the
// in-memory access-token refresh, and the editor's debounce window.
export class SyncProvider {
  private readonly client: SyncClient;

  constructor(opts: SyncProviderOptions) {
    this.client = new SyncClient({
      url: opts.shareToken
        ? buildShareSyncUrl(WS_BASE, opts.docId, opts.shareToken)
        : buildSyncUrl(WS_BASE, opts.docId),
      doc: opts.doc,
      awareness: opts.awareness,
      getToken: opts.shareToken ? undefined : getAccessToken,
      updateDebounceMs: UPDATE_DEBOUNCE_MS,
      onStateChange: opts.onState,
      onSaveState: opts.onSaveState,
      onDisconnectReason: opts.onDisconnectReason,
    });
  }

  get connectionState(): ConnectionState {
    return this.client.connectionState;
  }

  destroy(): void {
    this.client.destroy();
  }
}
