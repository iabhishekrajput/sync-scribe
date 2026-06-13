import * as Y from "yjs";

import { base64ToBytes } from "./codec";
import { colorForUser } from "./colors";
import type { AttributionSpan, AttributionUpdate, BlameMark } from "./types";

// computeBlame replays the attribution update log through a fresh Y.Doc and
// records, per character, which update (and therefore which user) inserted
// it. Deletions drop their marks; CRDT merge order is what the live doc saw.
export function computeBlame(updates: AttributionUpdate[]): Array<BlameMark | null> {
  const blameDoc = new Y.Doc();
  const blameText = blameDoc.getText("content");
  let blame: Array<BlameMark | null> = [];

  for (const update of updates) {
    const mark: BlameMark = {
      userId: update.origin_user || "guest",
      name: update.origin_name || (update.origin_user ? "Unknown user" : "Guest"),
      color: colorForUser(update.origin_user || "guest").color,
      seq: update.seq,
      createdAt: update.created_at,
    };
    const observer = (event: Y.YTextEvent) => {
      let oldIdx = 0;
      const next: Array<BlameMark | null> = [];
      for (const delta of event.delta) {
        if ("retain" in delta) {
          for (let i = 0; i < (delta.retain as number); i++) next.push(blame[oldIdx++] ?? null);
        } else if ("insert" in delta) {
          const text = typeof delta.insert === "string" ? delta.insert : "";
          for (let i = 0; i < text.length; i++) next.push(mark);
        } else if ("delete" in delta) {
          oldIdx += delta.delete as number;
        }
      }
      while (oldIdx < blame.length) next.push(blame[oldIdx++] ?? null);
      blame = next;
    };
    blameText.observe(observer);
    Y.applyUpdate(blameDoc, base64ToBytes(update.blob));
    blameText.unobserve(observer);
  }

  blameDoc.destroy();
  return blame;
}

export function compressBlame(blame: Array<BlameMark | null>): AttributionSpan[] {
  const spans: AttributionSpan[] = [];
  let start = -1;
  let current: BlameMark | null = null;

  for (let i = 0; i <= blame.length; i++) {
    const next = i < blame.length ? blame[i] : null;
    const same =
      current &&
      next &&
      current.userId === next.userId &&
      current.seq === next.seq &&
      current.createdAt === next.createdAt;
    if (current && !same) {
      spans.push({ start, end: i, mark: current });
      current = null;
      start = -1;
    }
    if (!current && next) {
      current = next;
      start = i;
    }
  }

  return spans;
}
