"use client";

import { API, authedFetch, request } from "./core";
import type { Asset } from "./types";

export const assetsApi = {
  assetPath: (id: string, assetId: string) => `/api/documents/${id}/assets/${assetId}`,
  assetURL: (id: string, assetId: string) => `${API}/api/documents/${id}/assets/${assetId}`,
  listAssets: (id: string) => request<Asset[]>("GET", `/api/documents/${id}/assets`),
  uploadAsset: async (id: string, file: File): Promise<{ asset: Asset; url: string }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await authedFetch(`/api/documents/${id}/assets`, { method: "POST", body: form });
    return res.json();
  },
  fetchAssetBlobURL: async (id: string, assetId: string): Promise<string> => {
    const res = await authedFetch(`/api/documents/${id}/assets/${assetId}`);
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  },
};
