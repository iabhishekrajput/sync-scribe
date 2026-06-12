// Characterization tests for SyncClient reconnect/save-state semantics,
// transcribed from the web SyncProvider behavior before it was absorbed into
// the SDK. These pin the contract; change them only deliberately.
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_AUTH_EXPIRED,
  CLOSE_RATE_LIMITED,
  CLOSE_RESYNC,
  MSG_ACK,
  MSG_READONLY,
  MSG_SYNC,
  SYNC_STEP_1,
  SYNC_UPDATE,
} from "@syncscribe/proto";

import { ByteCursor, encodeVarUint, encodeYjsSyncFrame } from "../codec";
import { SyncClient } from "../sync-client";
import type { ConnectionState, SaveState } from "../types";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0; // CONNECTING
  binaryType = "blob";
  sent: Uint8Array[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(new Uint8Array(data));
  }

  close(): void {
    this.readyState = 3;
  }

  simulateOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }

  simulateFrame(frame: Uint8Array): void {
    const buffer = new ArrayBuffer(frame.byteLength);
    new Uint8Array(buffer).set(frame);
    this.onmessage?.({ data: buffer } as MessageEvent);
  }

  simulateClose(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

type SentFrame =
  | { kind: "sync"; syncType: number; payload: Uint8Array }
  | { kind: "awareness" }
  | { kind: "other"; msgType: number };

function decodeSent(frame: Uint8Array): SentFrame {
  const cursor = new ByteCursor(frame);
  const msgType = cursor.readVarUint();
  if (msgType === MSG_SYNC) {
    const syncType = cursor.readVarUint();
    const payload = cursor.readVarBytes();
    return { kind: "sync", syncType: syncType ?? -1, payload: payload ?? new Uint8Array(0) };
  }
  if (msgType === 1) return { kind: "awareness" };
  return { kind: "other", msgType: msgType ?? -1 };
}

function flagFrame(kind: number): Uint8Array {
  return encodeVarUint(kind);
}

function lastSocket(): FakeWebSocket {
  return FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
}

describe("SyncClient", () => {
  let doc: Y.Doc;
  let states: ConnectionState[];
  let saveStates: SaveState[];
  let acks: number;

  beforeEach(() => {
    vi.useFakeTimers();
    FakeWebSocket.instances = [];
    doc = new Y.Doc();
    states = [];
    saveStates = [];
    acks = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    doc.destroy();
  });

  function makeClient(opts: Partial<ConstructorParameters<typeof SyncClient>[0]> = {}) {
    return new SyncClient({
      url: "ws://test/api/sync/doc-1",
      doc,
      webSocketImpl: FakeWebSocket as never,
      onStateChange: (s) => states.push(s),
      onSaveState: (s) => saveStates.push(s),
      onAck: () => acks++,
      ...opts,
    });
  }

  it("sends SyncStep1 with the doc state vector on open", () => {
    const client = makeClient();
    const ws = lastSocket();
    ws.simulateOpen();
    expect(ws.sent).toHaveLength(1);
    const frame = decodeSent(ws.sent[0]);
    expect(frame).toMatchObject({ kind: "sync", syncType: SYNC_STEP_1 });
    client.destroy();
  });

  it("goes live on server SyncStep1 and replies with SyncStep2", () => {
    const client = makeClient();
    const ws = lastSocket();
    ws.simulateOpen();
    ws.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));
    expect(states).toContain("live");
    const replies = ws.sent.map(decodeSent);
    expect(replies.some((f) => f.kind === "sync" && f.syncType === 1)).toBe(true);
    client.destroy();
  });

  it("local edits ship as SyncUpdate and one ACK settles save state", () => {
    const client = makeClient();
    const ws = lastSocket();
    ws.simulateOpen();
    ws.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));

    doc.getText("content").insert(0, "hi");
    const updates = ws.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(1);
    expect(saveStates).toContain("saving");

    ws.simulateFrame(flagFrame(MSG_ACK));
    expect(acks).toBe(1);
    expect(saveStates[saveStates.length - 1]).toBe("saved");
    client.destroy();
  });

  it("debounces local edits into one merged update per window", () => {
    const client = makeClient({ updateDebounceMs: 600 });
    const ws = lastSocket();
    ws.simulateOpen();
    ws.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));

    doc.getText("content").insert(0, "a");
    doc.getText("content").insert(1, "b");
    doc.getText("content").insert(2, "c");
    let updates = ws.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(0);

    vi.advanceTimersByTime(600);
    updates = ws.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(1);

    // The merged update reconstructs the full text in a fresh doc.
    const replica = new Y.Doc();
    const update = updates[0];
    if (update.kind !== "sync") throw new Error("unreachable");
    Y.applyUpdate(replica, update.payload);
    expect(replica.getText("content").toString()).toBe("abc");
    replica.destroy();
    client.destroy();
  });

  it("queues edits while closed and recomputes pendingSaves on reconnect", () => {
    const client = makeClient();
    const ws1 = lastSocket();
    ws1.simulateOpen();
    ws1.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));
    ws1.simulateClose(1006);
    expect(states[states.length - 1]).toBe("offline");
    expect(saveStates[saveStates.length - 1]).toBe("offline");

    // Edit while offline: queued, not sent.
    doc.getText("content").insert(0, "offline edit");

    vi.advanceTimersByTime(500); // first backoff step
    const ws2 = lastSocket();
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();
    const updates = ws2.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(1);
    expect(saveStates[saveStates.length - 1]).toBe("saving");

    ws2.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));
    ws2.simulateFrame(flagFrame(MSG_ACK));
    expect(saveStates[saveStates.length - 1]).toBe("saved");
    client.destroy();
  });

  it("backs off exponentially and resets on successful open", () => {
    const client = makeClient();
    lastSocket().simulateClose(1006);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    lastSocket().simulateClose(1006);
    vi.advanceTimersByTime(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
    client.destroy();
  });

  it("jumps to max backoff after a rate-limit close", () => {
    const client = makeClient();
    lastSocket().simulateClose(CLOSE_RATE_LIMITED);
    vi.advanceTimersByTime(14_999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.destroy();
  });

  it("RESYNC drops outbox and pending saves", () => {
    const client = makeClient();
    const ws = lastSocket();
    ws.simulateOpen();
    ws.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));
    ws.readyState = 3; // sends start queueing
    doc.getText("content").insert(0, "doomed");
    ws.simulateClose(CLOSE_RESYNC);

    vi.advanceTimersByTime(500);
    const ws2 = lastSocket();
    ws2.simulateOpen();
    const updates = ws2.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(0);
    client.destroy();
  });

  it("terminal close codes stop reconnecting", () => {
    const client = makeClient();
    let reason = "";
    const c2 = makeClient({ onDisconnectReason: (r) => (reason = r) });
    void client;
    lastSocket().simulateClose(CLOSE_AUTH_EXPIRED);
    expect(reason).toContain("session has expired");
    vi.advanceTimersByTime(60_000);
    // Only the two initial sockets — no reconnect attempt for c2.
    expect(FakeWebSocket.instances).toHaveLength(2);
    c2.destroy();
    client.destroy();
  });

  it("readonly frame clears pending work and fires onReadonlyChange", () => {
    let readonly = false;
    const client = makeClient({
      updateDebounceMs: 600,
      onReadonlyChange: (r) => (readonly = r),
    });
    const ws = lastSocket();
    ws.simulateOpen();
    ws.simulateFrame(encodeYjsSyncFrame(SYNC_STEP_1, new Uint8Array(0)));
    doc.getText("content").insert(0, "x");
    ws.simulateFrame(flagFrame(MSG_READONLY));
    expect(readonly).toBe(true);
    expect(states[states.length - 1]).toBe("readonly");

    vi.advanceTimersByTime(600);
    const updates = ws.sent.map(decodeSent).filter((f) => f.kind === "sync" && f.syncType === SYNC_UPDATE);
    expect(updates).toHaveLength(0);
    client.destroy();
  });

  it("parks offline without retry when getToken returns null", async () => {
    vi.useRealTimers();
    const client = makeClient({ getToken: async () => null });
    await Promise.resolve();
    await Promise.resolve();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(states[states.length - 1]).toBe("offline");
    client.destroy();
  });

  it("getToken result rides as the second subprotocol", async () => {
    vi.useRealTimers();
    const client = makeClient({ getToken: async () => "tok-123" });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastSocket().protocols).toEqual(["syncscribe.yjs.v1", "tok-123"]);
    client.destroy();
  });
});
