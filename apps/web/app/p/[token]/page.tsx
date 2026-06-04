"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { PanelGroup, Panel, PanelResizeHandle } from "react-resizable-panels";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { api, type PublicShareInfo } from "../../lib/api";
import { ApiError, notifyError } from "../../lib/errors";
import { ThemeToggle } from "../../components/ThemeToggle";
import { SyncProvider, type ConnectionState, type SaveState } from "../../lib/yjs";
import { TypingPill } from "../../components/TypingPill";
import { makeTypingStamper } from "../../lib/typing";
import dynamic from "next/dynamic";
const YjsMonacoEditor = dynamic(
  () => import("../../components/YjsMonacoEditor").then((m) => m.YjsMonacoEditor),
  { ssr: false },
);

// Stable anonymous identity per browser session. Picked once per tab so the
// same guest doesn't appear as a different color on every reconnect.
const GUEST_PALETTE = [
  { name: "Amber",  color: "#f59e0b", light: "#fef3c7" },
  { name: "Teal",   color: "#0d9488", light: "#ccfbf1" },
  { name: "Rose",   color: "#e11d48", light: "#ffe4e6" },
  { name: "Violet", color: "#7c3aed", light: "#ede9fe" },
  { name: "Lime",   color: "#65a30d", light: "#ecfccb" },
  { name: "Cyan",   color: "#0891b2", light: "#cffafe" },
];

function pickGuestIdentity() {
  const idx = Math.floor(Math.random() * GUEST_PALETTE.length);
  return { ...GUEST_PALETTE[idx], guestId: crypto.randomUUID().slice(0, 8) };
}

export default function PublicSharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);

  const [info, setInfo] = useState<PublicShareInfo | null>(null);
  const [loadError, setLoadError] = useState("");
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [serverSaveState, setServerSaveState] = useState<SaveState>("saving");
  const [previewText, setPreviewText] = useState("");

  const ydocRef = useRef<Y.Doc | null>(null);
  const awarenessRef = useRef<Awareness | null>(null);
  const providerRef = useRef<SyncProvider | null>(null);
  const isDark = useDarkClass();

  if (!ydocRef.current) {
    ydocRef.current = new Y.Doc();
    awarenessRef.current = new Awareness(ydocRef.current);
  }
  const ydoc = ydocRef.current;
  const awareness = awarenessRef.current!;
  const ytext = useMemo(() => ydoc.getText("content"), [ydoc]);

  useEffect(() => {
    let alive = true;
    let stopStamping: (() => void) | undefined;
    (async () => {
      try {
        const i = await api.publicShareInfo(token);
        if (!alive) return;
        setInfo(i);

        const identity = pickGuestIdentity();
        // Anonymized awareness: name is "Guest <Color>", no email, no user
        // ID. The server doesn't strip identifying fields for guests in M9
        // — we trust this code path. Hardening (server-side filter on
        // ActorGuest awareness frames) is M10+.
        awareness.setLocalStateField("user", {
          name: `Guest ${identity.name}`,
          color: identity.color,
          colorLight: identity.light,
          actor: "guest",
        });

        stopStamping = makeTypingStamper(awareness, ydoc);

        providerRef.current = new SyncProvider({
          docId: i.document_id,
          doc: ydoc,
          awareness,
          shareToken: token,
          onState: setConnState,
          onSaveState: setServerSaveState,
          onDisconnectReason: (reason, level) => {
            if (level === "error") notifyError(new ApiError(0, reason), "ws-close");
            else toast.info(reason);
          },
        });
      } catch (err) {
        if (!alive) return;
        notifyError(err, "share-info");
        setLoadError("This share link is invalid, revoked, or expired.");
      }
    })();
    return () => {
      alive = false;
      stopStamping?.();
      providerRef.current?.destroy();
      providerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    const observer = () => setPreviewText(ytext.toString());
    ytext.observe(observer);
    setPreviewText(ytext.toString());
    return () => ytext.unobserve(observer);
  }, [ytext]);

  const isViewer = info?.role === "viewer";

  if (loadError) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-lg font-semibold">Link unavailable</h1>
        <p className="max-w-sm text-sm opacity-70">{loadError}</p>
      </main>
    );
  }

  if (!info) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm opacity-60">
        Loading…
      </main>
    );
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b border-current/10 px-4 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-semibold">SyncScribe</span>
          <span className="truncate text-sm opacity-70">{info.title || "Untitled"}</span>
          <span className="rounded-md bg-current/10 px-2 py-0.5 text-[10px] uppercase tracking-wide">
            {info.role} · public link
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isViewer && <ServerSavePill state={serverSaveState} />}
          <ConnPill state={connState} />
          <ThemeToggle />
        </div>
      </header>

      <PanelGroup direction="horizontal" className="flex-1">
        <Panel defaultSize={60} minSize={20}>
          <div className="h-full">
            <YjsMonacoEditor
              docPath={`public-${info.document_id}.md`}
              ytext={ytext}
              awareness={awareness}
              dark={isDark}
              readOnly={isViewer}
              lineNumbers="off"
            />
          </div>
        </Panel>
        <PanelResizeHandle className="w-1 bg-current/10 transition-colors hover:bg-current/20" />
        <Panel defaultSize={40} minSize={15}>
          <div className="md-preview h-full overflow-auto p-6">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {previewText || "_(empty document)_"}
            </ReactMarkdown>
          </div>
        </Panel>
      </PanelGroup>

      <footer className="flex items-center justify-between border-t border-current/10 px-2 py-1">
        <TypingPill awareness={awareness} />
        <span className="px-2 text-[10px] opacity-50">
          Connected as Guest. Your identity is anonymized to others on this link.
        </span>
      </footer>
    </div>
  );
}

function ConnPill({ state }: { state: ConnectionState }) {
  const map = {
    connecting: { text: "Connecting…", className: "opacity-60" },
    syncing:    { text: "Syncing…",    className: "opacity-70" },
    live:       { text: "● Live",      className: "text-emerald-600 dark:text-emerald-400" },
    readonly:   { text: "Read-only",   className: "text-blue-600 dark:text-blue-400" },
    offline:    { text: "Offline",     className: "text-amber-600 dark:text-amber-400" },
  } as const;
  const s = map[state];
  return <span className={`text-xs ${s.className}`}>{s.text}</span>;
}

function ServerSavePill({ state }: { state: SaveState }) {
  const map = {
    saving: { text: "Saving", className: "text-neutral-600 dark:text-neutral-300" },
    saved: { text: "Saved", className: "text-emerald-600 dark:text-emerald-400" },
    offline: { text: "Offline", className: "text-amber-600 dark:text-amber-400" },
  } as const;
  const s = map[state];
  return <span className={`hidden text-xs sm:inline ${s.className}`}>{s.text}</span>;
}

function useDarkClass() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    setDark(document.documentElement.classList.contains("dark"));
    return () => obs.disconnect();
  }, []);
  return dark;
}
