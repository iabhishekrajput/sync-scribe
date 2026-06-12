"use client";

import { API, request } from "./core";
import type { ActivityEvent } from "./types";

export const activityApi = {
  listActivity: (id: string, limit = 50) =>
    request<ActivityEvent[]>("GET", `/api/documents/${id}/activity?limit=${limit}`),
  documentEventsURL: (id: string, sinceEventId?: number) => {
    const search = new URLSearchParams();
    if (sinceEventId !== undefined) search.set("sinceEventId", String(sinceEventId));
    const qs = search.toString();
    return `${API}/api/documents/${id}/events${qs ? `?${qs}` : ""}`;
  },
};
