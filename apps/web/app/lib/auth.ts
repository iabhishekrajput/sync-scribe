"use client";

const API = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8080";

type Session = {
  accessToken: string;
  expiresAt: number; // epoch ms
};

let session: Session | null = null;
let refreshInFlight: Promise<Session | null> | null = null;

export function loginURL(returnTo = "/"): string {
  const u = new URL(`${API}/auth/login`);
  u.searchParams.set("return_to", returnTo);
  return u.toString();
}

export async function refresh(): Promise<Session | null> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        session = null;
        return null;
      }
      const data = (await res.json()) as { access_token: string; expires_in: number };
      session = {
        accessToken: data.access_token,
        expiresAt: Date.now() + Math.max(0, (data.expires_in - 30) * 1000),
      };
      return session;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

export async function getAccessToken(): Promise<string | null> {
  if (session && Date.now() < session.expiresAt) return session.accessToken;
  const s = await refresh();
  return s?.accessToken ?? null;
}

export type Me = { id: string; email: string; display_name: string };

export async function fetchMe(): Promise<Me | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const res = await fetch(`${API}/api/me`, {
    headers: { Authorization: `Bearer ${token}` },
    credentials: "include",
  });
  if (!res.ok) return null;
  return res.json() as Promise<Me>;
}

export async function signOut(): Promise<void> {
  await fetch(`${API}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
  session = null;
}
