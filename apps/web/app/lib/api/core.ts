"use client";

import { getAccessToken } from "../auth";
import { ApiError, parseApiError } from "../errors";

export const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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

// authedFetch is for endpoints that don't speak JSON request bodies
// (raw markdown snapshots, multipart uploads, blob downloads).
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  if (!token) throw new ApiError(401, "Sign in to continue.", "unauthenticated");
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(`${API}${path}`, { ...init, credentials: "include", headers });
  if (!res.ok) throw await parseApiError(res);
  return res;
}
