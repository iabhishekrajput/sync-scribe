import * as Y from "yjs";
import { describe, expect, it } from "vitest";

import { compactCommentSnippet, decodeBase64, encodeBase64, resolveCommentAnchor, resolveRelativeIndex } from "../commentAnchors";
import type { DocumentComment } from "../api";

function relAnchor(ytext: Y.Text, index: number) {
  return encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, index)));
}

function comment(overrides: Partial<DocumentComment>): DocumentComment {
  return {
    id: "c1",
    document_id: "d1",
    author_id: "u1",
    author_name: "U",
    kind: "comment",
    body: "b",
    created_at: "2026-01-01",
    ...overrides,
  };
}

describe("base64 round-trip", () => {
  it("encodes and decodes bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250]);
    expect(Array.from(decodeBase64(encodeBase64(bytes)))).toEqual([0, 1, 2, 250]);
  });
});

describe("resolveRelativeIndex", () => {
  it("tracks an anchor through concurrent edits", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "hello world");
    const anchor = relAnchor(text, 6); // before "world"

    text.insert(0, "PREFIX "); // shift everything right by 7
    expect(resolveRelativeIndex(doc, text, anchor)).toBe(13);
  });

  it("returns null for garbage input", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    expect(resolveRelativeIndex(doc, text, "!!!not-base64!!!")).toBeNull();
    expect(resolveRelativeIndex(doc, text, undefined)).toBeNull();
  });
});

describe("resolveCommentAnchor", () => {
  it("resolves to current offsets and line number", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    text.insert(0, "line one\nline two");
    const c = comment({
      anchor_start: relAnchor(text, 9),
      anchor_end: relAnchor(text, 13),
    });
    expect(resolveCommentAnchor(c, doc, text)).toEqual({ from: 9, to: 13, line: 2 });
  });

  it("falls back to line_number when anchors are unresolvable", () => {
    const doc = new Y.Doc();
    const text = doc.getText("content");
    const c = comment({ line_number: 7 });
    expect(resolveCommentAnchor(c, doc, text)).toEqual({ from: null, to: null, line: 7 });
  });
});

describe("compactCommentSnippet", () => {
  it("collapses whitespace and trims", () => {
    expect(compactCommentSnippet("  a\n\n b\tc ")).toBe("a b c");
  });
  it("truncates long text with an ellipsis", () => {
    const out = compactCommentSnippet("x".repeat(500));
    expect(out.length).toBe(160);
    expect(out.endsWith("…")).toBe(true);
  });
});
