import type * as Monaco from "monaco-editor";

import type { ResolvedCommentAnchor } from "./commentAnchors";

// The markdown preview is annotated with data-line / data-source-* spans by
// rehypeSourceTextSpans; these helpers map editor offsets onto those spans
// for scroll-sync and comment highlighting.

export function previewElementForLine(container: HTMLElement, line: number) {
  const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-line]"));
  let previous: HTMLElement | null = null;
  for (const el of elements) {
    const sourceLine = Number(el.dataset.line);
    if (!Number.isFinite(sourceLine)) continue;
    if (sourceLine === line) return el;
    if (sourceLine > line) return previous ?? el;
    previous = el;
  }
  return previous;
}

export function scrollPreviewToLine(container: HTMLElement | null, line: number) {
  if (!container) return;
  const target = previewElementForLine(container, line);
  if (!target) return;
  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const top = targetRect.top - containerRect.top + container.scrollTop - container.clientHeight * 0.35;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

export function clearPreviewCommentHighlight(container: HTMLElement | null) {
  if (!container) return;
  for (const el of container.querySelectorAll<HTMLElement>("[data-source-text]")) {
    el.textContent = el.dataset.sourceText ?? "";
  }
}

export function highlightPreviewCommentRange(container: HTMLElement | null, anchor: ResolvedCommentAnchor | null) {
  if (!container || anchor?.from === null || anchor?.from === undefined) return;
  const start = anchor.from;
  const end = anchor.to ?? anchor.from;
  const spans = Array.from(container.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]"));
  let marked = false;
  for (const span of spans) {
    const spanStart = Number(span.dataset.sourceStart);
    const spanEnd = Number(span.dataset.sourceEnd);
    const sourceText = span.dataset.sourceText ?? span.textContent ?? "";
    if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) continue;
    let overlapStart = Math.max(start, spanStart);
    let overlapEnd = Math.min(end, spanEnd);
    if (end <= start) {
      if (!(spanStart <= start && spanEnd > start)) continue;
      overlapStart = start;
      overlapEnd = Math.min(spanEnd, start + 1);
    } else if (!(spanStart < end && spanEnd > start)) {
      continue;
    }
    const localStart = Math.max(0, overlapStart - spanStart);
    const localEnd = Math.max(localStart, Math.min(sourceText.length, overlapEnd - spanStart));
    if (localEnd <= localStart) continue;
    span.replaceChildren();
    if (localStart > 0) span.append(document.createTextNode(sourceText.slice(0, localStart)));
    const mark = document.createElement("span");
    mark.className = "preview-comment-hl";
    mark.textContent = sourceText.slice(localStart, localEnd);
    span.append(mark);
    if (localEnd < sourceText.length) span.append(document.createTextNode(sourceText.slice(localEnd)));
    marked = true;
  }
  if (!marked && anchor.line) {
    previewElementForLine(container, anchor.line)?.classList.add("preview-comment-hl");
  }
}

export function applyCommentHighlight(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco | null,
  collectionRef: React.MutableRefObject<Monaco.editor.IEditorDecorationsCollection | null>,
  anchor: ResolvedCommentAnchor | null,
  scroll: boolean,
) {
  const model = editor.getModel();
  if (!monaco || !model || !collectionRef.current) return;
  if (!anchor?.line) {
    collectionRef.current.set([]);
    return;
  }
  const start = anchor.from ?? model.getOffsetAt({ lineNumber: Math.max(1, anchor.line), column: 1 });
  const end = anchor.to !== null && anchor.to > start ? anchor.to : Math.min(model.getValueLength(), start + 1);
  const startPos = model.getPositionAt(start);
  const endPos = model.getPositionAt(end);
  const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
  collectionRef.current.set([{
    range,
    options: { inlineClassName: "monaco-comment-range-hl" },
  }]);
  if (!scroll) return;
  const layout = editor.getLayoutInfo();
  const targetTop = editor.getTopForLineNumber(startPos.lineNumber) - layout.height / 2;
  smoothScrollEditor(editor, Math.max(0, targetTop));
}

export function smoothScrollEditor(editor: Monaco.editor.IStandaloneCodeEditor, target: number) {
  const start = editor.getScrollTop();
  const distance = target - start;
  if (Math.abs(distance) < 2) {
    editor.setScrollTop(target);
    return;
  }
  const duration = Math.min(700, 250 + Math.abs(distance) * 0.4);
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    editor.setScrollTop(start + distance * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
