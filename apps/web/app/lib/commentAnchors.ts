import * as Y from "yjs";
import type * as Monaco from "monaco-editor";

import type { CreateCommentAnchor, DocumentComment } from "./api";

export type CommentAnchorDraft = CreateCommentAnchor & {
  from: number;
  to: number;
  line: number;
};

export type ResolvedCommentAnchor = {
  from: number | null;
  to: number | null;
  line: number | null;
};

const COMMENT_SNIPPET_MAX_CHARS = 160;

export function encodeBase64(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function decodeBase64(raw: string) {
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function compactCommentSnippet(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= COMMENT_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, COMMENT_SNIPPET_MAX_CHARS - 1)}…`;
}

// Comment anchors are Yjs relative positions, so they survive concurrent
// edits: the anchor follows the text it was attached to, not a raw offset.
export function buildCommentAnchorDraft(
  editor: Monaco.editor.IStandaloneCodeEditor,
  ytext: Y.Text,
  clickedPos: number | null,
): CommentAnchorDraft {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    const fallback = clickedPos ?? 0;
    return {
      from: fallback,
      to: fallback,
      line: 1,
      line_number: 1,
      anchor_start: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, fallback))),
      anchor_end: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, fallback))),
      anchor_text: "",
    };
  }
  const selectionFrom = model.getOffsetAt(selection.getStartPosition());
  const selectionTo = model.getOffsetAt(selection.getEndPosition());
  const anchorPos = clickedPos ?? selectionFrom;
  const useSelection = !selection.isEmpty() && anchorPos >= selectionFrom && anchorPos <= selectionTo;
  const from = useSelection ? selectionFrom : anchorPos;
  const to = useSelection ? selectionTo : anchorPos;
  const line = model.getPositionAt(from).lineNumber;
  return {
    from,
    to,
    line,
    line_number: line,
    anchor_start: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from))),
    anchor_end: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to))),
    anchor_text: from === to ? "" : compactCommentSnippet(model.getValueInRange({
      startLineNumber: model.getPositionAt(from).lineNumber,
      startColumn: model.getPositionAt(from).column,
      endLineNumber: model.getPositionAt(to).lineNumber,
      endColumn: model.getPositionAt(to).column,
    })),
  };
}

export function resolveRelativeIndex(ydoc: Y.Doc, ytext: Y.Text, encoded?: string) {
  if (!encoded) return null;
  try {
    const pos = Y.decodeRelativePosition(decodeBase64(encoded));
    const absolute = Y.createAbsolutePositionFromRelativePosition(pos, ydoc);
    if (!absolute || absolute.type !== ytext) return null;
    return absolute.index;
  } catch {
    return null;
  }
}

export function resolveCommentAnchor(comment: DocumentComment, ydoc: Y.Doc, ytext: Y.Text) {
  const from = resolveRelativeIndex(ydoc, ytext, comment.anchor_start);
  const to = resolveRelativeIndex(ydoc, ytext, comment.anchor_end);
  if (from !== null && to !== null) {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return {
      from: start,
      to: end,
      line: ytext.toString().slice(0, start).split("\n").length,
    } satisfies ResolvedCommentAnchor;
  }
  return {
    from: null,
    to: null,
    line: comment.line_number ?? null,
  } satisfies ResolvedCommentAnchor;
}
