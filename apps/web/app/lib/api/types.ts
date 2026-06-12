// Domain types for the SyncScribe REST API. The SSE/event and attribution
// shapes are owned by the SDK and re-exported so app code keeps a single
// import path.
export type { AttributionQuery, AttributionResponse, AttributionUpdate } from "@syncscribe/client";
export type { DocumentEvent as ActivityEvent } from "@syncscribe/client";

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

export type Asset = {
  id: string;
  document_id: string;
  uploaded_by: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
};
