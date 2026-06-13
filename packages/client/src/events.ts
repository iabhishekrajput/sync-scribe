import type { DocumentEvent } from "./types";

// parseDocumentEvent decodes one SSE frame ("id: …\nevent: …\ndata: …")
// into a DocumentEvent. Multi-line data fields are joined per the SSE spec.
export function parseDocumentEvent(frame: string): DocumentEvent | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return null;
  return JSON.parse(data) as DocumentEvent;
}
