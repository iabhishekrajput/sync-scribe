import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectPresencePeers, PRESENCE_LINGER_MS, presenceInitial, presenceStatus, samePeerList, type PresencePeer } from "../presence";

function peer(overrides: Partial<PresencePeer>): PresencePeer {
  return {
    clientID: 1,
    name: "A",
    color: "#fff",
    actor: "human",
    connected: true,
    lastSeen: Date.now(),
    ...overrides,
  };
}

describe("collectPresencePeers", () => {
  let doc: Y.Doc;
  let awareness: Awareness;

  beforeEach(() => {
    vi.useFakeTimers();
    doc = new Y.Doc();
    awareness = new Awareness(doc);
  });
  afterEach(() => {
    vi.useRealTimers();
    awareness.destroy();
    doc.destroy();
  });

  it("excludes the local client and reads peer user state", () => {
    awareness.setLocalStateField("user", { name: "Me", color: "#111", actor: "human" });
    awareness.states.set(99, { user: { name: "Peer", color: "#222", actor: "guest" } });
    const peers = collectPresencePeers(awareness, []);
    expect(peers).toHaveLength(1);
    expect(peers[0]).toMatchObject({ clientID: 99, name: "Peer", actor: "guest", connected: true });
  });

  it("lingers departed peers as disconnected, then drops them", () => {
    const old = peer({ clientID: 5, lastSeen: Date.now() });
    const lingering = collectPresencePeers(awareness, [old]);
    expect(lingering).toHaveLength(1);
    expect(lingering[0].connected).toBe(false);

    vi.advanceTimersByTime(PRESENCE_LINGER_MS + 1);
    expect(collectPresencePeers(awareness, lingering)).toHaveLength(0);
  });

  it("sorts connected peers before lingering ones", () => {
    awareness.states.set(2, { user: { name: "Zed", color: "#222" } });
    const ghost = peer({ clientID: 9, name: "Aaa" });
    const peers = collectPresencePeers(awareness, [ghost]);
    expect(peers.map((p) => p.name)).toEqual(["Zed", "Aaa"]);
  });
});

describe("samePeerList", () => {
  it("compares by clientID, color, name", () => {
    const a = [peer({ clientID: 1 })];
    expect(samePeerList(a, [peer({ clientID: 1 })])).toBe(true);
    expect(samePeerList(a, [peer({ clientID: 2 })])).toBe(false);
    expect(samePeerList(a, [])).toBe(false);
  });
});

describe("presence labels", () => {
  it("guests get G; humans get their first letter", () => {
    expect(presenceInitial(peer({ actor: "guest", name: "whatever" }))).toBe("G");
    expect(presenceInitial(peer({ name: "luffy" }))).toBe("L");
    expect(presenceInitial(peer({ name: "  " }))).toBe("U");
  });

  it("status reflects connection and typing freshness", () => {
    expect(presenceStatus(peer({ connected: false }))).toBe("Left just now");
    expect(presenceStatus(peer({ typingAt: Date.now() }))).toBe("Typing now");
    expect(presenceStatus(peer({}))).toBe("Viewing");
  });
});
