"use client";

import React, { useEffect, useEffectEvent, useMemo, useRef, useState, use } from "react";
import { useRouter } from "next/navigation";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type * as Monaco from "monaco-editor";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import dynamic from "next/dynamic";
import { computeBlame } from "@syncscribe/client";

import {
  markdownComponents,
  rehypeSourceTextSpans,
  useDarkClass,
} from "../../lib/markdown";
import {
  api,
  type AttributionUpdate,
  type Document,
  type DocumentComment,
} from "../../lib/api";
import { fetchMe, type Me } from "../../lib/auth";
import { colorForUser } from "../../lib/avatar";
import {
  buildCommentAnchorDraft,
  resolveCommentAnchor,
  type CommentAnchorDraft,
} from "../../lib/commentAnchors";
import {
  collectPresencePeers,
  samePeerList,
  type PresencePeer,
} from "../../lib/presence";
import {
  applyCommentHighlight,
  clearPreviewCommentHighlight,
  highlightPreviewCommentRange,
  scrollPreviewToLine,
} from "../../lib/previewHighlight";
import { ApiError, notifyError } from "../../lib/errors";
import { SyncProvider, type ConnectionState, type SaveState } from "../../lib/yjs";
import { makeTypingStamper } from "../../lib/typing";
import { TopBar } from "../../components/TopBar";
import { TypingPill } from "../../components/TypingPill";
import { Modal } from "../../components/Modal";
import {
  BlameIcon,
  CloudUpIcon,
  DownloadIcon,
  GripVerticalIcon,
  HistoryIcon,
  MessageSquareIcon,
  PrinterIcon,
  ShareIcon,
  SpinnerIcon,
} from "../../components/icons";
import { CommentsPanel, CommentInputPopup, EditorContextMenu } from "./components/CommentsPanel";
import { DocumentSidebar } from "./components/DocumentSidebar";
import { AuthedImg, uploadAndInsertImagesMonaco } from "./components/EditorAssets";
import { ExportModal } from "./components/ExportModal";
import { HistoryModal } from "./components/HistoryPanel";
import { OffScreenCursorIndicators, PresenceDock } from "./components/PresenceDock";
import { ShareModal } from "./components/ShareModal";
import {
  IconBtn,
  MobileActionsMenu,
  publishIconClass,
  ServerSaveStatus,
  type PublishState,
} from "./components/TopBarActions";

const YjsMonacoEditor = dynamic(
  () => import("../../components/YjsMonacoEditor").then((m) => m.YjsMonacoEditor),
  { ssr: false },
);

type AccessRole = "viewer" | "editor" | "owner";
type CommentDeleteTarget = {
  id: string;
  label: string;
};

const DOCUMENT_TITLE_MAX_CHARS = 80;

type BlameInfo = {
  user: string;
  name: string;
  color: string;
  seq: number;
  createdAt: string;
};
type BlameMap = (BlameInfo | null)[];

// Blame replay comes from the SDK; guests keep their neutral gray here so
// anonymous edits don't masquerade as a palette identity.
function buildBlameMap(updates: AttributionUpdate[]): BlameMap {
  return computeBlame(updates).map((mark) => {
    if (!mark) return null;
    const guest = mark.userId === "guest";
    return {
      user: guest ? "" : mark.userId,
      name: guest ? "Guest" : mark.name,
      color: guest ? "#737373" : mark.color,
      seq: mark.seq,
      createdAt: mark.createdAt,
    };
  });
}

function blameColorToken(color: string) {
  const token = color.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "neutral";
}

function limitDocumentTitle(title: string) {
  return title.slice(0, DOCUMENT_TITLE_MAX_CHARS);
}

function localDraftKey(docID: string) {
  return `syncscribe:draft:${docID}`;
}

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [title, setTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [ownerID, setOwnerID] = useState("");
  const [documentRole, setDocumentRole] = useState<AccessRole>("viewer");
  const [docs, setDocs] = useState<Document[]>([]);
  const [docsLoadFailed, setDocsLoadFailed] = useState(false);
  const [docsSidebarCollapsed, setDocsSidebarCollapsed] = useState(true);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [connState, setConnState] = useState<ConnectionState>("connecting");
  const [serverSaveState, setServerSaveState] = useState<SaveState>("saving");
  const [shareOpen, setShareOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [publishState, setPublishState] = useState<PublishState>("idle");
  const [presencePeers, setPresencePeers] = useState<PresencePeer[]>([]);
  const [presenceDockOpen, setPresenceDockOpen] = useState(true);
  const [blameActive, setBlameActive] = useState(false);
  const [blameLoading, setBlameLoading] = useState(false);
  const [blameMap, setBlameMap] = useState<BlameMap | null>(null);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; line: number; anchor: CommentAnchorDraft } | null>(null);
  const [commentPopup, setCommentPopup] = useState<{ x: number; y: number; kind: "comment" | "suggestion"; anchor: CommentAnchorDraft } | null>(null);
  const [commentSubmitting, setCommentSubmitting] = useState(false);
  const [selectedCommentId, setSelectedCommentId] = useState<string | null>(null);
  const [pendingCommentDelete, setPendingCommentDelete] = useState<CommentDeleteTarget | null>(null);
  const [mobileTab, setMobileTab] = useState<"editor" | "preview">("editor");
  const [aboveCursors, setAboveCursors] = useState<PresencePeer[]>([]);
  const [belowCursors, setBelowCursors] = useState<PresencePeer[]>([]);
  const [editorReady, setEditorReady] = useState(false);
  const [draggingAsset, setDraggingAsset] = useState(false);
  const isOwner = !!me && me.id === ownerID;
  const [{ ydoc, awareness }] = useState(() => {
    const doc = new Y.Doc();
    return { ydoc: doc, awareness: new Awareness(doc) };
  });
  const ytext = ydoc.getText("content");

  const providerRef = useRef<SyncProvider | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const commentDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameDecorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const blameHoverProviderRef = useRef<Monaco.IDisposable | null>(null);
  const blameMapRef = useRef<BlameMap | null>(null);
  const blameActiveRef = useRef(false);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const commentsPanelRef = useRef<HTMLElement | null>(null);
  const insertImageInputRef = useRef<HTMLInputElement | null>(null);
  const insertImageOffsetRef = useRef<number | null>(null);
  const isDark = useDarkClass();

  // Initial fetch: doc metadata + start the WS provider.
  useEffect(() => {
    let alive = true;
    (async () => {
      const m = await fetchMe();
      if (!alive) return;
      setMe(m);
      if (!m) {
        setLoading(false);
        return;
      }
      try {
        const d = await api.getDocument(id);
        if (!alive) return;
        setTitle(limitDocumentTitle(d.document.title));
        setTitleDraft(limitDocumentTitle(d.document.title));
        setOwnerID(d.document.owner_id);
        setDocumentRole(d.role);
        try {
          const list = await api.listDocuments();
          if (alive) setDocs(list);
        } catch (err) {
          if (alive) {
            setDocsLoadFailed(true);
            notifyError(err, "load-documents-sidebar");
          }
        }
        const color = colorForUser(m.id);
        const displayName = m.display_name || m.email;
        awareness.setLocalStateField("user", {
          name: displayName,
          color: color.color,
          colorLight: color.light,
          actor: "human",
        });

        providerRef.current = new SyncProvider({
          docId: id,
          doc: ydoc,
          awareness,
          onState: (s) => setConnState(s),
          onSaveState: setServerSaveState,
          onDisconnectReason: (reason, level) => {
            if (level === "error") notifyError(new ApiError(0, reason), "ws-close");
            else toast.info(reason);
          },
        });

        // Pre-fetch comments so the topbar badge is populated on load.
        try {
          const comms = await api.listComments(id, true);
          if (alive) setComments(comms);
        } catch { /* badge gracefully stays at 0 */ }
      } catch (err) {
        if (alive) {
          setNotFound(true);
          setLoadError("The document could not be loaded, or you no longer have access.");
          notifyError(err, "load-document");
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      providerRef.current?.destroy();
      providerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Mirror Y.Text into a React state so the preview re-renders on edits.
  const [previewText, setPreviewText] = useState(() => ytext.toString());
  useEffect(() => {
    const observer = () => setPreviewText(ytext.toString());
    ytext.observe(observer);
    return () => ytext.unobserve(observer);
  }, [setPreviewText, ytext]);

  // M9: bump awareness.user.typingAt on local edits so peers see a typing
  // pill. Throttled inside makeTypingStamper to ~one awareness frame per
  // 250ms regardless of keystroke rate.
  useEffect(() => {
    if (!me) return;
    return makeTypingStamper(awareness, ydoc);
  }, [awareness, ydoc, me]);

  useEffect(() => {
    const recompute = () => setPresencePeers((prev) => collectPresencePeers(awareness, prev));
    awareness.on("change", recompute);
    recompute();
    const timer = setInterval(recompute, 1000);
    return () => {
      awareness.off("change", recompute);
      clearInterval(timer);
    };
  }, [awareness]);

  useEffect(() => {
    blameMapRef.current = blameMap;
    blameActiveRef.current = blameActive;
  }, [blameActive, blameMap]);

  useEffect(() => {
    return () => {
      blameHoverProviderRef.current?.dispose();
      commentDecorationsRef.current?.clear();
      blameDecorationsRef.current?.clear();
    };
  }, []);

  // Track which peers' cursors are outside the visible editor viewport so we
  // can render off-screen indicators at the top/bottom edges. Recomputed on
  // both awareness change AND editor scroll/layout — without the scroll hook
  // the bar gets stuck pointing the wrong way after the user scrolls.
  useEffect(() => {
    if (!editorReady) return;
    const editor = editorRef.current;
    if (!editor) return;
    const compute = () => {
      const model = editor.getModel();
      if (!model) return;
      const above: PresencePeer[] = [];
      const below: PresencePeer[] = [];
      const scrollTop = editor.getScrollTop();
      const height = editor.getLayoutInfo().height;
      const lineHeight = editor.getOption(monacoRef.current!.editor.EditorOption.lineHeight);
      const threshold = Math.max(8, lineHeight / 2);

      awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.clientID) return;
        const selectionState = state.selection as
          | { anchor: Y.RelativePosition; head: Y.RelativePosition }
          | undefined;
        if (!selectionState) return;
        try {
          const anchorAbs = Y.createAbsolutePositionFromRelativePosition(
            selectionState.anchor,
            ydoc,
          );
          const headAbs = Y.createAbsolutePositionFromRelativePosition(
            selectionState.head,
            ydoc,
          );
          const pos = Math.min(anchorAbs?.index ?? 0, headAbs?.index ?? 0);
          const position = model.getPositionAt(pos);
          const top = editor.getTopForPosition(position.lineNumber, position.column);
          const userState = state.user as
            | { name?: string; color?: string; actor?: string }
            | undefined;
          if (!userState) return;
          const peer: PresencePeer = {
            clientID,
            name: userState.name || "Someone",
            color: userState.color || "#737373",
            actor: userState.actor || "human",
            connected: true,
            lastSeen: Date.now(),
          };
          const bottom = top + lineHeight;
          if (bottom < scrollTop + threshold) above.push(peer);
          else if (top > scrollTop + height - threshold) below.push(peer);
        } catch {
          // stale relative position — skip
        }
      });

      setAboveCursors((prev) => (samePeerList(prev, above) ? prev : above));
      setBelowCursors((prev) => (samePeerList(prev, below) ? prev : below));
    };

    let rafToken: number | null = null;
    const scheduleCompute = () => {
      if (rafToken !== null) return;
      rafToken = requestAnimationFrame(() => {
        rafToken = null;
        compute();
      });
    };

    awareness.on("change", scheduleCompute);
    const scrollSub = editor.onDidScrollChange(scheduleCompute);
    const layoutSub = editor.onDidLayoutChange(scheduleCompute);
    compute();
    return () => {
      awareness.off("change", scheduleCompute);
      scrollSub.dispose();
      layoutSub.dispose();
      if (rafToken !== null) cancelAnimationFrame(rafToken);
    };
  }, [awareness, ydoc, editorReady]);

  async function commitTitle() {
    const next = limitDocumentTitle(titleDraft.trim());
    if (!next || next === title) {
      setTitleDraft(title);
      return;
    }
    try {
      const d = await api.renameDocument(id, next);
      setTitle(limitDocumentTitle(d.title));
      setTitleDraft(limitDocumentTitle(d.title));
    } catch (err) {
      notifyError(err, "rename-document");
      setTitleDraft(title);
    }
  }

  function toggleCommentsPanel() {
    const opening = !commentsPanelOpen;
    setCommentsPanelOpen(opening);
    if (opening) void refreshComments();
  }

  async function refreshComments() {
    try {
      setComments(await api.listComments(id, true));
    } catch (err) {
      notifyError(err, "list-comments");
    }
  }

  async function createReviewComment() {
    if (!commentPopup) return;
    const body = commentBody.trim();
    if (!body) return;
    setCommentSubmitting(true);
    try {
      const comment = await api.createComment(
        id,
        commentPopup.kind,
        body,
        commentPopup.anchor,
      );
      setComments((prev) => [comment, ...prev]);
      setCommentBody("");
      setCommentPopup(null);
      setCommentsPanelOpen(true);
    } catch (err) {
      notifyError(err, "create-comment");
    } finally {
      setCommentSubmitting(false);
    }
  }

  async function resolveReviewComment(commentID: string) {
    try {
      const comment = await api.resolveComment(id, commentID);
      setComments((prev) => prev.map((item) => (item.id === commentID ? comment : item)));
    } catch (err) {
      notifyError(err, "resolve-comment");
    }
  }

  async function deleteReviewComment(commentID: string) {
    try {
      await api.deleteComment(id, commentID);
      setComments((prev) => prev.filter((item) => item.id !== commentID));
      if (selectedCommentId === commentID) {
        selectComment(null);
      }
      setPendingCommentDelete(null);
    } catch (err) {
      notifyError(err, "delete-comment");
    }
  }

  function selectComment(commentId: string | null) {
    setSelectedCommentId(commentId);
    const comment = commentId ? comments.find((c) => c.id === commentId) : null;
    const anchor = comment ? resolveCommentAnchor(comment, ydoc, ytext) : null;
    const editor = editorRef.current;
    const monaco = monacoRef.current;

    if (!commentId || !anchor?.line) {
      if (editor) applyCommentHighlight(editor, monaco, commentDecorationsRef, null, false);
      return;
    }

    if (editor) applyCommentHighlight(editor, monaco, commentDecorationsRef, anchor, true);
    scrollPreviewToLine(previewScrollRef.current, anchor.line);
  }

  const clearSelectedCommentOnOutsideClick = useEffectEvent(() => {
    selectComment(null);
  });

  const selectedCommentAnchor = useMemo(() => {
    if (!selectedCommentId) return null;
    const comment = comments.find((item) => item.id === selectedCommentId);
    return comment ? resolveCommentAnchor(comment, ydoc, ytext) : null;
  }, [comments, selectedCommentId, ydoc, ytext]);

  useEffect(() => {
    const preview = previewScrollRef.current;
    clearPreviewCommentHighlight(preview);
    if (!selectedCommentAnchor) return;
    highlightPreviewCommentRange(preview, selectedCommentAnchor);
  }, [selectedCommentAnchor, previewText]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    applyCommentHighlight(editor, monacoRef.current, commentDecorationsRef, selectedCommentAnchor, false);
  }, [selectedCommentAnchor]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    const decorations = blameDecorationsRef.current;
    if (!editor || !model || !decorations || !blameActive || !blameMap) {
      decorations?.set([]);
      return;
    }
    const next: Monaco.editor.IModelDeltaDecoration[] = [];
    for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
      const lineStart = model.getOffsetAt({ lineNumber, column: 1 });
      const info = blameMap[lineStart];
      if (!info) continue;
      const token = blameColorToken(info.color);
      next.push({
        range: new monacoRef.current!.Range(lineNumber, 1, lineNumber, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `monaco-blame-line-${token}`,
          firstLineDecorationClassName: `monaco-blame-line-${token}`,
        },
      });
    }
    decorations.set(next);
  }, [blameActive, blameMap, previewText]);

  useEffect(() => {
    const styleId = "syncscribe-monaco-blame-colors";
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = styleId;
      document.head.appendChild(style);
    }
    const colors = new Set<string>();
    for (const info of blameMap ?? []) {
      if (info?.color) colors.add(info.color);
    }
    style.textContent = Array.from(colors)
      .map((color) => {
        const token = blameColorToken(color);
        return [
          `.monaco-blame-line-${token}{box-shadow:inset 3px 0 0 ${color};}`,
          `.monaco-editor .margin-view-overlays .monaco-blame-line-${token}{border-left:3px solid ${color};box-sizing:border-box;}`,
        ].join("");
      })
      .join("\n");
    return () => {
      style?.remove();
    };
  }, [blameMap]);

  useEffect(() => {
    if (!selectedCommentId) return;
    const onPointerDown = (event: MouseEvent) => {
      if (pendingCommentDelete) return;
      const target = event.target as Node | null;
      if (!target) return;
      if (commentsPanelRef.current?.contains(target)) return;
      clearSelectedCommentOnOutsideClick();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [pendingCommentDelete, selectedCommentId, comments]);

  function printPreview() {
    window.print();
  }

  // Snapshots are the export source — without one, /export?format=md 409s.
  // We expose a manual Publish so users can decide when the markdown view is
  // "good"; a future M-N can flip this to auto-snapshot-on-idle.
  async function publishSnapshot() {
    const body = ytext.toString();
    setPublishState("saving");
    try {
      await api.publishSnapshot(id, body);
      flashPublishState("saved");
    } catch (err) {
      notifyError(err, "publish-snapshot");
      setPublishState("error");
      setTimeout(() => setPublishState((s) => (s === "error" ? "idle" : s)), 2500);
    }
  }

  function flashPublishState(state: "saved") {
    setPublishState(state);
    setTimeout(() => setPublishState((s) => (s === "saved" ? "idle" : s)), 1800);
  }

  async function toggleBlame() {
    if (blameActive) {
      setBlameActive(false);
      setBlameMap(null);
      return;
    }
    setBlameActive(true);
    if (blameMap) return; // already loaded
    setBlameLoading(true);
    try {
      const { updates } = await api.getAttribution(id);
      setBlameMap(buildBlameMap(updates));
    } catch (err) {
      notifyError(err, "load-blame");
      setBlameActive(false);
    } finally {
      setBlameLoading(false);
    }
  }

  const canUpload = connState !== "readonly";
  const reportUploadError = (msg: string) => notifyError(new ApiError(0, msg), "upload-asset");

  const mdComponents = useMemo<Components>(
    () => ({
      ...markdownComponents,
      img: ({ src, ...rest }) => (
        <AuthedImg
          docId={id}
          src={typeof src === "string" ? src : undefined}
          {...(rest as Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src">)}
        />
      ),
    }),
    [id],
  );

  useEffect(() => {
    const key = localDraftKey(id);
    if (serverSaveState === "saved") {
      localStorage.removeItem(key);
      return;
    }
    if (previewText) localStorage.setItem(key, previewText);
  }, [id, previewText, serverSaveState]);

  // Dashboard's "Import .md" stashes the file content in sessionStorage and
  // navigates here. On first live sync, if the doc is still empty, seed it.
  useEffect(() => {
    if (connState !== "live") return;
    const key = `syncscribe.import.${id}`;
    const pending = sessionStorage.getItem(key);
    if (!pending) return;
    sessionStorage.removeItem(key);
    if (ytext.length > 0) return;
    ytext.doc?.transact(() => {
      ytext.insert(0, pending);
    });
  }, [connState, id, ytext]);

  useEffect(() => {
    if (connState !== "live") return;
    const key = localDraftKey(id);
    const draft = localStorage.getItem(key);
    if (!draft || draft === ytext.toString()) return;
    if (confirm("Recover unsaved local edits from this browser?")) {
      ytext.doc?.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, draft);
      });
    } else {
      localStorage.removeItem(key);
    }
  }, [connState, id, ytext]);

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-sm rounded-lg border border-current/10 p-5">
          <div className="mb-3 h-2 w-24 rounded-full bg-current/10" />
          <div className="mb-2 h-4 rounded-full bg-current/10" />
          <div className="h-4 w-2/3 rounded-full bg-current/10" />
          <p className="mt-4 text-sm opacity-60">Loading document…</p>
        </div>
      </main>
    );
  }
  if (!me) {
    if (typeof window !== "undefined") {
      window.location.replace(`/login?next=${encodeURIComponent(`/d/${id}`)}`);
    }
    return null;
  }
  if (notFound) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4">
        <p className="text-sm opacity-70">{loadError || "Document not found or no access."}</p>
        <button onClick={() => router.push("/")} className="text-sm underline">
          Back to dashboard
        </button>
      </main>
    );
  }

  return (
    <div className="editor-shell flex h-screen flex-col">
      <div className="no-print">
        <TopBar
          me={me}
          status={connState}
          onSignedOut={() => router.push("/login")}
          center={
            <>
              <div className="flex min-w-0 flex-1 items-center rounded-md px-1 focus-within:bg-current/5 md:max-w-xs lg:max-w-md xl:max-w-lg">
                <ServerSaveStatus state={serverSaveState} />
                <input
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(limitDocumentTitle(e.target.value))}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    if (e.key === "Escape") setTitleDraft(title);
                  }}
                  maxLength={DOCUMENT_TITLE_MAX_CHARS}
                  className="min-w-0 flex-1 truncate bg-transparent py-1 pl-1 pr-2 text-sm outline-none"
                  placeholder="Untitled"
                />
              </div>
            </>
          }
          right={
            <>
              <div className="hidden items-center gap-0.5 md:flex">
                <IconBtn
                  onClick={publishSnapshot}
                  title="Publish snapshot (save markdown version)"
                  disabled={publishState === "saving"}
                >
                  <CloudUpIcon className={`h-[18px] w-[18px] ${publishIconClass(publishState)}`} />
                </IconBtn>
                <IconBtn onClick={() => setShareOpen(true)} title="Share document">
                  <ShareIcon className="h-[18px] w-[18px]" />
                </IconBtn>
                <IconBtn onClick={() => setExportOpen(true)} title="Export">
                  <DownloadIcon className="h-[18px] w-[18px]" />
                </IconBtn>
                <IconBtn
                  onClick={toggleCommentsPanel}
                  title={commentsPanelOpen ? "Close comments" : "Comments and suggestions"}
                  className={commentsPanelOpen ? "text-indigo-600 dark:text-indigo-400" : ""}
                >
                  <span className="relative">
                    <MessageSquareIcon className="h-[18px] w-[18px]" />
                    {(() => {
                      const n = comments.filter((c) => !c.resolved_at).length;
                      return n > 0 ? (
                        <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-indigo-600 px-0.5 text-[9px] font-bold leading-none text-white">
                          {n > 9 ? "9+" : n}
                        </span>
                      ) : null;
                    })()}
                  </span>
                </IconBtn>
                <IconBtn onClick={printPreview} title="Print">
                  <PrinterIcon className="h-[18px] w-[18px]" />
                </IconBtn>
                <IconBtn onClick={() => setHistoryOpen(true)} title="Version history">
                  <HistoryIcon className="h-[18px] w-[18px]" />
                </IconBtn>
                <IconBtn
                  onClick={() => void toggleBlame()}
                  title={blameActive ? "Hide blame (attribution)" : "Show blame — hover characters to see authors"}
                  aria-pressed={blameActive}
                  className={blameActive ? "text-indigo-600 dark:text-indigo-400" : ""}
                  disabled={blameLoading}
                >
                  {blameLoading ? (
                    <SpinnerIcon className="h-[18px] w-[18px] animate-spin" />
                  ) : (
                    <BlameIcon className="h-[18px] w-[18px]" />
                  )}
                </IconBtn>
              </div>
              <MobileActionsMenu
                publishState={publishState}
                onPublish={publishSnapshot}
                onShare={() => setShareOpen(true)}
                onExport={() => setExportOpen(true)}
                onPrint={printPreview}
                onHistory={() => setHistoryOpen(true)}
                onReview={toggleCommentsPanel}
              />
            </>
          }
        />
      </div>
      <div className="flex min-h-0 flex-1">
        <DocumentSidebar
          docs={docs}
          ownerID={me.id}
          currentDocID={id}
          loadFailed={docsLoadFailed}
          collapsed={docsSidebarCollapsed}
          onCollapsedChange={setDocsSidebarCollapsed}
        />
        <div className="relative flex min-w-0 flex-1 flex-col" data-mobile-tab={mobileTab}>
          <style>{`
            @media (max-width: 639px) {
              [data-mobile-tab="editor"] #d-preview-pane,
              [data-mobile-tab="preview"] #d-editor-pane { display: none !important; }
            }
          `}</style>
          {/* Mobile-only tab switcher between editor and preview. */}
          <div className="no-print flex items-center justify-center gap-1 border-b border-current/10 bg-current/5 p-1 sm:hidden">
            {(["editor", "preview"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setMobileTab(t)}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium capitalize ${
                  mobileTab === t
                    ? "bg-white shadow-sm dark:bg-neutral-800"
                    : "opacity-70 hover:opacity-100"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <PanelGroup orientation="horizontal" className="editor-panels flex-1">
            <Panel
              id="d-editor-pane"
              className="no-print"
              defaultSize={60}
              minSize={20}
            >
              <div className="relative h-full w-full">
                <OffScreenCursorIndicators above={aboveCursors} below={belowCursors} />
                <YjsMonacoEditor
                  docPath={`document-${id}.md`}
                  ytext={ytext}
                  awareness={awareness}
                  dark={isDark}
                  readOnly={connState === "readonly"}
                  lineNumbers="on"
                  onMount={(editor, monaco) => {
                    editorRef.current = editor;
                    monacoRef.current = monaco;
                    commentDecorationsRef.current = editor.createDecorationsCollection([]);
                    blameDecorationsRef.current = editor.createDecorationsCollection([]);
                    setEditorReady(true);
                    blameHoverProviderRef.current?.dispose();
                    blameHoverProviderRef.current = monaco.languages.registerHoverProvider("markdown", {
                      provideHover(model, position) {
                        if (!blameActiveRef.current || model !== editor.getModel() || !blameMapRef.current) return null;
                        const offset = model.getOffsetAt(position);
                        const info = blameMapRef.current[offset];
                        if (!info) return null;
                        return {
                          range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column + 1),
                          contents: [
                            { value: `**${info.name}**` },
                            { value: new Date(info.createdAt).toLocaleString() },
                          ],
                        };
                      },
                    });
                  }}
                  onContextMenu={({ clientX, clientY, offset }) => {
                    const editor = editorRef.current;
                    if (!editor) return;
                    const anchor = buildCommentAnchorDraft(editor, ytext, offset);
                    setCommentPopup(null);
                    setContextMenu({ x: clientX, y: clientY, line: anchor.line, anchor });
                  }}
                  onFilesInput={(files, offset) => {
                    const editor = editorRef.current;
                    const monaco = monacoRef.current;
                    if (!editor || !monaco) return;
                    void uploadAndInsertImagesMonaco(editor, monaco, id, files, {
                      canUpload: () => canUpload,
                      onError: reportUploadError,
                    }, offset);
                  }}
                  onDragState={setDraggingAsset}
                />
                {draggingAsset && (
                  <div
                    className="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-blue-400 bg-blue-50/70 text-sm font-medium text-blue-700 dark:border-blue-300 dark:bg-blue-950/40 dark:text-blue-200"
                    aria-hidden
                  >
                    Drop image to upload
                  </div>
                )}
                <input
                  ref={insertImageInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files ?? []);
                    e.target.value = "";
                    const offset = insertImageOffsetRef.current;
                    insertImageOffsetRef.current = null;
                    const editor = editorRef.current;
                    const monaco = monacoRef.current;
                    if (!editor || !monaco || files.length === 0) return;
                    void uploadAndInsertImagesMonaco(editor, monaco, id, files, {
                      canUpload: () => canUpload,
                      onError: reportUploadError,
                    }, offset ?? undefined);
                  }}
                />
              </div>
            </Panel>
            <PanelResizeHandle
              className="no-print group relative hidden w-1.5 cursor-col-resize items-center justify-center bg-current/10 transition-colors hover:w-2 hover:bg-current/25 sm:flex"
              aria-label="Drag to resize editor and preview panes"
              title="Drag to resize"
            >
              <span className="pointer-events-none absolute inline-flex h-10 w-4 items-center justify-center rounded-full bg-white text-current/40 shadow-sm ring-1 ring-current/10 transition-all group-hover:text-current/80 group-hover:shadow dark:bg-neutral-900">
                <GripVerticalIcon className="h-4 w-4" />
              </span>
            </PanelResizeHandle>
            <Panel
              id="d-preview-pane"
              className="preview-pane"
              defaultSize={40}
              minSize={15}
            >
              <div ref={previewScrollRef} className="md-preview print-preview h-full w-full overflow-auto p-4 pb-24 sm:p-6">
                <div className="print-metadata">
                  <h1>{title || "Untitled"}</h1>
                  <p>
                    Exported from SyncScribe on{" "}
                    {new Date().toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "long",
                      day: "numeric",
                    })}
                  </p>
                </div>
                <ReactMarkdown components={mdComponents} remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSourceTextSpans]} skipHtml>
                  {previewText || "_Start typing on the left…_"}
                </ReactMarkdown>
              </div>
            </Panel>
          </PanelGroup>
          <div className="no-print absolute bottom-2 left-2 z-10">
            <TypingPill awareness={awareness} />
          </div>
          <PresenceDock peers={presencePeers} open={presenceDockOpen} onOpenChange={setPresenceDockOpen} />
        </div>
        {commentsPanelOpen && (
          <CommentsPanel
            panelRef={commentsPanelRef}
            comments={comments}
            error=""
            selectedCommentId={selectedCommentId}
            onClose={() => {
              setCommentsPanelOpen(false);
              selectComment(null);
            }}
            onResolve={(cid) => void resolveReviewComment(cid)}
            onDelete={(cid, label) => setPendingCommentDelete({ id: cid, label })}
            onSelect={(cid) => selectComment(cid)}
          />
        )}
      </div>
      {/* Context menu — appears on right-click inside the editor */}
      {contextMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setContextMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setContextMenu(null); }}
          />
          <EditorContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onAddComment={() => {
              setCommentPopup({ x: contextMenu.x, y: contextMenu.y, anchor: contextMenu.anchor, kind: "comment" });
              setContextMenu(null);
            }}
            onAddSuggestion={() => {
              setCommentPopup({ x: contextMenu.x, y: contextMenu.y, anchor: contextMenu.anchor, kind: "suggestion" });
              setContextMenu(null);
            }}
            canInsertImage={canUpload}
            onInsertImage={() => {
              insertImageOffsetRef.current = contextMenu.anchor.from;
              setContextMenu(null);
              insertImageInputRef.current?.click();
            }}
            onClose={() => setContextMenu(null)}
          />
        </>
      )}
      <Modal open={!!pendingCommentDelete} onClose={() => setPendingCommentDelete(null)} title="Delete comment" width="max-w-md">
        <div className="space-y-4">
          <p className="text-sm opacity-80">
            Delete this comment permanently?
          </p>
          {pendingCommentDelete && (
            <div className="rounded-lg border border-current/10 bg-current/5 px-3 py-2 text-sm">
              {pendingCommentDelete.label}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setPendingCommentDelete(null)}
              className="rounded-md px-3 py-2 text-sm hover:bg-current/5"
            >
              Cancel
            </button>
            <button
              onClick={() => pendingCommentDelete && void deleteReviewComment(pendingCommentDelete.id)}
              className="rounded-md bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Delete
            </button>
          </div>
        </div>
      </Modal>
      {/* Comment input popup — appears after picking Add comment from context menu */}
      {commentPopup && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => { setCommentPopup(null); setCommentBody(""); }}
          />
          <CommentInputPopup
            x={commentPopup.x}
            y={commentPopup.y}
            anchor={commentPopup.anchor}
            kind={commentPopup.kind}
            body={commentBody}
            submitting={commentSubmitting}
            error=""
            onChange={setCommentBody}
            onSubmit={() => void createReviewComment()}
            onCancel={() => { setCommentPopup(null); setCommentBody(""); }}
          />
        </>
      )}
      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        docId={id}
        title={title}
        getBody={() => ytext.toString()}
        onPublishedSnapshot={() => flashPublishState("saved")}
      />
      <ShareModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        docId={id}
        isOwner={isOwner}
        documentRole={documentRole}
      />
      <HistoryModal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docId={id}
        currentBody={previewText}
        canRestore={connState !== "readonly"}
        onRestored={(t) => {
          setTitle(limitDocumentTitle(t));
          setTitleDraft(limitDocumentTitle(t));
        }}
      />
    </div>
  );
}
