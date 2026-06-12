"use client";

import type { AttributionQuery, AttributionResponse, DocumentEvent as ActivityEvent } from "@syncscribe/client";

import { getAccessToken } from "./auth";
import { ApiError, parseApiError } from "./errors";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

// Re-export so existing imports of ApiError from "./api" keep working.
export { ApiError };

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, "Sign in to continue.", "unauthenticated");

  const res = await fetch(`${API}${path}`, {
    method,
    credentials: "include",
    headers: {
      "Authorization": `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    throw await parseApiError(res);
  }
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return (await res.text()) as T;
}

export type Document = {
  id: string;
  owner_id: string;
  title: string;
  current_version: number;
  link_default_role: string;
  created_at: string;
  updated_at: string;
};

export type DocumentListParams = {
  q?: string;
  scope?: "all" | "owned" | "shared";
  limit?: number;
};

export type DocumentDetail = {
  document: Document;
  role: "viewer" | "editor" | "owner";
};

export type DocumentAccess = {
  document_id: string;
  user_id: string;
  role: "viewer" | "editor" | "owner";
  granted_by: string;
  granted_at: string;
  email?: string;
  display_name?: string;
};

export type AccessRequest = {
  id: string;
  document_id: string;
  requester_id: string;
  requester_name?: string;
  requester_email?: string;
  requested_role: "viewer" | "editor";
  message?: string;
  status: "pending" | "approved" | "denied" | "canceled";
  resolved_by?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
};

export type Invite = {
  token: string;
  document_id: string;
  email: string;
  role: "viewer" | "editor";
  invited_by: string;
  granted_user_id?: string;
  expires_at: string;
  created_at: string;
};

export type SnapshotSummary = {
  document_id: string;
  version: number;
  update_start_seq: number;
  update_count: number;
  last_seq: number;
  size_bytes: number;
  created_by?: string;
  created_by_name?: string;
  created_at: string;
  actor_breakdown: { user: number; guest?: number };
  preview_text: boolean;
};

export type SnapshotBody = {
  document_id: string;
  version: number;
  body: string;
  can_preview: boolean;
  created_at: string;
};

export type RestoreSnapshotResult = {
  document: Document;
  version: number;
};

export type ShareLink = {
  token: string;
  document_id: string;
  role: "viewer" | "editor";
  created_by: string;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
};

export type PublicShareInfo = {
  token: string;
  document_id: string;
  title: string;
  role: "viewer" | "editor";
  expires_at?: string;
};

export type DocumentComment = {
  id: string;
  document_id: string;
  author_id: string;
  author_name: string;
  kind: "comment" | "suggestion";
  line_number?: number;
  anchor_start?: string;
  anchor_end?: string;
  anchor_text?: string;
  body: string;
  resolved_at?: string;
  resolved_by?: string;
  created_at: string;
};

export type CreateCommentAnchor = {
  line_number?: number;
  anchor_start?: string;
  anchor_end?: string;
  anchor_text?: string;
};

// The SSE/event and attribution shapes are owned by the SDK; re-exported
// here so app code keeps a single import path for API types.
export type { AttributionQuery, AttributionResponse, AttributionUpdate } from "@syncscribe/client";
export type { DocumentEvent as ActivityEvent } from "@syncscribe/client";

export type Asset = {
  id: string;
  document_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};

export const api = {
  listDocuments: (params: DocumentListParams = {}) => {
    const search = new URLSearchParams();
    if (params.q) search.set("q", params.q);
    if (params.scope) search.set("scope", params.scope);
    if (params.limit) search.set("limit", String(params.limit));
    const qs = search.toString();
    return request<Document[]>("GET", `/api/documents${qs ? `?${qs}` : ""}`);
  },
  createDocument: (title?: string, source?: string) =>
    request<Document>("POST", "/api/documents", { title: title ?? "", ...(source ? { source } : {}) }),
  getDocument: (id: string) => request<DocumentDetail>("GET", `/api/documents/${id}`),
  renameDocument: (id: string, title: string) => request<Document>("PATCH", `/api/documents/${id}`, { title }),
  deleteDocument: (id: string) => request<void>("DELETE", `/api/documents/${id}`),
  listAccess: (id: string) => request<DocumentAccess[]>("GET", `/api/documents/${id}/access`),
  upsertAccess: (id: string, userId: string, role: "viewer" | "editor" | "owner") =>
    request<DocumentAccess>("POST", `/api/documents/${id}/access`, { user_id: userId, role }),
  deleteAccess: (id: string, userId: string) =>
    request<void>("DELETE", `/api/documents/${id}/access/${encodeURIComponent(userId)}`),
  listAccessRequests: (id: string) => request<AccessRequest[]>("GET", `/api/documents/${id}/access-requests`),
  requestAccess: (id: string, role: "editor" = "editor", message = "") =>
    request<AccessRequest>("POST", `/api/documents/${id}/access-requests`, { role, message }),
  approveAccessRequest: (id: string, requestId: string) =>
    request<AccessRequest>("POST", `/api/documents/${id}/access-requests/${requestId}/approve`),
  denyAccessRequest: (id: string, requestId: string) =>
    request<AccessRequest>("POST", `/api/documents/${id}/access-requests/${requestId}/deny`),
  listSnapshots: (id: string) => request<SnapshotSummary[]>("GET", `/api/documents/${id}/snapshots`),
  publishSnapshot: async (id: string, content: string): Promise<{ version: number }> => {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, "Sign in to continue.", "unauthenticated");
    const res = await fetch(`${API}/api/documents/${id}/snapshots`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" },
      body: content,
    });
    if (!res.ok) throw await parseApiError(res);
    return res.json();
  },
  getSnapshot: (id: string, version: number) =>
    request<SnapshotBody>("GET", `/api/documents/${id}/snapshots/${version}`),
  restoreSnapshot: (id: string, version: number) =>
    request<RestoreSnapshotResult>("POST", `/api/documents/${id}/snapshots/${version}/restore`),
  exportMarkdownURL: (id: string) => `${API}/api/documents/${id}/export?format=md`,
  documentEventsURL: (id: string, sinceEventId?: number) => {
    const search = new URLSearchParams();
    if (sinceEventId !== undefined) search.set("sinceEventId", String(sinceEventId));
    const qs = search.toString();
    return `${API}/api/documents/${id}/events${qs ? `?${qs}` : ""}`;
  },
  assetPath: (id: string, assetId: string) => `/api/documents/${id}/assets/${assetId}`,
  assetURL: (id: string, assetId: string) => `${API}/api/documents/${id}/assets/${assetId}`,
  listAssets: (id: string) => request<Asset[]>("GET", `/api/documents/${id}/assets`),
  uploadAsset: async (id: string, file: File): Promise<{ asset: Asset; url: string }> => {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, "Sign in to continue.", "unauthenticated");
    const form = new FormData();
    form.append("file", file);
    const res = await fetch(`${API}/api/documents/${id}/assets`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!res.ok) throw await parseApiError(res);
    return res.json();
  },
  fetchAssetBlobURL: async (id: string, assetId: string): Promise<string> => {
    const token = await getAccessToken();
    if (!token) throw new ApiError(401, "Sign in to continue.", "unauthenticated");
    const res = await fetch(`${API}/api/documents/${id}/assets/${assetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw await parseApiError(res);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
  listInvites: (id: string) => request<Invite[]>("GET", `/api/documents/${id}/invites`),
  createInvite: (id: string, email: string, role: "viewer" | "editor") =>
    request<Invite>("POST", `/api/documents/${id}/invites`, { email, role }),
  revokeInvite: (id: string, token: string) =>
    request<void>("DELETE", `/api/documents/${id}/invites/${encodeURIComponent(token)}`),
  resendInvite: (id: string, token: string) =>
    request<Invite>("POST", `/api/documents/${id}/invites/${encodeURIComponent(token)}/resend`),
  claimInvite: (token: string) => request<DocumentDetail>("POST", `/api/invites/${token}/claim`),

  // Share links (M9). Owner-only on create/list/revoke. The public read
  // endpoint at /share/:token is intentionally unauthenticated.
  listShareLinks: (id: string) => request<ShareLink[]>("GET", `/api/documents/${id}/share-links`),
  createShareLink: (id: string, role: "viewer" | "editor", expiresInMs?: number) =>
    request<ShareLink>("POST", `/api/documents/${id}/share-links`, {
      role,
      ...(expiresInMs ? { expires_in_ms: expiresInMs } : {}),
    }),
  revokeShareLink: (id: string, token: string) =>
    request<void>("DELETE", `/api/documents/${id}/share-links/${encodeURIComponent(token)}`),
  publicShareInfo: async (token: string): Promise<PublicShareInfo> => {
    const res = await fetch(`${API}/share/${encodeURIComponent(token)}`);
    if (!res.ok) throw await parseApiError(res);
    return res.json();
  },
  shareAssetURL: (token: string, assetID: string) =>
    `${API}/share/${encodeURIComponent(token)}/assets/${assetID}`,

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
  listActivity: (id: string, limit = 50) =>
    request<ActivityEvent[]>("GET", `/api/documents/${id}/activity?limit=${limit}`),
  getAttribution: (id: string, query: AttributionQuery = {}) => {
    const search = new URLSearchParams();
    if (query.fromItem) search.set("fromItem", query.fromItem);
    if (query.toItem) search.set("toItem", query.toItem);
    if (query.sinceUpdateId !== undefined) search.set("sinceUpdateId", String(query.sinceUpdateId));
    search.set("limit", String(query.limit ?? 500));
    return request<AttributionResponse>("GET", `/api/documents/${id}/attribution?${search.toString()}`);
  },
};
