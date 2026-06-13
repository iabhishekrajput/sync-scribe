"use client";

import { request } from "./core";
import type { CreateCommentAnchor, DocumentComment } from "./types";

export const commentsApi = {
  listComments: (id: string, includeResolved = false) =>
    request<DocumentComment[]>("GET", `/api/documents/${id}/comments${includeResolved ? "?include_resolved=true" : ""}`),
  createComment: (id: string, kind: "comment" | "suggestion", body: string, anchor?: CreateCommentAnchor) =>
    request<DocumentComment>("POST", `/api/documents/${id}/comments`, {
      kind,
      body,
      ...(anchor?.line_number ? { line_number: anchor.line_number } : {}),
      ...(anchor?.anchor_start ? { anchor_start: anchor.anchor_start } : {}),
      ...(anchor?.anchor_end ? { anchor_end: anchor.anchor_end } : {}),
      ...(anchor?.anchor_text ? { anchor_text: anchor.anchor_text } : {}),
    }),
  resolveComment: (id: string, commentId: string) =>
    request<DocumentComment>("POST", `/api/documents/${id}/comments/${commentId}/resolve`),
  deleteComment: (id: string, commentId: string) =>
    request<void>("DELETE", `/api/documents/${id}/comments/${commentId}`),
};
