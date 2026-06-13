"use client";

import { API, authedFetch, request } from "./core";
import type { RestoreSnapshotResult, SnapshotBody, SnapshotSummary } from "./types";

export const snapshotsApi = {
  listSnapshots: (id: string) => request<SnapshotSummary[]>("GET", `/api/documents/${id}/snapshots`),
  publishSnapshot: async (id: string, content: string): Promise<{ version: number }> => {
    const res = await authedFetch(`/api/documents/${id}/snapshots`, {
      method: "POST",
      headers: { "Content-Type": "text/markdown" },
      body: content,
    });
    return res.json();
  },
  getSnapshot: (id: string, version: number) =>
    request<SnapshotBody>("GET", `/api/documents/${id}/snapshots/${version}`),
  restoreSnapshot: (id: string, version: number) =>
    request<RestoreSnapshotResult>("POST", `/api/documents/${id}/snapshots/${version}/restore`),
  exportMarkdownURL: (id: string) => `${API}/api/documents/${id}/export?format=md`,
};
