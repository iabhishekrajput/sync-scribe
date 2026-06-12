"use client";

import { parseApiError } from "../errors";
import { API, request } from "./core";
import type { PublicShareInfo, ShareLink } from "./types";

// Share links. Owner-only on create/list/revoke. The public read endpoint at
// /share/:token is intentionally unauthenticated — the token is the secret.
export const shareApi = {
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
};
