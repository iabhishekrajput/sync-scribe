import { describe, expect, it } from "vitest";

import { parseDocumentEvent } from "../events";
import { colorForUser } from "../colors";

describe("parseDocumentEvent", () => {
  it("parses an SSE frame", () => {
    const event = parseDocumentEvent(
      'id: 7\nevent: comment.created\ndata: {"id":7,"document_id":"d","actor_label":"A","event_type":"comment.created","detail":{},"created_at":"2026-01-01"}',
    );
    expect(event).toMatchObject({ id: 7, event_type: "comment.created" });
  });

  it("joins multi-line data fields", () => {
    const event = parseDocumentEvent('data: {"id":1,\ndata: "document_id":"d","actor_label":"","event_type":"x","detail":{},"created_at":""}');
    expect(event?.id).toBe(1);
  });

  it("returns null for keep-alive frames", () => {
    expect(parseDocumentEvent("")).toBeNull();
    expect(parseDocumentEvent(": ping")).toBeNull();
  });
});

describe("colorForUser", () => {
  it("is deterministic and returns paired shades", () => {
    const a = colorForUser("user-1");
    expect(colorForUser("user-1")).toEqual(a);
    expect(a.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(a.light).toMatch(/^#[0-9a-f]{6}$/);
  });
});
