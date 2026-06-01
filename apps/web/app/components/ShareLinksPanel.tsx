"use client";

import { useEffect, useState } from "react";
import { api, type ShareLink } from "../lib/api";

type Role = "viewer" | "editor";
type ExpirationOption = "never" | "day" | "week" | "month";

const expirationOptions: { value: ExpirationOption; label: string; ms?: number }[] = [
  { value: "week", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "day", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "month", label: "30 days", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "never", label: "Never" },
];

// Public-read URL the recipient pastes into a browser. Mirrors the route
// registered in app/p/[token]/page.tsx.
function publicURL(token: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return `${origin}/p/${token}`;
}

// Share-link create/list/revoke is owner-only on the server. Render nothing
// for non-owners so we don't surface a misleading 403 in the UI.
export function ShareLinksPanel({ docId, isOwner }: { docId: string; isOwner: boolean }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [role, setRole] = useState<Role>("viewer");
  const [expiration, setExpiration] = useState<ExpirationOption>("week");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const ls = await api.listShareLinks(docId);
        if (alive) setLinks(ls);
      } catch {
        if (alive) setError("Could not load share links.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId, isOwner]);

  if (!isOwner) return null;

  async function onCreate() {
    setCreating(true);
    setError("");
    try {
      const expiresInMs = expirationOptions.find((option) => option.value === expiration)?.ms;
      const link = await api.createShareLink(docId, role, expiresInMs);
      setLinks((prev) => [link, ...prev]);
    } catch {
      setError("Could not create link.");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(token: string) {
    const link = links.find((l) => l.token === token);
    const access = link?.role === "editor" ? "edit" : "view";
    if (!confirm(`Revoke this ${access} link? Anyone using it will lose access immediately.`)) return;
    try {
      await api.revokeShareLink(docId, token);
      setLinks((prev) => prev.filter((l) => l.token !== token));
    } catch {
      setError("Could not revoke link.");
    }
  }

  async function onCopy(token: string) {
    const url = publicURL(token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
    } catch {
      // Older browsers — fall back to selection
      window.prompt("Copy this URL:", url);
    }
  }

  return (
    <div className="mt-5 border-t border-current/10 pt-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Share links</h3>
          <p className="mt-1 text-xs opacity-60">Public links do not require sign-in. Expiring viewer links are the safer default.</p>
        </div>
        <span className="rounded-full bg-current/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
          {links.length} active
        </span>
      </div>

      <div className="mb-3 space-y-2 rounded-lg border border-current/10 p-3">
        <label className="block text-xs font-medium opacity-70">Access</label>
        <div className="grid grid-cols-2 gap-1 rounded-md bg-current/5 p-1">
          {(["viewer", "editor"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`rounded px-2 py-1 text-xs capitalize ${
                role === r ? "bg-white shadow-sm dark:bg-neutral-800" : "opacity-70"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
        {role === "editor" && (
          <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            Editor links let anyone with the URL change this document until the link expires or is revoked.
          </p>
        )}
        <label className="block text-xs font-medium opacity-70">Expiration</label>
        <div className="grid grid-cols-2 gap-1 rounded-md bg-current/5 p-1 sm:grid-cols-4">
          {expirationOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setExpiration(option.value)}
              className={`rounded px-2 py-1 text-xs ${
                expiration === option.value ? "bg-white shadow-sm dark:bg-neutral-800" : "opacity-70"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button
          onClick={onCreate}
          disabled={creating}
          className="w-full rounded-md bg-black px-3 py-1.5 text-xs text-white disabled:opacity-50 dark:bg-white dark:text-black"
        >
          {creating ? "Creating…" : "Create link"}
        </button>
      </div>

      {loading ? (
        <p className="text-xs opacity-60">Loading…</p>
      ) : links.length === 0 ? (
        <p className="text-xs opacity-60">No active links.</p>
      ) : (
        <ul className="space-y-2">
          {links.map((l) => (
            <li
              key={l.token}
              className="flex items-center gap-2 rounded-md border border-current/10 px-2 py-1.5 text-xs"
            >
              <span className="rounded bg-current/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {l.role}
              </span>
              <span className="min-w-0 flex-1">
                <code className="block truncate font-mono opacity-80">{publicURL(l.token)}</code>
                <span className="mt-0.5 block truncate text-[10px] opacity-55">
                  Created {formatLinkDate(l.created_at)} · {linkExpiryText(l)}
                </span>
              </span>
              <button
                onClick={() => onCopy(l.token)}
                className="rounded px-2 py-0.5 hover:bg-current/5"
              >
                {copied === l.token ? "Copied" : "Copy"}
              </button>
              <button
                onClick={() => onRevoke(l.token)}
                className="rounded px-2 py-0.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function formatLinkDate(value: string) {
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function linkExpiryText(link: ShareLink) {
  if (!link.expires_at) return "Never expires";
  const expiry = new Date(link.expires_at);
  const diffMs = expiry.getTime() - Date.now();
  if (diffMs <= 0) return "Expired";
  const diffHours = Math.ceil(diffMs / (60 * 60 * 1000));
  if (diffHours < 48) return `Expires in ${diffHours}h`;
  return `Expires ${formatLinkDate(link.expires_at)}`;
}
