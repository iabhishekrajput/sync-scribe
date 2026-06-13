"use client";

export type Theme = "light" | "dark" | "system";

const KEY = "ss_theme";

const listeners = new Set<() => void>();

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "system";
  const v = window.localStorage.getItem(KEY);
  if (v === "light" || v === "dark" || v === "system") return v;
  return "system";
}

export function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  const resolved = t === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : t;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.dataset.theme = resolved;
}

export function setTheme(t: Theme) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(KEY, t);
  applyTheme(t);
  for (const l of listeners) l();
}
