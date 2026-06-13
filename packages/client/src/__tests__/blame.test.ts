import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { computeBlame, compressBlame } from "../blame";
import type { AttributionUpdate } from "../types";

function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

// Builds an attribution log the way the server stores it: each entry is one
// Yjs update blob with the writing user attached.
function makeLog(edits: Array<{ user: string; apply: (text: Y.Text) => void }>): AttributionUpdate[] {
  const doc = new Y.Doc();
  const text = doc.getText("content");
  const log: AttributionUpdate[] = [];
  let seq = 0;
  let currentUser = "";
  doc.on("update", (update: Uint8Array) => {
    seq++;
    log.push({
      seq,
      origin_user: currentUser,
      origin_name: currentUser ? `User ${currentUser}` : "",
      created_at: new Date(2026, 0, seq).toISOString(),
      blob: bytesToBase64(update),
    });
  });
  for (const edit of edits) {
    currentUser = edit.user;
    edit.apply(text);
  }
  doc.destroy();
  return log;
}

describe("computeBlame", () => {
  it("attributes each character to its inserting user", () => {
    const log = makeLog([
      { user: "alice", apply: (t) => t.insert(0, "hello") },
      { user: "bob", apply: (t) => t.insert(5, " world") },
    ]);
    const blame = computeBlame(log);
    expect(blame).toHaveLength(11);
    expect(blame.slice(0, 5).every((m) => m?.userId === "alice")).toBe(true);
    expect(blame.slice(5).every((m) => m?.userId === "bob")).toBe(true);
  });

  it("drops marks for deleted characters", () => {
    const log = makeLog([
      { user: "alice", apply: (t) => t.insert(0, "abcdef") },
      { user: "bob", apply: (t) => t.delete(1, 3) },
    ]);
    const blame = computeBlame(log);
    expect(blame).toHaveLength(3);
    expect(blame.every((m) => m?.userId === "alice")).toBe(true);
  });

  it("marks guest edits (empty origin_user) as guest", () => {
    const log = makeLog([{ user: "", apply: (t) => t.insert(0, "g") }]);
    const blame = computeBlame(log);
    expect(blame[0]?.userId).toBe("guest");
    expect(blame[0]?.name).toBe("Guest");
  });
});

describe("compressBlame", () => {
  it("merges adjacent same-mark chars into spans", () => {
    const log = makeLog([
      { user: "alice", apply: (t) => t.insert(0, "aaa") },
      { user: "bob", apply: (t) => t.insert(3, "bb") },
    ]);
    const spans = compressBlame(computeBlame(log));
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ start: 0, end: 3 });
    expect(spans[0].mark.userId).toBe("alice");
    expect(spans[1]).toMatchObject({ start: 3, end: 5 });
    expect(spans[1].mark.userId).toBe("bob");
  });

  it("returns no spans for empty blame", () => {
    expect(compressBlame([])).toEqual([]);
  });
});
