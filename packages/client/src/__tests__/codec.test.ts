import { describe, expect, it } from "vitest";

import { ByteCursor, base64ToBytes, encodeVarUint, encodeYjsAwarenessFrame, encodeYjsSyncFrame } from "../codec";

describe("encodeVarUint", () => {
  // Fixtures hand-checked against Go's appendVarUint in
  // apps/api/internal/sync/awareness.go.
  const fixtures: Array<[number, number[]]> = [
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [300, [0xac, 0x02]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [2 ** 31 - 1, [0xff, 0xff, 0xff, 0xff, 0x07]],
  ];

  it("matches the Go encoding byte-for-byte", () => {
    for (const [value, bytes] of fixtures) {
      expect(Array.from(encodeVarUint(value)), `value ${value}`).toEqual(bytes);
    }
  });

  it("round-trips through ByteCursor", () => {
    for (const [value] of fixtures) {
      const cursor = new ByteCursor(encodeVarUint(value));
      expect(cursor.readVarUint()).toBe(value);
      expect(cursor.done()).toBe(true);
    }
  });
});

describe("frame encoding", () => {
  it("sync frame = MSG_SYNC, kind, varbytes payload", () => {
    const frame = encodeYjsSyncFrame(2, Uint8Array.from([0xaa, 0xbb]));
    expect(Array.from(frame)).toEqual([0x00, 0x02, 0x02, 0xaa, 0xbb]);
    const cursor = new ByteCursor(frame);
    expect(cursor.readVarUint()).toBe(0);
    expect(cursor.readVarUint()).toBe(2);
    expect(Array.from(cursor.readVarBytes() ?? [])).toEqual([0xaa, 0xbb]);
    expect(cursor.done()).toBe(true);
  });

  it("awareness frame = MSG_AWARENESS, varbytes payload", () => {
    const frame = encodeYjsAwarenessFrame(Uint8Array.from([0x01]));
    expect(Array.from(frame)).toEqual([0x01, 0x01, 0x01]);
  });

  it("empty payload encodes a zero length", () => {
    const frame = encodeYjsSyncFrame(0, new Uint8Array(0));
    expect(Array.from(frame)).toEqual([0x00, 0x00, 0x00]);
  });
});

describe("ByteCursor error handling", () => {
  it("returns null on truncated varint", () => {
    expect(new ByteCursor(Uint8Array.from([0x80])).readVarUint()).toBeNull();
  });

  it("returns null when declared length exceeds the buffer", () => {
    const cursor = new ByteCursor(Uint8Array.from([0x05, 0x01]));
    expect(cursor.readVarBytes()).toBeNull();
  });

  it("done() is false when trailing bytes remain", () => {
    const cursor = new ByteCursor(Uint8Array.from([0x00, 0xff]));
    cursor.readVarUint();
    expect(cursor.done()).toBe(false);
  });
});

describe("base64ToBytes", () => {
  it("decodes standard base64", () => {
    expect(Array.from(base64ToBytes("AAEC"))).toEqual([0, 1, 2]);
  });
});
