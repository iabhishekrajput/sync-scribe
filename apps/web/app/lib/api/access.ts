"use client";

import { request } from "./core";
import type { AccessRequest, DocumentAccess, DocumentDetail, Invite } from "./types";

export const accessApi = {
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
  listInvites: (id: string) => request<Invite[]>("GET", `/api/documents/${id}/invites`),
  createInvite: (id: string, email: string, role: "viewer" | "editor") =>
    request<Invite>("POST", `/api/documents/${id}/invites`, { email, role }),
  revokeInvite: (id: string, token: string) =>
    request<void>("DELETE", `/api/documents/${id}/invites/${encodeURIComponent(token)}`),
  resendInvite: (id: string, token: string) =>
    request<Invite>("POST", `/api/documents/${id}/invites/${encodeURIComponent(token)}/resend`),
  claimInvite: (token: string) => request<DocumentDetail>("POST", `/api/invites/${token}/claim`),
};
