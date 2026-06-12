"use client";

import type { AttributionQuery, AttributionResponse } from "@syncscribe/client";

import { request } from "./core";
import type { Document, DocumentDetail, DocumentListParams } from "./types";

export const documentsApi = {
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
  getAttribution: (id: string, query: AttributionQuery = {}) => {
    const search = new URLSearchParams();
    if (query.fromItem) search.set("fromItem", query.fromItem);
    if (query.toItem) search.set("toItem", query.toItem);
    if (query.sinceUpdateId !== undefined) search.set("sinceUpdateId", String(query.sinceUpdateId));
    search.set("limit", String(query.limit ?? 500));
    return request<AttributionResponse>("GET", `/api/documents/${id}/attribution?${search.toString()}`);
  },
};
