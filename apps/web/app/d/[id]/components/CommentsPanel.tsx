"use client";

import React from "react";

import type { DocumentComment } from "../../../lib/api";
import type { CommentAnchorDraft } from "../../../lib/commentAnchors";
import { MessageSquareIcon } from "../../../components/icons";

export function CommentsPanel({
  panelRef,
  comments,
  error,
  selectedCommentId,
  onClose,
  onResolve,
  onDelete,
  onSelect,
}: {
  panelRef: React.RefObject<HTMLElement | null>;
  comments: DocumentComment[];
  error: string;
  selectedCommentId: string | null;
  onClose: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string, label: string) => void;
  onSelect: (id: string) => void;
}) {
  const open = comments.filter((c) => !c.resolved_at);
  const resolved = comments.filter((c) => !!c.resolved_at);

  return (
    <aside ref={panelRef} data-comment-panel className="no-print flex w-72 shrink-0 flex-col border-l border-current/10 bg-white dark:bg-neutral-950 xl:w-80">
      <div className="flex shrink-0 items-center justify-between border-b border-current/10 px-4 py-3">
        <h2 className="text-sm font-semibold">Comments</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-current/50 hover:bg-current/10 hover:text-current"
          aria-label="Close comments"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {error && (
        <p className="mx-3 mt-2 shrink-0 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">{error}</p>
      )}

      {comments.length === 0 && !error && (
        <div className="flex flex-1 items-center justify-center">
          <div className="py-8 text-center">
            <p className="text-sm opacity-50">No comments yet.</p>
            <p className="mt-1 text-xs opacity-40">Right-click in the editor to add one.</p>
          </div>
        </div>
      )}

      {open.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="space-y-3">
            {open.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selected={selectedCommentId === c.id}
                onSelect={() => onSelect(c.id)}
                onResolve={onResolve}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="shrink-0 overflow-y-auto border-t border-current/10" style={{ maxHeight: "40%" }}>
          <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide opacity-40">Resolved</p>
          <div className="space-y-2 px-3 pb-3">
            {resolved.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selected={selectedCommentId === c.id}
                onSelect={() => onSelect(c.id)}
                onResolve={onResolve}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function CommentCard({
  comment,
  selected,
  onSelect,
  onResolve,
  onDelete,
}: {
  comment: DocumentComment;
  selected: boolean;
  onSelect: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string, label: string) => void;
}) {
  const initials = (comment.author_name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const anchorLabel = comment.anchor_text || (comment.line_number ? `line ${comment.line_number}` : "");
  const deleteLabel = comment.anchor_text ? `"${comment.anchor_text}"` : comment.body;

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-all cursor-pointer ${
        selected
          ? "border-indigo-400 bg-indigo-50/60 shadow-sm dark:border-indigo-600 dark:bg-indigo-950/30"
          : "border-current/10 hover:border-current/20"
      } ${comment.resolved_at ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium leading-tight">{comment.author_name}</span>
            {anchorLabel && (
              <span className="rounded bg-current/8 px-1.5 py-0.5 text-[10px] font-mono opacity-70">
                {comment.anchor_text ? `"${comment.anchor_text}"` : anchorLabel}
              </span>
            )}
            {comment.kind === "suggestion" && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                suggestion
              </span>
            )}
          </div>
          <p className="text-[11px] opacity-50 leading-tight mt-0.5">
            {new Date(comment.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{comment.body}</p>
      <div className="mt-2 flex items-center gap-2">
        {!comment.resolved_at ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            Resolve
          </button>
        ) : (
          <p className="flex items-center gap-1 text-xs opacity-40">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            Resolved
          </p>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(comment.id, deleteLabel);
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
          Delete
        </button>
      </div>
    </div>
  );
}

export function EditorContextMenu({
  x,
  y,
  onAddComment,
  onAddSuggestion,
  onInsertImage,
  canInsertImage,
  onClose: _onClose,
}: {
  x: number;
  y: number;
  onAddComment: () => void;
  onAddSuggestion: () => void;
  onInsertImage: () => void;
  canInsertImage: boolean;
  onClose: () => void;
}) {
  // Clamp to viewport so menu never clips off screen.
  const menuW = 192;
  const menuH = 120;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      className="fixed z-50 min-w-48 overflow-hidden rounded-lg border border-current/10 bg-white py-1 shadow-lg dark:bg-neutral-900"
      style={{ left, top }}
    >
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5"
        onClick={onAddComment}
      >
        <MessageSquareIcon className="h-4 w-4 opacity-60" />
        Add comment
      </button>
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5"
        onClick={onAddSuggestion}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 opacity-60" aria-hidden>
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        Suggest edit
      </button>
      <div className="my-1 border-t border-current/10" />
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onInsertImage}
        disabled={!canInsertImage}
        title={canInsertImage ? "" : "You don't have edit access on this document"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 opacity-60" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        Insert image…
      </button>
    </div>
  );
}

export function CommentInputPopup({
  x,
  y,
  anchor,
  kind,
  body,
  submitting,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  x: number;
  y: number;
  anchor: CommentAnchorDraft;
  kind: "comment" | "suggestion";
  body: string;
  submitting: boolean;
  error: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const popupW = 304;
  const popupH = 160;
  const left = Math.min(x + 8, window.innerWidth - popupW - 8);
  const top = Math.min(y, window.innerHeight - popupH - 8);
  const anchorLabel = anchor.anchor_text || `line ${anchor.line}`;

  return (
    <div
      className="fixed z-50 w-76 rounded-xl border border-current/10 bg-white p-3 shadow-xl dark:bg-neutral-900"
      style={{ left, top, width: popupW }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium capitalize opacity-70">{kind}</span>
        <span className="rounded bg-current/8 px-1.5 py-0.5 font-mono text-[10px] opacity-60">
          {anchorLabel}
        </span>
        {anchor.anchor_text && (
          <span className="rounded bg-current/8 px-1.5 py-0.5 font-mono text-[10px] opacity-60">
            selection
          </span>
        )}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (body.trim()) onSubmit(); }
          if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder={kind === "suggestion" ? "Describe your suggested change…" : "Add a comment…"}
        className="w-full resize-none rounded-lg border border-current/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!body.trim() || submitting}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : kind === "suggestion" ? "Add suggestion" : "Comment"}
        </button>
      </div>
    </div>
  );
}
