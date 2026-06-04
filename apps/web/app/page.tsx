"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api, type Document } from "./lib/api";
import { fetchMe } from "./lib/auth";
import { notifyError } from "./lib/errors";
import { TopBar } from "./components/TopBar";

type Me = { id: string; email: string; display_name: string };
type DocumentTab = "all" | "owned" | "shared";

export default function Dashboard() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [docs, setDocs] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<DocumentTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [openMenuID, setOpenMenuID] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const m = (await fetchMe()) as Me | null;
      if (!alive) return;
      setMe(m);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedSearchQuery(searchQuery.trim()), 250);
    return () => window.clearTimeout(timeout);
  }, [searchQuery]);

  useEffect(() => {
    if (!me) return;
    let alive = true;
    setDocsLoading(true);
    setLoadFailed(false);
    api
      .listDocuments({ q: debouncedSearchQuery, scope: tab, limit: 50 })
      .then((list) => {
        if (alive) setDocs(list);
      })
      .catch((err) => {
        if (!alive) return;
        setLoadFailed(true);
        notifyError(err, "load-documents");
      })
      .finally(() => {
        if (alive) setDocsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [me, tab, debouncedSearchQuery]);

  useEffect(() => {
    if (!me) return;
    setShowOnboarding(localStorage.getItem("syncscribe.onboarding.dismissed") !== "true");
  }, [me]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-md rounded-lg border border-current/10 p-5">
          <div className="mb-5 flex items-center justify-between">
            <div className="h-6 w-32 rounded-full bg-current/10" />
            <div className="h-8 w-28 rounded-md bg-current/10" />
          </div>
          <div className="space-y-3">
            <div className="h-11 rounded-md bg-current/10" />
            <div className="h-11 rounded-md bg-current/10" />
            <div className="h-11 rounded-md bg-current/10" />
          </div>
          <p className="mt-4 text-sm opacity-60">Loading documents…</p>
        </div>
      </main>
    );
  }

  if (!me) {
    if (typeof window !== "undefined") window.location.replace("/login");
    return null;
  }

  async function onCreate() {
    setCreating(true);
    try {
      const d = await api.createDocument();
      router.push(`/d/${d.id}`);
    } catch (err) {
      notifyError(err, "create-document");
      setCreating(false);
    }
  }

  async function onImportFile(file: File) {
    setCreating(true);
    try {
      const text = await file.text();
      const title = file.name.replace(/\.(md|markdown|txt)$/i, "").slice(0, 200) || "Imported";
      const d = await api.createDocument(title, "import:markdown");
      // Editor seeds the empty Yjs document from this on first live sync.
      sessionStorage.setItem(`syncscribe.import.${d.id}`, text);
      router.push(`/d/${d.id}`);
    } catch (err) {
      notifyError(err, "import-document");
      setCreating(false);
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this document?")) return;
    try {
      await api.deleteDocument(id);
      setDocs((d) => d.filter((x) => x.id !== id));
    } catch (err) {
      notifyError(err, "delete-document");
    } finally {
      setOpenMenuID(null);
    }
  }

  async function onRename(doc: Document) {
    const title = prompt("Rename document", doc.title || "Untitled");
    const next = title?.trim();
    if (!next || next === doc.title) {
      setOpenMenuID(null);
      return;
    }
    try {
      const renamed = await api.renameDocument(doc.id, next);
      setDocs((prev) => prev.map((item) => (item.id === renamed.id ? renamed : item)));
    } catch (err) {
      notifyError(err, "rename-document");
    } finally {
      setOpenMenuID(null);
    }
  }

  function onOpenNewTab(id: string) {
    window.open(`/d/${id}`, "_blank", "noopener,noreferrer");
    setOpenMenuID(null);
  }

  const visibleDocs = docs;

  return (
    <div className="min-h-screen">
      <TopBar me={me} onSignedOut={() => setMe(null)} />
      <main className="px-4 py-8 sm:px-6">
        {showOnboarding && (
          <section className="mx-auto mb-6 max-w-6xl rounded-lg border border-current/10 bg-current/[0.03] p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold">Start with a document</h2>
                <p className="mt-1 text-sm opacity-70">
                  Create a Markdown document, share it by email, and collaborate live from the editor.
                </p>
              </div>
              <button
                onClick={() => {
                  localStorage.setItem("syncscribe.onboarding.dismissed", "true");
                  setShowOnboarding(false);
                }}
                className="rounded-md border border-current/15 px-2 py-1 text-xs hover:bg-current/5"
              >
                Dismiss
              </button>
            </div>
          </section>
        )}
        <div className="mx-auto mb-7 flex max-w-6xl items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Documents</h1>
          <div className="flex items-center gap-2">
            <label
              className={`cursor-pointer rounded-md border border-current/15 px-3 py-2 text-sm font-medium hover:bg-current/5 ${
                creating ? "pointer-events-none opacity-50" : ""
              }`}
            >
              Import .md
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void onImportFile(f);
                }}
              />
            </label>
            <button
              onClick={onCreate}
              disabled={creating}
              className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {creating ? "Creating…" : "New document"}
            </button>
          </div>
        </div>

        <div className="mx-auto mb-5 flex max-w-6xl flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div className="inline-grid grid-cols-3 gap-1 rounded-md bg-current/5 p-1">
            {(["all", "owned", "shared"] as const).map((nextTab) => (
              <button
                key={nextTab}
                onClick={() => setTab(nextTab)}
                className={`rounded px-4 py-2 text-sm font-medium ${
                  tab === nextTab ? "bg-white shadow-sm dark:bg-neutral-900" : "opacity-70"
                }`}
              >
                {tabLabel(nextTab)}
              </button>
            ))}
          </div>
          <label className="relative block w-full md:w-80">
            <span className="sr-only">Search documents</span>
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-current/45"
              fill="none"
              aria-hidden
            >
              <path
                d="m20 20-4.25-4.25M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search documents"
              className="h-11 w-full rounded-md border border-current/15 bg-transparent pl-9 pr-3 text-sm outline-none transition focus:border-current/35 focus:ring-2 focus:ring-current/10"
            />
          </label>
        </div>

        {docsLoading ? (
          <div className="mx-auto max-w-6xl border-y border-current/15 py-8 text-center text-sm opacity-60">
            Searching documents…
          </div>
        ) : visibleDocs.length === 0 ? (
          <div className="mx-auto max-w-6xl rounded-lg border border-dashed border-current/20 p-10 text-center">
            <p className="text-sm opacity-70">
              {loadFailed
                ? "Documents will appear here when loading succeeds."
                : debouncedSearchQuery
                  ? "No documents match your search."
                : tab === "all"
                  ? "No documents yet."
                  : tab === "owned"
                  ? "No documents yet."
                  : "No shared documents yet."}
            </p>
            {(tab === "all" || tab === "owned") && !loadFailed && !debouncedSearchQuery && (
              <button onClick={onCreate} className="mt-3 text-sm underline">
                Create your first one
              </button>
            )}
          </div>
        ) : (
          <div className="mx-auto max-w-6xl">
            <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-4 border-y border-current/15 px-2 py-2 text-xs font-medium uppercase tracking-wide opacity-50 sm:grid-cols-[2.5rem_minmax(0,1fr)_10rem_2.5rem] md:grid-cols-[2.5rem_minmax(0,1fr)_10rem_8rem_2.5rem]">
              <span aria-hidden />
              <span>Name</span>
              <span className="hidden sm:block">Owner</span>
              <span className="hidden md:block">Modified</span>
              <span aria-hidden />
            </div>
            <ul className="divide-y divide-current/15 border-b border-current/15">
              {visibleDocs.map((d) => (
                <li
                  key={d.id}
                  className="grid grid-cols-[2.5rem_minmax(0,1fr)_2.5rem] items-center gap-4 px-2 py-3 hover:bg-current/[0.035] sm:grid-cols-[2.5rem_minmax(0,1fr)_10rem_2.5rem] md:grid-cols-[2.5rem_minmax(0,1fr)_10rem_8rem_2.5rem]"
                >
                  <MarkdownFileIcon />
                  <Link href={`/d/${d.id}`} className="min-w-0 truncate text-sm font-medium hover:underline">
                    {d.title || "Untitled"}
                  </Link>
                  <span className="hidden truncate text-sm opacity-65 sm:block">
                    {d.owner_id === me.id ? "me" : d.owner_id}
                  </span>
                  <span className="hidden text-sm opacity-65 md:block">{formatDocDate(d.updated_at)}</span>
                  <div className="relative flex justify-end">
                    <button
                      onClick={() => setOpenMenuID((current) => (current === d.id ? null : d.id))}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-current/65 hover:bg-current/10 hover:text-current"
                      title="Document actions"
                      aria-label={`Actions for ${d.title || "Untitled"}`}
                    >
                      <span aria-hidden className="text-xl leading-none">⋮</span>
                    </button>
                    {openMenuID === d.id && (
                      <>
                        <button
                          aria-label="Close document actions"
                          className="fixed inset-0 z-10 cursor-default bg-transparent"
                          onClick={() => setOpenMenuID(null)}
                        />
                        <div className="absolute right-0 top-9 z-20 w-44 overflow-hidden rounded-md border border-current/10 bg-white py-1 text-sm shadow-xl dark:bg-neutral-950">
                          <button
                            onClick={() => onOpenNewTab(d.id)}
                            className="block w-full px-3 py-2 text-left hover:bg-current/5"
                          >
                            Open in new tab
                          </button>
                          {d.owner_id === me.id && (
                            <>
                              <button
                                onClick={() => void onRename(d)}
                                className="block w-full px-3 py-2 text-left hover:bg-current/5"
                              >
                                Rename
                              </button>
                              <button
                                onClick={() => void onDelete(d.id)}
                                className="block w-full px-3 py-2 text-left text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>
    </div>
  );
}

function MarkdownFileIcon() {
  return (
    <span className="flex h-7 w-7 items-center justify-center text-current/60">
      <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" fill="none" aria-hidden>
        <path
          d="M14 3.25H7.75A1.75 1.75 0 0 0 6 5v14a1.75 1.75 0 0 0 1.75 1.75h8.5A1.75 1.75 0 0 0 18 19V7.25L14 3.25Z"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
        <path
          d="M14 3.5V7a.75.75 0 0 0 .75.75h3M9 11.25h6M9 14.25h6M9 17.25h3.25"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

function tabLabel(tab: DocumentTab) {
  if (tab === "all") return "All documents";
  if (tab === "owned") return "My Docs";
  return "Shared with me";
}

function formatDocDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}
