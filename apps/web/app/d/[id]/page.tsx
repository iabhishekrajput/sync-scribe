"use client";

import React, { isValidElement, type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type * as Monaco from "monaco-editor";
import { Group as PanelGroup, Panel, Separator as PanelResizeHandle } from "react-resizable-panels";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  api,
  type ActivityEvent,
  type AttributionUpdate,
  type CreateCommentAnchor,
  type Document,
  type DocumentAccess,
  type DocumentComment,
  type Invite,
  type SnapshotBody,
  type SnapshotSummary,
} from "../../lib/api";
import { fetchMe, getAccessToken, loginURL } from "../../lib/auth";
import { ApiError, notifyError } from "../../lib/errors";
import { toast } from "sonner";
import { TopBar } from "../../components/TopBar";
import { SyncProvider, type ConnectionState, type SaveState } from "../../lib/yjs";
import { ShareLinksPanel } from "../../components/ShareLinksPanel";
import { TypingPill } from "../../components/TypingPill";
import { makeTypingStamper, TYPING_FRESHNESS_MS } from "../../lib/typing";
import { Modal } from "../../components/Modal";
import dynamic from "next/dynamic";
const YjsMonacoEditor = dynamic(
  () => import("../../components/YjsMonacoEditor").then((m) => m.YjsMonacoEditor),
  { ssr: false },
);
import {
  BlameIcon,
  CloudOffIcon,
  CloudUpIcon,
  CheckIcon,
  DownloadIcon,
  GripVerticalIcon,
  HistoryIcon,
  MessageSquareIcon,
  MenuIcon,
  PrinterIcon,
  ShareIcon,
  SpinnerIcon,
} from "../../components/icons";

type Me = { id: string; email: string; display_name: string };
type InviteRole = "viewer" | "editor";
type AccessRole = "viewer" | "editor" | "owner";
type PresencePeer = {
  clientID: number;
  name: string;
  color: string;
  actor: string;
  typingAt?: number;
  connected: boolean;
  lastSeen: number;
};
type CommentAnchorDraft = CreateCommentAnchor & {
  from: number;
  to: number;
  line: number;
};
type ResolvedCommentAnchor = {
  from: number | null;
  to: number | null;
  line: number | null;
};
type CommentDeleteTarget = {
  id: string;
  label: string;
};
type ExportStatus =
  | { state: "loading" }
  | { state: "none" }
  | { state: "current"; version: number; createdAt: string }
  | { state: "stale"; version: number; createdAt: string };

const DOCUMENT_TITLE_MAX_CHARS = 80;
const COMMENT_SNIPPET_MAX_CHARS = 160;
const PRESENCE_LINGER_MS = 5000;

type BlameInfo = {
  user: string;
  name: string;
  color: string;
  seq: number;
  createdAt: string;
};
type BlameMap = (BlameInfo | null)[];

// --- Blame computation ---

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function encodeBase64(bytes: Uint8Array) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeBase64(raw: string) {
  const bin = atob(raw);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function compactCommentSnippet(text: string) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= COMMENT_SNIPPET_MAX_CHARS) return normalized;
  return `${normalized.slice(0, COMMENT_SNIPPET_MAX_CHARS - 1)}…`;
}

function buildCommentAnchorDraft(
  editor: Monaco.editor.IStandaloneCodeEditor,
  ytext: Y.Text,
  clickedPos: number | null,
): CommentAnchorDraft {
  const model = editor.getModel();
  const selection = editor.getSelection();
  if (!model || !selection) {
    const fallback = clickedPos ?? 0;
    return {
      from: fallback,
      to: fallback,
      line: 1,
      line_number: 1,
      anchor_start: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, fallback))),
      anchor_end: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, fallback))),
      anchor_text: "",
    };
  }
  const selectionFrom = model.getOffsetAt(selection.getStartPosition());
  const selectionTo = model.getOffsetAt(selection.getEndPosition());
  const anchorPos = clickedPos ?? selectionFrom;
  const useSelection = !selection.isEmpty() && anchorPos >= selectionFrom && anchorPos <= selectionTo;
  const from = useSelection ? selectionFrom : anchorPos;
  const to = useSelection ? selectionTo : anchorPos;
  const line = model.getPositionAt(from).lineNumber;
  return {
    from,
    to,
    line,
    line_number: line,
    anchor_start: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from))),
    anchor_end: encodeBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to))),
    anchor_text: from === to ? "" : compactCommentSnippet(model.getValueInRange({
      startLineNumber: model.getPositionAt(from).lineNumber,
      startColumn: model.getPositionAt(from).column,
      endLineNumber: model.getPositionAt(to).lineNumber,
      endColumn: model.getPositionAt(to).column,
    })),
  };
}

function resolveRelativeIndex(ydoc: Y.Doc, ytext: Y.Text, encoded?: string) {
  if (!encoded) return null;
  try {
    const pos = Y.decodeRelativePosition(decodeBase64(encoded));
    const absolute = Y.createAbsolutePositionFromRelativePosition(pos, ydoc);
    if (!absolute || absolute.type !== ytext) return null;
    return absolute.index;
  } catch {
    return null;
  }
}

function resolveCommentAnchor(comment: DocumentComment, ydoc: Y.Doc, ytext: Y.Text) {
  const from = resolveRelativeIndex(ydoc, ytext, comment.anchor_start);
  const to = resolveRelativeIndex(ydoc, ytext, comment.anchor_end);
  if (from !== null && to !== null) {
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return {
      from: start,
      to: end,
      line: ytext.toString().slice(0, start).split("\n").length,
    } satisfies ResolvedCommentAnchor;
  }
  return {
    from: null,
    to: null,
    line: comment.line_number ?? null,
  } satisfies ResolvedCommentAnchor;
}

function computeBlame(updates: AttributionUpdate[]): BlameMap {
  const blameDoc = new Y.Doc();
  const blameText = blameDoc.getText("content");
  let blame: BlameMap = [];

  for (const update of updates) {
    const info: BlameInfo = {
      user: update.origin_user,
      name: update.origin_name || update.origin_user || "Unknown",
      color: update.origin_user ? colorForUser(update.origin_user).color : "#737373",
      seq: update.seq,
      createdAt: update.created_at,
    };
    const observer = (event: Y.YTextEvent) => {
      const next: BlameMap = [];
      let oldIdx = 0;
      for (const op of event.changes.delta) {
        if ("retain" in op && op.retain) {
          for (let i = 0; i < (op.retain as number); i++) next.push(blame[oldIdx++] ?? null);
        } else if ("insert" in op && op.insert) {
          const len = typeof op.insert === "string" ? (op.insert as string).length : 1;
          for (let i = 0; i < len; i++) next.push(info);
        } else if ("delete" in op && op.delete) {
          oldIdx += op.delete as number;
        }
      }
      while (oldIdx < blame.length) next.push(blame[oldIdx++]);
      blame = next;
    };
    blameText.observe(observer);
    Y.applyUpdate(blameDoc, base64ToBytes(update.blob));
    blameText.unobserve(observer);
  }

  blameDoc.destroy();
  return blame;
}

function limitDocumentTitle(title: string) {
  return title.slice(0, DOCUMENT_TITLE_MAX_CHARS);
}

function localDraftKey(docID: string) {
  return `syncscribe:draft:${docID}`;
}

type MermaidConfig = {
  startOnLoad: boolean;
  securityLevel: "strict";
  theme: "base" | "dark";
  themeVariables?: Record<string, string>;
};

type MermaidAPI = {
  initialize: (config: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }> | { svg: string };
};

declare global {
  interface Window {
    mermaid?: MermaidAPI;
  }
}

export default function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [me, setMe] = useState<Me | null>(null);
  const [title, setTitle] = useState("");
  const [titleDraft, setTitleDraft] = useState("");
  const [ownerID, setOwnerID] = useState("");
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
  const [exportStatus, setExportStatus] = useState<ExportStatus>({ state: "loading" });
  const [exportBusy, setExportBusy] = useState<"markdown" | "publish-markdown" | "pdf" | "">("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("editor");
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [accessList, setAccessList] = useState<DocumentAccess[]>([]);
  const [pendingInvites, setPendingInvites] = useState<Invite[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessBusyUserID, setAccessBusyUserID] = useState("");
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState(0);
  const [snapshotBody, setSnapshotBody] = useState<SnapshotBody | null>(null);
  const [historyView, setHistoryView] = useState<"preview" | "diff">("diff");
  const [restoring, setRestoring] = useState(false);
  const [publishState, setPublishState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [mobileTab, setMobileTab] = useState<"editor" | "preview">("editor");
  const isOwner = !!me && me.id === ownerID;
  const [{ ydoc, awareness }] = useState(() => {
    const doc = new Y.Doc();
    return { ydoc: doc, awareness: new Awareness(doc) };
  });
  const ytext = ydoc.getText("content");

  async function refreshAccessList() {
    if (!isOwner) return;
    setAccessLoading(true);
    try {
      const access = await api.listAccess(id);
      setAccessList(access);
      setPendingInvites(await api.listInvites(id));
    } catch (err) {
      notifyError(err, "list-access");
    } finally {
      setAccessLoading(false);
    }
  }

  const refreshAccessListOnOpen = useEffectEvent(() => {
    void refreshAccessList();
  });

  useEffect(() => {
    if (!shareOpen || !isOwner) return;
    const timer = window.setTimeout(() => {
      refreshAccessListOnOpen();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOwner, shareOpen]);

  const [aboveCursors, setAboveCursors] = useState<PresencePeer[]>([]);
  const [belowCursors, setBelowCursors] = useState<PresencePeer[]>([]);
  const [editorReady, setEditorReady] = useState(false);

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
      const m = (await fetchMe()) as Me | null;
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

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteState("sending");
    try {
      await api.createInvite(id, email, inviteRole);
      setInviteEmail("");
      setInviteState("sent");
      await refreshAccessList();
    } catch (err) {
      notifyError(err, "send-invite");
      setInviteState("error");
    }
  }

  async function revokeInvite(token: string) {
    try {
      await api.revokeInvite(id, token);
      setPendingInvites((prev) => prev.filter((invite) => invite.token !== token));
    } catch (err) {
      notifyError(err, "revoke-invite");
    }
  }

  async function resendInvite(token: string) {
    try {
      const invite = await api.resendInvite(id, token);
      setPendingInvites((prev) => [invite, ...prev.filter((item) => item.token !== token)]);
    } catch (err) {
      notifyError(err, "resend-invite");
    }
  }

  async function updateAccessRole(access: DocumentAccess, role: AccessRole) {
    setAccessBusyUserID(access.user_id);
    try {
      const updated = await api.upsertAccess(id, access.user_id, role);
      setAccessList((prev) => prev.map((item) => (item.user_id === access.user_id ? { ...item, ...updated } : item)));
    } catch (err) {
      notifyError(err, "update-access");
    } finally {
      setAccessBusyUserID("");
    }
  }

  async function revokeAccess(access: DocumentAccess) {
    setAccessBusyUserID(access.user_id);
    try {
      await api.deleteAccess(id, access.user_id);
      setAccessList((prev) => prev.filter((item) => item.user_id !== access.user_id));
    } catch (err) {
      notifyError(err, "revoke-access");
    } finally {
      setAccessBusyUserID("");
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

  async function openExport() {
    setExportOpen(true);
    await refreshExportStatus();
  }

  async function refreshExportStatus() {
    setExportStatus({ state: "loading" });
    try {
      const list = await api.listSnapshots(id);
      const latest = list.at(-1);
      if (!latest) {
        setExportStatus({ state: "none" });
        return;
      }
      const body = await api.getSnapshot(id, latest.version);
      if (!body.can_preview) {
        setExportStatus({ state: "stale", version: latest.version, createdAt: latest.created_at });
        return;
      }
      setExportStatus({
        state: body.body === ytext.toString() ? "current" : "stale",
        version: latest.version,
        createdAt: latest.created_at,
      });
    } catch (err) {
      notifyError(err, "export-status");
      setExportStatus({ state: "none" });
    }
  }

  // Snapshots are the export source — without one, /export?format=md 409s.
  // We expose a manual Publish so users can decide when the markdown view is
  // "good"; a future M-N can flip this to auto-snapshot-on-idle.
  async function publishSnapshot() {
    const body = ytext.toString();
    setPublishState("saving");
    try {
      await api.publishSnapshot(id, body);
      setPublishState("saved");
      if (exportOpen) void refreshExportStatus();
      setTimeout(() => setPublishState((s) => (s === "saved" ? "idle" : s)), 1800);
    } catch (err) {
      notifyError(err, "publish-snapshot");
      setPublishState("error");
      setTimeout(() => setPublishState((s) => (s === "error" ? "idle" : s)), 2500);
    }
  }

  async function exportMarkdown(publishFirst = false) {
    const token = await getAccessToken();
    if (!token) {
      window.location.href = loginURL(`/d/${id}`);
      return;
    }
    setExportBusy(publishFirst ? "publish-markdown" : "markdown");
    const doExport = async () =>
      fetch(api.exportMarkdownURL(id), {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
    if (publishFirst) {
      try {
        await api.publishSnapshot(id, ytext.toString());
        setPublishState("saved");
        setTimeout(() => setPublishState((s) => (s === "saved" ? "idle" : s)), 1800);
      } catch (err) {
        setExportBusy("");
        notifyError(err, "publish-before-export");
        return;
      }
    }
    let res = await doExport();
    if (res.status === 409) {
      try {
        await api.publishSnapshot(id, ytext.toString());
        res = await doExport();
      } catch {
        // fall through to the error branch
      }
    }
    if (!res.ok) {
      setExportBusy("");
      notifyError(new ApiError(res.status, "Could not export Markdown."), "export-markdown");
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const disposition = res.headers.get("content-disposition") ?? "";
    a.href = url;
    a.download = filenameFromDisposition(disposition) || `${title || "Untitled"}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setExportBusy("");
    if (exportOpen) void refreshExportStatus();
  }

  function exportPDF() {
    setExportBusy("pdf");
    setExportOpen(false);
    window.setTimeout(() => {
      window.print();
      setExportBusy("");
    }, 50);
  }

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const list = await api.listSnapshots(id);
      setSnapshots(list);
      const nextIndex = Math.max(list.length - 1, 0);
      setSelectedSnapshot(nextIndex);
      setHistoryView("diff");
      if (list[nextIndex]) {
        setSnapshotBody(await api.getSnapshot(id, list[nextIndex].version));
      } else {
        setSnapshotBody(null);
      }
    } catch (err) {
      notifyError(err, "open-history");
    } finally {
      setHistoryLoading(false);
    }
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
      setBlameMap(computeBlame(updates));
    } catch (err) {
      notifyError(err, "load-blame");
      setBlameActive(false);
    } finally {
      setBlameLoading(false);
    }
  }

  async function chooseSnapshot(index: number) {
    setSelectedSnapshot(index);
    setSnapshotBody(null);
    const snap = snapshots[index];
    if (!snap) return;
    try {
      setSnapshotBody(await api.getSnapshot(id, snap.version));
    } catch (err) {
      notifyError(err, "load-snapshot");
    }
  }

  async function restoreSelectedSnapshot() {
    const snap = snapshots[selectedSnapshot];
    if (!snap) return;
    const ok = confirm(
      `Restore version ${snap.version}? This creates a new head snapshot and keeps the current history intact.`,
    );
    if (!ok) return;
    setRestoring(true);
    try {
      const res = await api.restoreSnapshot(id, snap.version);
      setTitle(limitDocumentTitle(res.document.title));
      setTitleDraft(limitDocumentTitle(res.document.title));
      setHistoryOpen(false);
    } catch (err) {
      notifyError(err, "restore-snapshot");
    } finally {
      setRestoring(false);
    }
  }

  const canUpload = connState !== "readonly";
  const [draggingAsset, setDraggingAsset] = useState(false);
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

  const selectedSnapshotSummary = snapshots[selectedSnapshot];
  const currentBody = previewText;
  const snapshotDiff = useMemo(
    () => buildLineDiff(snapshotBody?.can_preview ? snapshotBody.body : "", currentBody),
    [snapshotBody, currentBody],
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
                <IconBtn onClick={() => void openExport()} title="Export">
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
                <IconBtn onClick={openHistory} title="Version history">
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
                onExport={() => void openExport()}
                onPrint={printPreview}
                onHistory={openHistory}
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
      <Modal open={exportOpen} onClose={() => setExportOpen(false)} title="Export" width="max-w-2xl">
        <div className="space-y-4">
          <div className="rounded-lg border border-current/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">Markdown snapshot</h3>
                <p className="mt-1 text-sm opacity-70">{exportStatusText(exportStatus)}</p>
              </div>
              <button
                onClick={() => void refreshExportStatus()}
                disabled={exportStatus.state === "loading"}
                className="rounded-md border border-current/15 px-3 py-1.5 text-sm hover:bg-current/5 disabled:opacity-50"
              >
                Refresh
              </button>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => void exportMarkdown(false)}
                disabled={exportBusy !== "" || exportStatus.state === "none" || exportStatus.state === "loading"}
                className="rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
              >
                {exportBusy === "markdown" ? "Exporting..." : "Export latest snapshot"}
              </button>
              <button
                onClick={() => void exportMarkdown(true)}
                disabled={exportBusy !== ""}
                className="rounded-md border border-current/15 px-3 py-2 text-sm hover:bg-current/5 disabled:opacity-50"
              >
                {exportBusy === "publish-markdown" ? "Publishing..." : "Publish current editor and export"}
              </button>
            </div>
          </div>
          <div className="rounded-lg border border-current/10 p-4">
            <h3 className="text-sm font-semibold">PDF / print</h3>
            <p className="mt-1 text-sm opacity-70">
              Opens the browser print dialog with app chrome hidden, document title metadata, and print-friendly Markdown layout.
            </p>
            <button
              onClick={exportPDF}
              disabled={exportBusy !== ""}
              className="mt-4 rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {exportBusy === "pdf" ? "Opening..." : "Print or save PDF"}
            </button>
          </div>
        </div>
      </Modal>
      <Modal
        open={shareOpen}
        onClose={() => {
          setShareOpen(false);
          setInviteState("idle");
        }}
        title="Share document"
        width="max-w-xl"
      >
        {isOwner ? (
          <>
            <label className="mb-1 block text-xs opacity-70" htmlFor="invite-email">
              Share by email
            </label>
            <div className="flex gap-2">
              <input
                id="invite-email"
                value={inviteEmail}
                type="email"
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                  setInviteState("idle");
                }}
                className="min-w-0 flex-1 rounded-md border border-current/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-current/40"
                placeholder="teammate@example.com"
              />
              <button
                onClick={sendInvite}
                disabled={inviteState === "sending" || !inviteEmail.trim()}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {inviteState === "sending" ? "Sharing…" : "Share"}
              </button>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-current/5 p-1">
              {(["editor", "viewer"] as const).map((role) => (
                <button
                  key={role}
                  onClick={() => setInviteRole(role)}
                  className={`rounded px-2 py-1.5 text-sm capitalize ${
                    inviteRole === role ? "bg-white shadow-sm dark:bg-neutral-800" : "opacity-70"
                  }`}
                >
                  {role}
                </button>
              ))}
            </div>
            {inviteState === "sent" && (
              <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">Access shared.</p>
            )}
            {inviteState === "error" && (
              <p className="mt-3 text-sm text-red-600 dark:text-red-400">Could not share access.</p>
            )}
            <div className="mt-5 border-t border-current/10 pt-4">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold">People with access</h3>
                <button onClick={() => void refreshAccessList()} className="text-xs opacity-70 hover:opacity-100">
                  Refresh
                </button>
              </div>
              {accessLoading ? (
                <p className="rounded-md border border-current/10 p-3 text-sm opacity-60">Loading access…</p>
              ) : accessList.length === 0 ? (
                <p className="rounded-md border border-dashed border-current/20 p-3 text-sm opacity-60">
                  Only you have access.
                </p>
              ) : (
                <ul className="divide-y divide-current/10 rounded-md border border-current/10">
                  {accessList.map((access) => (
                    <li key={access.user_id} className="flex items-center gap-3 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {access.display_name || access.email || access.user_id}
                        </p>
                        <p className="truncate text-xs opacity-60">{access.email || access.user_id}</p>
                      </div>
                      <select
                        value={access.role}
                        disabled={accessBusyUserID === access.user_id}
                        onChange={(e) => void updateAccessRole(access, e.target.value as AccessRole)}
                        className="rounded-md border border-current/15 bg-transparent px-2 py-1 text-sm capitalize outline-none focus:border-current/40"
                      >
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                        <option value="owner">Owner</option>
                      </select>
                      <button
                        onClick={() => void revokeAccess(access)}
                        disabled={accessBusyUserID === access.user_id}
                        className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        Revoke
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {pendingInvites.length > 0 && (
                <div className="mt-4">
                  <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Pending invites</h4>
                  <ul className="divide-y divide-current/10 rounded-md border border-current/10">
                    {pendingInvites.map((invite) => (
                      <li key={invite.token} className="flex items-center gap-3 px-3 py-2 text-sm">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{invite.email}</p>
                          <p className="truncate text-xs opacity-60">
                            {invite.role} · expires {new Date(invite.expires_at).toLocaleDateString()}
                          </p>
                        </div>
                        <button onClick={() => void resendInvite(invite.token)} className="rounded px-2 py-1 text-xs hover:bg-current/5">
                          Resend
                        </button>
                        <button
                          onClick={() => void revokeInvite(invite.token)}
                          className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                        >
                          Cancel
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </>
        ) : (
          <p className="rounded-md border border-current/10 p-3 text-sm opacity-70">
            Only the owner can manage document sharing.
          </p>
        )}
        <ShareLinksPanel docId={id} isOwner={isOwner} />
        {isOwner && <ActivityLog docId={id} />}
      </Modal>
      <Modal
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="Version history"
        width="max-w-5xl"
      >
        <div>
          {historyLoading ? (
                <div className="rounded-lg border border-current/10 p-4">
                  <div className="mb-3 h-4 w-32 rounded-full bg-current/10" />
                  <div className="h-24 rounded-md bg-current/10" />
                </div>
              ) : snapshots.length === 0 ? (
                <div className="rounded-lg border border-dashed border-current/20 p-8 text-center">
                  <p className="text-sm opacity-70">No snapshots have been written yet.</p>
                </div>
              ) : (
                <div className="grid min-h-[28rem] gap-4 md:grid-cols-[17rem_1fr]">
                  <aside className="min-h-0 overflow-auto rounded-lg border border-current/10">
                    <div className="sticky top-0 border-b border-current/10 bg-white p-3 dark:bg-neutral-950">
                      <input
                        type="range"
                        min={0}
                        max={snapshots.length - 1}
                        value={selectedSnapshot}
                        onChange={(e) => void chooseSnapshot(Number(e.target.value))}
                        className="w-full"
                        aria-label="Select snapshot"
                      />
                    </div>
                    <ol className="divide-y divide-current/10">
                      {snapshots.map((snapshot, index) => (
                        <li key={snapshot.version}>
                          <button
                            onClick={() => void chooseSnapshot(index)}
                            className={`w-full px-3 py-3 text-left text-sm hover:bg-current/5 ${
                              index === selectedSnapshot ? "bg-current/10" : ""
                            }`}
                          >
                            <span className="flex items-center justify-between gap-3">
                              <span className="font-medium">v{snapshot.version}</span>
                              <span className="text-xs opacity-60">{formatSnapshotDate(snapshot.created_at)}</span>
                            </span>
                            <span className="mt-1 block truncate text-xs opacity-70">
                              {snapshot.created_by_name || snapshot.created_by || "Unknown author"}
                            </span>
                            <span className="mt-2 block text-xs opacity-60">{snapshotChangeSummary(snapshot)}</span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </aside>
                  <div className="min-w-0 space-y-4">
                    <SnapshotMeta snapshot={selectedSnapshotSummary} />
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="inline-flex rounded-md border border-current/15 p-0.5 text-sm">
                        <button
                          onClick={() => setHistoryView("diff")}
                          className={`min-w-24 rounded px-3 py-1.5 ${
                            historyView === "diff" ? "bg-black text-white dark:bg-white dark:text-black" : "hover:bg-current/5"
                          }`}
                        >
                          Diff
                        </button>
                        <button
                          onClick={() => setHistoryView("preview")}
                          className={`min-w-24 rounded px-3 py-1.5 ${
                            historyView === "preview" ? "bg-black text-white dark:bg-white dark:text-black" : "hover:bg-current/5"
                          }`}
                        >
                          Snapshot
                        </button>
                      </div>
                      <button
                        onClick={restoreSelectedSnapshot}
                        disabled={restoring || connState === "readonly"}
                        className="rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
                      >
                        {restoring ? "Restoring…" : "Restore as new version"}
                      </button>
                    </div>
                    <div className="rounded-lg border border-current/10">
                      {!snapshotBody ? (
                        <div className="p-4 text-sm opacity-70">Loading snapshot…</div>
                      ) : !snapshotBody.can_preview ? (
                        <p className="p-4 text-sm opacity-70">
                          This snapshot is stored as an opaque CRDT blob and cannot be previewed as text yet.
                        </p>
                      ) : historyView === "preview" ? (
                        <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap p-4 text-sm">{snapshotBody.body}</pre>
                      ) : (
                        <SnapshotDiffView diff={snapshotDiff} onShowSnapshot={() => setHistoryView("preview")} />
                      )}
                    </div>
                  </div>
                </div>
              )}
        </div>
      </Modal>
    </div>
  );
}

function SnapshotMeta({ snapshot }: { snapshot?: SnapshotSummary }) {
  if (!snapshot) return null;
  const created = new Date(snapshot.created_at).toLocaleString();
  const users = snapshot.actor_breakdown.user;
  const guest = snapshot.actor_breakdown.guest ?? 0;
  const author = snapshot.created_by_name || snapshot.created_by || "Unknown author";
  return (
    <div className="grid gap-3 rounded-lg border border-current/10 p-3 text-sm sm:grid-cols-4">
      <div>
        <span className="block text-xs opacity-60">Version</span>
        <span className="font-medium">v{snapshot.version}</span>
      </div>
      <div>
        <span className="block text-xs opacity-60">Created</span>
        <span className="font-medium">{created}</span>
      </div>
      <div>
        <span className="block text-xs opacity-60">Published by</span>
        <span className="font-medium">{author}</span>
      </div>
      <div>
        <span className="block text-xs opacity-60">Changes</span>
        <span className="font-medium">
          {users} user{users === 1 ? "" : "s"}{guest ? `, ${guest} guest` : ""}
        </span>
        <span className="block text-xs opacity-60">{snapshotChangeSummary(snapshot)}</span>
      </div>
    </div>
  );
}

function exportStatusText(status: ExportStatus) {
  switch (status.state) {
    case "loading":
      return "Checking the latest published snapshot...";
    case "none":
      return "No Markdown snapshot exists yet. Publish the current editor content before exporting.";
    case "current":
      return `Current: v${status.version}, published ${new Date(status.createdAt).toLocaleString()}.`;
    case "stale":
      return `Stale: export will use v${status.version} from ${new Date(status.createdAt).toLocaleString()}, not unsnapshotted editor changes.`;
  }
}

function ActivityLog({ docId }: { docId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await api.listActivity(docId, 50);
        if (alive) setEvents(next);
      } catch {
        if (alive) setError("Could not load activity.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  return (
    <div className="mt-5 border-t border-current/10 pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Activity log</h3>
      </div>
      {events.length === 0 ? (
        <p className="text-xs opacity-60">{error || "No activity recorded yet."}</p>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-current/10 px-2 py-1.5 text-xs">
              <span className="font-medium">{event.actor_label}</span>{" "}
              <span className="opacity-75">{activityLabel(event)}</span>
              <span className="block opacity-55">{new Date(event.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
      {error && events.length > 0 && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

function activityLabel(event: ActivityEvent) {
  const labels: Record<string, string> = {
    "access.granted": "updated document access",
    "access.revoked": "revoked document access",
    "snapshot.published": "published a snapshot",
    "snapshot.restored": "restored a snapshot",
    "invite.created": "sent an invite",
    "share_link.created": "created a share link",
    "share_link.revoked": "revoked a share link",
    "comment.created": "added a comment",
    "comment.deleted": "deleted a comment",
    "comment.resolved": "resolved a comment",
  };
  return labels[event.event_type] ?? event.event_type.replaceAll(".", " ");
}

function collectPresencePeers(awareness: Awareness, previous: PresencePeer[]) {
  const now = Date.now();
  const previousByID = new Map(previous.map((peer) => [peer.clientID, peer]));
  const seen = new Set<number>();
  const next: PresencePeer[] = [];

  awareness.getStates().forEach((state, clientID) => {
    if (clientID === awareness.clientID) return;
    const user = state.user as
      | { actor?: string; name?: string; color?: string; typingAt?: number }
      | undefined;
    if (!user) return;
    seen.add(clientID);
    next.push({
      clientID,
      name: user.name || "Someone",
      color: user.color || previousByID.get(clientID)?.color || "#737373",
      actor: user.actor || "human",
      typingAt: user.typingAt,
      connected: true,
      lastSeen: now,
    });
  });

  for (const peer of previous) {
    if (seen.has(peer.clientID)) continue;
    if (now - peer.lastSeen > PRESENCE_LINGER_MS) continue;
    next.push({ ...peer, connected: false, typingAt: undefined });
  }

  return next.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

function samePeerList(a: PresencePeer[], b: PresencePeer[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].clientID !== b[i].clientID || a[i].color !== b[i].color || a[i].name !== b[i].name) {
      return false;
    }
  }
  return true;
}

function OffScreenCursorIndicators({
  above,
  below,
}: {
  above: PresencePeer[];
  below: PresencePeer[];
}) {
  if (above.length === 0 && below.length === 0) return null;

  const renderBar = (peers: PresencePeer[], direction: "up" | "down") => {
    if (peers.length === 0) return null;
    const shown = peers.slice(0, 4);
    const extra = peers.length - shown.length;
    return (
      <div
        className={`no-print pointer-events-none absolute left-0 right-0 z-20 flex items-center gap-1 px-3 py-0.5 ${
          direction === "up" ? "top-0" : "bottom-0"
        }`}
      >
        <span className="text-[11px] opacity-40">{direction === "up" ? "↑" : "↓"}</span>
        {shown.map((p) => (
          <span
            key={p.clientID}
            className="rounded-full px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
            style={{ backgroundColor: p.color }}
            title={`${p.name} is editing ${direction === "up" ? "above" : "below"}`}
          >
            {presenceInitial(p)}
          </span>
        ))}
        {extra > 0 && <span className="text-[10px] opacity-50">+{extra}</span>}
      </div>
    );
  };

  return (
    <>
      {renderBar(above, "up")}
      {renderBar(below, "down")}
    </>
  );
}

function PresenceDock({
  peers,
  open,
  onOpenChange,
}: {
  peers: PresencePeer[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (peers.length === 0) return null;
  const visible = peers.slice(0, 5);
  const overflow = peers.length - visible.length;
  const liveCount = peers.filter((peer) => peer.connected).length;

  if (!open) {
    return (
      <button
        onClick={() => onOpenChange(true)}
        className="no-print absolute bottom-4 right-4 z-10 rounded-full border border-current/10 bg-white/95 px-3 py-1.5 text-xs shadow-lg hover:bg-current/5 dark:bg-neutral-950/95"
        title="Show collaborators"
        aria-label="Show collaborators"
      >
        {liveCount} live
      </button>
    );
  }

  return (
    <aside className="no-print absolute bottom-4 right-4 z-10 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-current/10 bg-white/95 p-3 shadow-lg dark:bg-neutral-950/95">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Collaborators</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs opacity-60">{liveCount} live</span>
          <button
            onClick={() => onOpenChange(false)}
            className="rounded px-1.5 py-0.5 text-xs opacity-70 hover:bg-current/10 hover:opacity-100"
            title="Hide collaborators"
            aria-label="Hide collaborators"
          >
            Hide
          </button>
        </div>
      </div>
      <ul className="space-y-2">
        {visible.map((peer) => (
          <li key={peer.clientID} className={`flex gap-2 text-sm ${peer.connected ? "" : "opacity-55"}`}>
            <span
              aria-hidden
              className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{ backgroundColor: peer.color }}
            >
              {presenceInitial(peer)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{peer.name}</span>
                <span className="rounded-full bg-current/10 px-1.5 py-0.5 text-[10px] capitalize opacity-70">
                  {peer.actor}
                </span>
              </span>
              <span className="block truncate text-xs opacity-70">{presenceStatus(peer)}</span>
            </span>
          </li>
        ))}
      </ul>
      {overflow > 0 && <p className="mt-2 text-xs opacity-60">+{overflow} more connected</p>}
    </aside>
  );
}

function presenceInitial(peer: PresencePeer) {
  if (peer.actor === "guest") return "G";
  return peer.name.trim().charAt(0).toUpperCase() || "U";
}

function presenceStatus(peer: PresencePeer) {
  const typing = peer.typingAt && Date.now() - peer.typingAt <= TYPING_FRESHNESS_MS;
  if (!peer.connected) return "Left just now";
  if (typing) return "Typing now";
  return "Viewing";
}

function snapshotChangeSummary(snapshot: SnapshotSummary) {
  const noun = snapshot.update_count === 1 ? "update" : "updates";
  if (snapshot.update_count <= 0) return `0 ${noun}`;
  if (snapshot.update_start_seq === snapshot.last_seq) return `1 ${noun} · seq ${snapshot.last_seq}`;
  return `${snapshot.update_count} ${noun} · seq ${snapshot.update_start_seq}-${snapshot.last_seq}`;
}

type DiffLine = {
  kind: "same" | "added" | "removed";
  text: string;
  beforeLine?: number;
  afterLine?: number;
};

type LineDiff = {
  lines: DiffLine[];
  truncated: boolean;
};

function buildLineDiff(before: string, after: string): LineDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  if (beforeLines.length * afterLines.length > 120000) {
    return { lines: [], truncated: true };
  }

  const rows = beforeLines.length + 1;
  const cols = afterLines.length + 1;
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
  for (let i = beforeLines.length - 1; i >= 0; i--) {
    for (let j = afterLines.length - 1; j >= 0; j--) {
      table[i][j] =
        beforeLines[i] === afterLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let beforeLine = 1;
  let afterLine = 1;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      lines.push({ kind: "same", text: beforeLines[i], beforeLine, afterLine });
      i++;
      j++;
      beforeLine++;
      afterLine++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ kind: "removed", text: beforeLines[i], beforeLine });
      i++;
      beforeLine++;
    } else {
      lines.push({ kind: "added", text: afterLines[j], afterLine });
      j++;
      afterLine++;
    }
  }
  for (; i < beforeLines.length; i++, beforeLine++) {
    lines.push({ kind: "removed", text: beforeLines[i], beforeLine });
  }
  for (; j < afterLines.length; j++, afterLine++) {
    lines.push({ kind: "added", text: afterLines[j], afterLine });
  }
  return { lines, truncated: false };
}

function splitLines(value: string) {
  if (value.length === 0) return [];
  return value.split(/\r?\n/);
}

function SnapshotDiffView({ diff, onShowSnapshot }: { diff: LineDiff; onShowSnapshot: () => void }) {
  if (diff.truncated) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
        <p className="opacity-70">This document is large enough that inline diffing is skipped.</p>
        <button
          onClick={onShowSnapshot}
          className="rounded-md border border-current/15 px-3 py-1.5 hover:bg-current/5"
        >
          Show snapshot
        </button>
      </div>
    );
  }
  if (diff.lines.length === 0) {
    return <p className="p-4 text-sm opacity-70">Snapshot and current editor text match.</p>;
  }
  return (
    <div className="max-h-[26rem] overflow-auto text-sm">
      {diff.lines.map((line, index) => (
        <div
          key={`${index}-${line.kind}`}
          className={`grid grid-cols-[4rem_1fr] border-b border-current/5 font-mono ${
            line.kind === "added"
              ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100"
              : line.kind === "removed"
                ? "bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100"
                : ""
          }`}
        >
          <span className="select-none border-r border-current/10 px-2 py-1 text-right text-xs opacity-50">
            {line.kind === "added" ? line.afterLine : line.beforeLine}
          </span>
          <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-1">
            <span className="select-none opacity-50">{line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}</span>
            {line.text || " "}
          </pre>
        </div>
      ))}
    </div>
  );
}

function formatSnapshotDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function filenameFromDisposition(disposition: string) {
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? "";
}

function DocumentSidebar({
  docs,
  ownerID,
  currentDocID,
  loadFailed,
  collapsed,
  onCollapsedChange,
}: {
  docs: Document[];
  ownerID: string;
  currentDocID: string;
  loadFailed: boolean;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const myDocs = docs.filter((doc) => doc.owner_id === ownerID);
  const sharedDocs = docs.filter((doc) => doc.owner_id !== ownerID);

  return (
    <aside
      className={`no-print hidden shrink-0 overflow-hidden border-r border-current/10 bg-current/[0.025] transition-[width] duration-200 ease-out md:flex md:flex-col ${
        collapsed ? "w-11" : "w-64"
      }`}
    >
      <div
        className={`flex items-center border-b border-current/10 py-2 transition-[padding] duration-200 ease-out ${
          collapsed ? "justify-center px-1" : "justify-between gap-2 px-3"
        }`}
      >
        <h2
          className={`overflow-hidden whitespace-nowrap text-xs font-semibold uppercase tracking-wide transition-[max-width,opacity] duration-150 ${
            collapsed ? "pointer-events-none max-w-0 opacity-0" : "max-w-40 opacity-60"
          }`}
        >
          Documents
        </h2>
        <button
          onClick={() => onCollapsedChange(!collapsed)}
          title={collapsed ? "Show documents" : "Hide documents"}
          aria-label={collapsed ? "Show documents" : "Hide documents"}
          className="flex h-7 w-7 items-center justify-center rounded-full text-current/60 hover:bg-current/10 hover:text-current"
        >
          <span aria-hidden className="text-base leading-none">{collapsed ? "›" : "‹"}</span>
        </button>
      </div>
      <div
        className={`min-h-0 flex-1 overflow-y-auto px-2 py-3 transition-opacity duration-150 ${
          collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-75"
        }`}
      >
        {loadFailed && (
          <p className="mb-3 rounded-md border border-current/15 bg-current/[0.04] px-2 py-1.5 text-xs opacity-70">
            Couldn&apos;t load your other documents.
          </p>
        )}
        <DocumentSidebarSection
          title="My Docs"
          docs={myDocs}
          currentDocID={currentDocID}
          emptyText="No documents yet."
        />
        <DocumentSidebarSection
          title="Shared with me"
          docs={sharedDocs}
          currentDocID={currentDocID}
          emptyText="No shared documents."
        />
      </div>
    </aside>
  );
}

function DocumentSidebarSection({
  title,
  docs,
  currentDocID,
  emptyText,
}: {
  title: string;
  docs: Document[];
  currentDocID: string;
  emptyText: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = docs.length > 5;

  return (
    <section className="mb-5 last:mb-0">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h3 className="text-xs font-medium uppercase tracking-wide opacity-55">{title}</h3>
        <span className="text-[10px] opacity-45">{docs.length}</span>
      </div>
      {docs.length === 0 ? (
        <p className="px-1 py-2 text-xs opacity-50">{emptyText}</p>
      ) : (
        <>
          <div className={`relative ${expanded ? "max-h-64 overflow-y-auto pr-1" : "max-h-44 overflow-hidden"}`}>
            <ul className="space-y-1">
              {docs.map((doc) => {
                const active = doc.id === currentDocID;
                return (
                  <li key={doc.id}>
                    <Link
                      href={`/d/${doc.id}`}
                      aria-current={active ? "page" : undefined}
                      className={`block rounded-md px-2 py-1.5 text-sm transition ${
                        active
                          ? "bg-current/10 font-medium"
                          : "text-current/75 hover:bg-current/5 hover:text-current"
                      }`}
                    >
                      <span className="block truncate">{doc.title || "Untitled"}</span>
                      <span className="block truncate text-[10px] opacity-45">v{doc.current_version}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
            {canExpand && !expanded && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-b from-transparent to-white dark:to-neutral-950" />
            )}
          </div>
          {canExpand && (
            <button
              onClick={() => setExpanded((value) => !value)}
              className="mt-2 w-full rounded-md border border-current/10 px-2 py-1 text-xs font-medium text-current/70 hover:bg-current/5 hover:text-current"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

// IconBtn — uniform 32×32 hover-tinted icon button. Every action in the
// editor topbar wears the same style; no "accent" variants — UI/UX uniformity
// reads as polish at a glance, where one filled circle reads as inconsistent.
function IconBtn({
  onClick,
  title,
  disabled,
  className,
  children,
}: {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex h-8 w-8 items-center justify-center rounded-full text-current/70 transition hover:bg-current/10 hover:text-current disabled:opacity-50${className ? ` ${className}` : ""}`}
    >
      {children}
    </button>
  );
}

function MobileActionsMenu({
  publishState,
  onPublish,
  onShare,
  onExport,
  onPrint,
  onHistory,
  onReview,
}: {
  publishState: "idle" | "saving" | "saved" | "error";
  onPublish: () => void;
  onShare: () => void;
  onExport: () => void;
  onPrint: () => void;
  onHistory: () => void;
  onReview: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const item = (label: string, onClick: () => void, icon: ReactNode, disabled?: boolean) => (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        setOpen(false);
        onClick();
      }}
      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-current/5 disabled:opacity-50"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-current/70">{icon}</span>
      <span>{label}</span>
    </button>
  );

  return (
    <div ref={rootRef} className="relative md:hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Document actions"
        aria-label="Document actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex h-8 w-8 items-center justify-center rounded-full text-current/70 transition hover:bg-current/10 hover:text-current"
      >
        <MenuIcon className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <div
          role="menu"
          className="fixed right-2 top-12 z-50 mt-1 w-[min(16rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-current/10 bg-white shadow-xl dark:bg-neutral-950"
        >
          {item(
            publishState === "saving" ? "Publishing…" : "Publish snapshot",
            onPublish,
            <CloudUpIcon className={`h-[18px] w-[18px] ${publishIconClass(publishState)}`} />,
            publishState === "saving",
          )}
          {item("Share document", onShare, <ShareIcon className="h-[18px] w-[18px]" />)}
          {item("Export Markdown", onExport, <DownloadIcon className="h-[18px] w-[18px]" />)}
          {item("Comments", onReview, <MessageSquareIcon className="h-[18px] w-[18px]" />)}
          {item("Print", onPrint, <PrinterIcon className="h-[18px] w-[18px]" />)}
          {item("Version history", onHistory, <HistoryIcon className="h-[18px] w-[18px]" />)}
        </div>
      )}
    </div>
  );
}

function ServerSaveStatus({ state }: { state: SaveState }) {
  const map = {
    saving: {
      label: "Saving…",
      className: "text-neutral-500 dark:text-neutral-400",
      icon: <SpinnerIcon className="h-[18px] w-[18px] animate-spin" />,
    },
    saved: {
      label: "Saved",
      className: "text-emerald-600 dark:text-emerald-400",
      icon: <CheckIcon className="h-[17px] w-[17px]" />,
    },
    offline: {
      label: "Offline",
      className: "text-amber-600 dark:text-amber-400",
      icon: <CloudOffIcon className="h-[18px] w-[18px]" />,
    },
  } as const;
  const s = map[state];
  return (
    <span
      role="status"
      aria-label={s.label}
      title={s.label}
      className={`flex h-7 w-7 shrink-0 items-center justify-center ${s.className}`}
    >
      {s.icon}
    </span>
  );
}

function publishIconClass(state: "idle" | "saving" | "saved" | "error") {
  if (state === "saved") return "text-emerald-600 dark:text-emerald-400";
  if (state === "error") return "text-red-600 dark:text-red-400";
  if (state === "saving") return "animate-pulse text-neutral-600 dark:text-neutral-300";
  return "";
}

function useDarkClass() {
  const [dark, setDark] = useState(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// Hast nodes carry source position; we use it to anchor preview blocks and
// inline text back to markdown source offsets.
type MdNode = {
  type?: string;
  value?: string;
  tagName?: string;
  children?: MdNode[];
  properties?: Record<string, unknown>;
  position?: { start: { line: number; offset?: number }; end?: { offset?: number } };
};
const dl = (node: unknown) => (node as MdNode).position?.start.line;
const ds = (node: unknown) => (node as MdNode).position?.start.offset;
const de = (node: unknown) => (node as MdNode).position?.end?.offset;

function previewElementForLine(container: HTMLElement, line: number) {
  const elements = Array.from(container.querySelectorAll<HTMLElement>("[data-line]"));
  let previous: HTMLElement | null = null;
  for (const el of elements) {
    const sourceLine = Number(el.dataset.line);
    if (!Number.isFinite(sourceLine)) continue;
    if (sourceLine === line) return el;
    if (sourceLine > line) return previous ?? el;
    previous = el;
  }
  return previous;
}

function scrollPreviewToLine(container: HTMLElement | null, line: number) {
  if (!container) return;
  const target = previewElementForLine(container, line);
  if (!target) return;
  const targetRect = target.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const top = targetRect.top - containerRect.top + container.scrollTop - container.clientHeight * 0.35;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

function markPreviewSourceText(node: MdNode) {
  if (node.type === "text" && typeof node.value === "string") {
    const start = ds(node);
    const end = de(node);
    if (typeof start === "number" && typeof end === "number" && end > start) {
      return {
        type: "element",
        tagName: "span",
        properties: {
          "data-source-start": String(start),
          "data-source-end": String(end),
          "data-source-text": node.value,
        },
        children: [node],
      } satisfies MdNode;
    }
    return node;
  }
  if (Array.isArray(node.children)) {
    node.children = node.children.map((child) => markPreviewSourceText(child));
  }
  return node;
}

function rehypeSourceTextSpans() {
  return (tree: MdNode) => {
    markPreviewSourceText(tree);
  };
}

function clearPreviewCommentHighlight(container: HTMLElement | null) {
  if (!container) return;
  for (const el of container.querySelectorAll<HTMLElement>("[data-source-text]")) {
    el.textContent = el.dataset.sourceText ?? "";
  }
}

function highlightPreviewCommentRange(container: HTMLElement | null, anchor: ResolvedCommentAnchor | null) {
  if (!container || anchor?.from === null || anchor?.from === undefined) return;
  const start = anchor.from;
  const end = anchor.to ?? anchor.from;
  const spans = Array.from(container.querySelectorAll<HTMLElement>("[data-source-start][data-source-end]"));
  let marked = false;
  for (const span of spans) {
    const spanStart = Number(span.dataset.sourceStart);
    const spanEnd = Number(span.dataset.sourceEnd);
    const sourceText = span.dataset.sourceText ?? span.textContent ?? "";
    if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) continue;
    let overlapStart = Math.max(start, spanStart);
    let overlapEnd = Math.min(end, spanEnd);
    if (end <= start) {
      if (!(spanStart <= start && spanEnd > start)) continue;
      overlapStart = start;
      overlapEnd = Math.min(spanEnd, start + 1);
    } else if (!(spanStart < end && spanEnd > start)) {
      continue;
    }
    const localStart = Math.max(0, overlapStart - spanStart);
    const localEnd = Math.max(localStart, Math.min(sourceText.length, overlapEnd - spanStart));
    if (localEnd <= localStart) continue;
    span.replaceChildren();
    if (localStart > 0) span.append(document.createTextNode(sourceText.slice(0, localStart)));
    const mark = document.createElement("span");
    mark.className = "preview-comment-hl";
    mark.textContent = sourceText.slice(localStart, localEnd);
    span.append(mark);
    if (localEnd < sourceText.length) span.append(document.createTextNode(sourceText.slice(localEnd)));
    marked = true;
  }
  if (!marked && anchor.line) {
    previewElementForLine(container, anchor.line)?.classList.add("preview-comment-hl");
  }
}

function applyCommentHighlight(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco | null,
  collectionRef: React.MutableRefObject<Monaco.editor.IEditorDecorationsCollection | null>,
  anchor: ResolvedCommentAnchor | null,
  scroll: boolean,
) {
  const model = editor.getModel();
  if (!monaco || !model || !collectionRef.current) return;
  if (!anchor?.line) {
    collectionRef.current.set([]);
    return;
  }
  const start = anchor.from ?? model.getOffsetAt({ lineNumber: Math.max(1, anchor.line), column: 1 });
  const end = anchor.to !== null && anchor.to > start ? anchor.to : Math.min(model.getValueLength(), start + 1);
  const startPos = model.getPositionAt(start);
  const endPos = model.getPositionAt(end);
  const range = new monaco.Range(startPos.lineNumber, startPos.column, endPos.lineNumber, endPos.column);
  collectionRef.current.set([{
    range,
    options: { inlineClassName: "monaco-comment-range-hl" },
  }]);
  if (!scroll) return;
  const layout = editor.getLayoutInfo();
  const targetTop = editor.getTopForLineNumber(startPos.lineNumber) - layout.height / 2;
  smoothScrollEditor(editor, Math.max(0, targetTop));
}

function smoothScrollEditor(editor: Monaco.editor.IStandaloneCodeEditor, target: number) {
  const start = editor.getScrollTop();
  const distance = target - start;
  if (Math.abs(distance) < 2) {
    editor.setScrollTop(target);
    return;
  }
  const duration = Math.min(700, 250 + Math.abs(distance) * 0.4);
  const t0 = performance.now();
  const ease = (t: number) => 1 - Math.pow(1 - t, 3);
  const step = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    editor.setScrollTop(start + distance * ease(t));
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

type AssetUploadOpts = {
  canUpload: () => boolean;
  onError: (msg: string) => void;
};

const ALLOWED_ASSET_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);
const ASSET_MAX_BYTES = 8 * 1024 * 1024;

function blameColorToken(color: string) {
  const token = color.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return token || "neutral";
}

async function uploadAndInsertImagesMonaco(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  docId: string,
  rawFiles: File[],
  opts: AssetUploadOpts,
  offset?: number,
) {
  const model = editor.getModel();
  if (!model || !monaco) return;
  if (!opts.canUpload()) {
    opts.onError("You don't have edit access on this document.");
    return;
  }
  const accepted: File[] = [];
  for (const f of rawFiles) {
    if (!ALLOWED_ASSET_TYPES.has(f.type)) {
      opts.onError(`Unsupported file type: ${f.type || f.name}`);
      continue;
    }
    if (f.size > ASSET_MAX_BYTES) {
      opts.onError(`${f.name} is larger than the 8 MiB upload cap.`);
      continue;
    }
    accepted.push(f);
  }
  for (const file of accepted) {
    const placeholder = `\n![uploading ${file.name}…]()\n`;
    const at = offset ?? model.getOffsetAt(editor.getPosition() ?? new monaco.Position(1, 1));
    const start = model.getPositionAt(at);
    editor.executeEdits("syncscribe-asset-upload", [{
      range: new monaco.Range(start.lineNumber, start.column, start.lineNumber, start.column),
      text: placeholder,
      forceMoveMarkers: true,
    }]);
    const placeholderStart = at;
    const placeholderEnd = at + placeholder.length;
    editor.setPosition(model.getPositionAt(placeholderEnd));
    try {
      const res = await api.uploadAsset(docId, file);
      const alt = file.name.replace(/[\[\]]/g, "") || "image";
      const md = `![${alt}](${res.url})`;
      replaceEditorText(editor, monaco, placeholderStart, placeholderEnd, md);
    } catch (err) {
      replaceEditorText(editor, monaco, placeholderStart, placeholderEnd, "");
      const msg = err instanceof Error ? err.message : "Upload failed.";
      opts.onError(`${file.name}: ${msg}`);
    }
  }
}

function replaceEditorText(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  from: number,
  to: number,
  text: string,
) {
  const model = editor.getModel();
  if (!model || !monaco) return;
  const start = model.getPositionAt(from);
  const end = model.getPositionAt(to);
  editor.executeEdits("syncscribe-asset-upload", [{
    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
    text,
    forceMoveMarkers: true,
  }]);
}

// AuthedImg renders <img> for markdown URLs that point at our authed asset
// endpoint. The browser cannot send a Bearer token from a plain `src`, so we
// fetch the asset, convert to a blob URL, and swap it in. Non-asset URLs
// (external images) pass through unchanged.
function AuthedImg({ docId, src, alt, ...rest }: { docId: string; src?: string; alt?: string } & React.ImgHTMLAttributes<HTMLImageElement>) {
  const [asset, setAsset] = useState<{ src: string; resolved?: string; failed: boolean }>({
    src: "",
    resolved: undefined,
    failed: false,
  });
  const assetMatch = src?.match(/\/api\/documents\/([^/]+)\/assets\/([^/?#]+)/);
  const shouldFetch = !!assetMatch && assetMatch[1] === docId;
  const resolved = shouldFetch ? (asset.src === src ? asset.resolved : undefined) : src;
  const failed = shouldFetch ? asset.src === src && asset.failed : false;

  useEffect(() => {
    if (!src || !assetMatch || !shouldFetch) return;
    let alive = true;
    let blob: string | null = null;
    const [, , assetId] = assetMatch;
    (async () => {
      try {
        const u = await api.fetchAssetBlobURL(docId, assetId);
        if (!alive) {
          URL.revokeObjectURL(u);
          return;
        }
        blob = u;
        setAsset({ src, resolved: u, failed: false });
      } catch {
        if (alive) setAsset({ src, resolved: undefined, failed: true });
      }
    })();
    return () => {
      alive = false;
      if (blob) URL.revokeObjectURL(blob);
    };
  }, [assetMatch, docId, shouldFetch, src]);

  if (failed) return <span className="text-xs opacity-60">[image failed to load]</span>;
  if (!resolved) return <span className="text-xs opacity-60">Loading image…</span>;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={resolved} alt={alt ?? ""} {...rest} />;
}

const markdownComponents: Components = {
  pre({ node, children, ...props }) {
    if (isMermaidCodeChild(children)) return <>{children}</>;
    return <pre data-line={dl(node)} {...props}>{children}</pre>;
  },
  code({ node: _node, className, children, ...props }) {
    const source = String(children).replace(/\n$/, "");
    if (/\blanguage-mermaid\b/.test(className ?? "")) {
      return <MermaidDiagram source={source} />;
    }
    return <code className={className} {...props}>{children}</code>;
  },
  p({ node, children, ...props }) { return <p data-line={dl(node)} {...props}>{children}</p>; },
  h1({ node, children, ...props }) { return <h1 data-line={dl(node)} {...props}>{children}</h1>; },
  h2({ node, children, ...props }) { return <h2 data-line={dl(node)} {...props}>{children}</h2>; },
  h3({ node, children, ...props }) { return <h3 data-line={dl(node)} {...props}>{children}</h3>; },
  h4({ node, children, ...props }) { return <h4 data-line={dl(node)} {...props}>{children}</h4>; },
  h5({ node, children, ...props }) { return <h5 data-line={dl(node)} {...props}>{children}</h5>; },
  h6({ node, children, ...props }) { return <h6 data-line={dl(node)} {...props}>{children}</h6>; },
  blockquote({ node, children, ...props }) { return <blockquote data-line={dl(node)} {...props}>{children}</blockquote>; },
  ul({ node, children, ...props }) { return <ul data-line={dl(node)} {...props}>{children}</ul>; },
  ol({ node, children, ...props }) { return <ol data-line={dl(node)} {...props}>{children}</ol>; },
  table({ node, children, ...props }) { return <table data-line={dl(node)} {...props}>{children}</table>; },
};

function isMermaidCodeChild(children: ReactNode) {
  if (!isValidElement(children)) return false;
  const props = children.props as { className?: unknown };
  return typeof props.className === "string" && /\blanguage-mermaid\b/.test(props.className);
}

function MermaidDiagram({ source }: { source: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const isDark = useDarkClass();
  const renderKey = `${isDark ? "dark" : "light"}\n${source}`;
  const [rendered, setRendered] = useState<{ key: string; svg: string; failed: boolean }>({
    key: "",
    svg: "",
    failed: false,
  });
  const svg = rendered.key === renderKey ? rendered.svg : "";
  const failed = rendered.key === renderKey && rendered.failed;

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "base",
          themeVariables: isDark
            ? {
                lineColor: "#d4d4d8",
                primaryTextColor: "#f5f5f5",
                primaryBorderColor: "#a3a3a3",
                edgeLabelBackground: "#171717",
                actorLineColor: "#d4d4d8",
                signalColor: "#d4d4d8",
                signalTextColor: "#f5f5f5",
              }
            : undefined,
        });
        const result = await mermaid.render(`mermaid-${id}`, source);
        if (alive) setRendered({ key: renderKey, svg: result.svg, failed: false });
      } catch {
        if (alive) setRendered({ key: renderKey, svg: "", failed: true });
      }
    })();

    return () => {
      alive = false;
    };
  }, [id, isDark, renderKey, source]);

  if (failed) {
    return <pre className="mermaid-fallback"><code>{source}</code></pre>;
  }
  if (!svg) {
    return <div className="mermaid-loading">Rendering diagram…</div>;
  }
  return <div className="mermaid-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}

let mermaidLoad: Promise<MermaidAPI> | null = null;

function loadMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoad) return mermaidLoad;

  mermaidLoad = new Promise<MermaidAPI>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>("script[data-syncscribe-mermaid]");
    if (existing) {
      existing.addEventListener("load", () => {
        if (window.mermaid) resolve(window.mermaid);
        else reject(new Error("mermaid unavailable"));
      }, { once: true });
      existing.addEventListener("error", () => reject(new Error("mermaid load failed")), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js";
    script.async = true;
    script.dataset.syncscribeMermaid = "true";
    script.onload = () => {
      if (window.mermaid) resolve(window.mermaid);
      else reject(new Error("mermaid unavailable"));
    };
    script.onerror = () => reject(new Error("mermaid load failed"));
    document.head.appendChild(script);
  });

  return mermaidLoad;
}

// --- Comments panel, context menu, and comment input popup ---

function CommentsPanel({
  panelRef,
  comments,
  error,
  selectedCommentId,
  onClose,
  onResolve,
  onDelete,
  onSelect,
}: {
  panelRef: React.RefObject<HTMLElement | null>;
  comments: DocumentComment[];
  error: string;
  selectedCommentId: string | null;
  onClose: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string, label: string) => void;
  onSelect: (id: string) => void;
}) {
  const open = comments.filter((c) => !c.resolved_at);
  const resolved = comments.filter((c) => !!c.resolved_at);

  return (
    <aside ref={panelRef} data-comment-panel className="no-print flex w-72 shrink-0 flex-col border-l border-current/10 bg-white dark:bg-neutral-950 xl:w-80">
      <div className="flex shrink-0 items-center justify-between border-b border-current/10 px-4 py-3">
        <h2 className="text-sm font-semibold">Comments</h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-current/50 hover:bg-current/10 hover:text-current"
          aria-label="Close comments"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {error && (
        <p className="mx-3 mt-2 shrink-0 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-400">{error}</p>
      )}

      {comments.length === 0 && !error && (
        <div className="flex flex-1 items-center justify-center">
          <div className="py-8 text-center">
            <p className="text-sm opacity-50">No comments yet.</p>
            <p className="mt-1 text-xs opacity-40">Right-click in the editor to add one.</p>
          </div>
        </div>
      )}

      {open.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div className="space-y-3">
            {open.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selected={selectedCommentId === c.id}
                onSelect={() => onSelect(c.id)}
                onResolve={onResolve}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="shrink-0 overflow-y-auto border-t border-current/10" style={{ maxHeight: "40%" }}>
          <p className="px-4 pb-1 pt-3 text-xs font-medium uppercase tracking-wide opacity-40">Resolved</p>
          <div className="space-y-2 px-3 pb-3">
            {resolved.map((c) => (
              <CommentCard
                key={c.id}
                comment={c}
                selected={selectedCommentId === c.id}
                onSelect={() => onSelect(c.id)}
                onResolve={onResolve}
                onDelete={onDelete}
              />
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}

function CommentCard({
  comment,
  selected,
  onSelect,
  onResolve,
  onDelete,
}: {
  comment: DocumentComment;
  selected: boolean;
  onSelect: () => void;
  onResolve: (id: string) => void;
  onDelete: (id: string, label: string) => void;
}) {
  const initials = (comment.author_name || "?")
    .split(" ")
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const anchorLabel = comment.anchor_text || (comment.line_number ? `line ${comment.line_number}` : "");
  const deleteLabel = comment.anchor_text ? `"${comment.anchor_text}"` : comment.body;

  return (
    <div
      className={`rounded-lg border p-3 text-sm transition-all cursor-pointer ${
        selected
          ? "border-indigo-400 bg-indigo-50/60 shadow-sm dark:border-indigo-600 dark:bg-indigo-950/30"
          : "border-current/10 hover:border-current/20"
      } ${comment.resolved_at ? "opacity-50" : ""}`}
      onClick={onSelect}
    >
      <div className="mb-2 flex items-start gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-[10px] font-bold text-indigo-700 dark:bg-indigo-900/50 dark:text-indigo-300">
          {initials}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium leading-tight">{comment.author_name}</span>
            {anchorLabel && (
              <span className="rounded bg-current/8 px-1.5 py-0.5 text-[10px] font-mono opacity-70">
                {comment.anchor_text ? `"${comment.anchor_text}"` : anchorLabel}
              </span>
            )}
            {comment.kind === "suggestion" && (
              <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                suggestion
              </span>
            )}
          </div>
          <p className="text-[11px] opacity-50 leading-tight mt-0.5">
            {new Date(comment.created_at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
          </p>
        </div>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">{comment.body}</p>
      <div className="mt-2 flex items-center gap-2">
        {!comment.resolved_at ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onResolve(comment.id);
            }}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-950/30"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            Resolve
          </button>
        ) : (
          <p className="flex items-center gap-1 text-xs opacity-40">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden><path d="M20 6 9 17l-5-5" /></svg>
            Resolved
          </p>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(comment.id, deleteLabel);
          }}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden>
            <path d="M3 6h18" />
            <path d="M8 6V4h8v2" />
            <path d="M19 6l-1 14H6L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
          Delete
        </button>
      </div>
    </div>
  );
}

function EditorContextMenu({
  x,
  y,
  onAddComment,
  onAddSuggestion,
  onInsertImage,
  canInsertImage,
  onClose: _onClose,
}: {
  x: number;
  y: number;
  onAddComment: () => void;
  onAddSuggestion: () => void;
  onInsertImage: () => void;
  canInsertImage: boolean;
  onClose: () => void;
}) {
  // Clamp to viewport so menu never clips off screen.
  const menuW = 192;
  const menuH = 120;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <div
      className="fixed z-50 min-w-48 overflow-hidden rounded-lg border border-current/10 bg-white py-1 shadow-lg dark:bg-neutral-900"
      style={{ left, top }}
    >
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5"
        onClick={onAddComment}
      >
        <MessageSquareIcon className="h-4 w-4 opacity-60" />
        Add comment
      </button>
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5"
        onClick={onAddSuggestion}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 opacity-60" aria-hidden>
          <path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
        Suggest edit
      </button>
      <div className="my-1 border-t border-current/10" />
      <button
        className="flex w-full items-center gap-2.5 px-3 py-2 text-sm hover:bg-current/5 disabled:cursor-not-allowed disabled:opacity-50"
        onClick={onInsertImage}
        disabled={!canInsertImage}
        title={canInsertImage ? "" : "You don't have edit access on this document"}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 opacity-60" aria-hidden>
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
        Insert image…
      </button>
    </div>
  );
}

function CommentInputPopup({
  x,
  y,
  anchor,
  kind,
  body,
  submitting,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  x: number;
  y: number;
  anchor: CommentAnchorDraft;
  kind: "comment" | "suggestion";
  body: string;
  submitting: boolean;
  error: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const popupW = 304;
  const popupH = 160;
  const left = Math.min(x + 8, window.innerWidth - popupW - 8);
  const top = Math.min(y, window.innerHeight - popupH - 8);
  const anchorLabel = anchor.anchor_text || `line ${anchor.line}`;

  return (
    <div
      className="fixed z-50 w-76 rounded-xl border border-current/10 bg-white p-3 shadow-xl dark:bg-neutral-900"
      style={{ left, top, width: popupW }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-2">
        <span className="text-xs font-medium capitalize opacity-70">{kind}</span>
        <span className="rounded bg-current/8 px-1.5 py-0.5 font-mono text-[10px] opacity-60">
          {anchorLabel}
        </span>
        {anchor.anchor_text && (
          <span className="rounded bg-current/8 px-1.5 py-0.5 font-mono text-[10px] opacity-60">
            selection
          </span>
        )}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); if (body.trim()) onSubmit(); }
          if (e.key === "Escape") onCancel();
        }}
        rows={3}
        placeholder={kind === "suggestion" ? "Describe your suggested change…" : "Add a comment…"}
        className="w-full resize-none rounded-lg border border-current/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-indigo-400 dark:focus:border-indigo-500"
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1.5 text-sm opacity-60 hover:opacity-100"
        >
          Cancel
        </button>
        <button
          onClick={onSubmit}
          disabled={!body.trim() || submitting}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {submitting ? "Saving…" : kind === "suggestion" ? "Add suggestion" : "Comment"}
        </button>
      </div>
    </div>
  );
}

const presenceColors = [
  { color: "#2563eb", light: "#bfdbfe" },
  { color: "#16a34a", light: "#bbf7d0" },
  { color: "#dc2626", light: "#fecaca" },
  { color: "#9333ea", light: "#e9d5ff" },
  { color: "#ea580c", light: "#fed7aa" },
  { color: "#0891b2", light: "#cffafe" },
  { color: "#be123c", light: "#ffe4e6" },
  { color: "#4f46e5", light: "#c7d2fe" },
  { color: "#65a30d", light: "#d9f99d" },
  { color: "#c026d3", light: "#f5d0fe" },
  { color: "#0d9488", light: "#ccfbf1" },
  { color: "#ca8a04", light: "#fef08a" },
] as const;

function colorForUser(userID: string) {
  let hash = 0;
  for (const ch of userID) {
    hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  }
  return presenceColors[hash % presenceColors.length];
}
