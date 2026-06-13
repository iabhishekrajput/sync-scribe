import { describe, expect, it } from "vitest";

import { buildLineDiff, splitLines } from "../lineDiff";

describe("buildLineDiff", () => {
  it("reports identical text as all-same lines", () => {
    const diff = buildLineDiff("a\nb", "a\nb");
    expect(diff.truncated).toBe(false);
    expect(diff.lines.every((l) => l.kind === "same")).toBe(true);
  });

  it("marks added and removed lines with line numbers", () => {
    const diff = buildLineDiff("keep\nold", "keep\nnew");
    expect(diff.lines).toEqual([
      { kind: "same", text: "keep", beforeLine: 1, afterLine: 1 },
      { kind: "removed", text: "old", beforeLine: 2 },
      { kind: "added", text: "new", afterLine: 2 },
    ]);
  });

  it("handles empty before (all added)", () => {
    const diff = buildLineDiff("", "a\nb");
    expect(diff.lines.map((l) => l.kind)).toEqual(["added", "added"]);
  });

  it("handles empty after (all removed)", () => {
    const diff = buildLineDiff("a\nb", "");
    expect(diff.lines.map((l) => l.kind)).toEqual(["removed", "removed"]);
  });

  it("truncates instead of freezing on huge inputs", () => {
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const diff = buildLineDiff(big, big.toUpperCase());
    expect(diff.truncated).toBe(true);
    expect(diff.lines).toEqual([]);
  });
});

describe("splitLines", () => {
  it("returns [] for empty string", () => {
    expect(splitLines("")).toEqual([]);
  });
  it("splits CRLF and LF", () => {
    expect(splitLines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });
});
