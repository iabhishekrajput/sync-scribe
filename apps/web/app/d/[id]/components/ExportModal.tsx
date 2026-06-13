"use client";

import { useEffect, useState } from "react";

import { api } from "../../../lib/api";
import { getAccessToken, loginURL } from "../../../lib/auth";
import { ApiError, notifyError } from "../../../lib/errors";
import { Modal } from "../../../components/Modal";

type ExportStatus =
  | { state: "loading" }
  | { state: "none" }
  | { state: "current"; version: number; createdAt: string }
  | { state: "stale"; version: number; createdAt: string };

export type ExportBusy = "markdown" | "publish-markdown" | "pdf" | "";

// Owns export state. Snapshots are the export source — without one,
// /export?format=md 409s, so the modal offers publish-and-export and
// retries once through a fresh snapshot on 409.
export function ExportModal({
  open,
  onClose,
  docId,
  title,
  getBody,
  onPublishedSnapshot,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  title: string;
  getBody: () => string;
  onPublishedSnapshot: () => void;
}) {
  const [status, setStatus] = useState<ExportStatus>({ state: "loading" });
  const [busy, setBusy] = useState<ExportBusy>("");

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void refreshStatus(() => alive);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, open]);

  async function refreshStatus(alive: () => boolean = () => true) {
    setStatus({ state: "loading" });
    try {
      const list = await api.listSnapshots(docId);
      if (!alive()) return;
      const latest = list.at(-1);
      if (!latest) {
        setStatus({ state: "none" });
        return;
      }
      const body = await api.getSnapshot(docId, latest.version);
      if (!alive()) return;
      if (!body.can_preview) {
        setStatus({ state: "stale", version: latest.version, createdAt: latest.created_at });
        return;
      }
      setStatus({
        state: body.body === getBody() ? "current" : "stale",
        version: latest.version,
        createdAt: latest.created_at,
      });
    } catch (err) {
      if (!alive()) return;
      notifyError(err, "export-status");
      setStatus({ state: "none" });
    }
  }

  async function exportMarkdown(publishFirst: boolean) {
    const token = await getAccessToken();
    if (!token) {
      window.location.href = loginURL(`/d/${docId}`);
      return;
    }
    setBusy(publishFirst ? "publish-markdown" : "markdown");
    const doExport = async () =>
      fetch(api.exportMarkdownURL(docId), {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "include",
      });
    if (publishFirst) {
      try {
        await api.publishSnapshot(docId, getBody());
        onPublishedSnapshot();
      } catch (err) {
        setBusy("");
        notifyError(err, "publish-before-export");
        return;
      }
    }
    let res = await doExport();
    if (res.status === 409) {
      try {
        await api.publishSnapshot(docId, getBody());
        res = await doExport();
      } catch {
        // fall through to the error branch
      }
    }
    if (!res.ok) {
      setBusy("");
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
    setBusy("");
    void refreshStatus();
  }

  function exportPDF() {
    setBusy("pdf");
    onClose();
    window.setTimeout(() => {
      window.print();
      setBusy("");
    }, 50);
  }

  return (
    <Modal open={open} onClose={onClose} title="Export" width="max-w-2xl">
      <div className="space-y-4">
        <div className="rounded-lg border border-current/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold">Markdown snapshot</h3>
              <p className="mt-1 text-sm opacity-70">{exportStatusText(status)}</p>
            </div>
            <button
              onClick={() => void refreshStatus()}
              disabled={status.state === "loading"}
              className="rounded-md border border-current/15 px-3 py-1.5 text-sm hover:bg-current/5 disabled:opacity-50"
            >
              Refresh
            </button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => void exportMarkdown(false)}
              disabled={busy !== "" || status.state === "none" || status.state === "loading"}
              className="rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
            >
              {busy === "markdown" ? "Exporting..." : "Export latest snapshot"}
            </button>
            <button
              onClick={() => void exportMarkdown(true)}
              disabled={busy !== ""}
              className="rounded-md border border-current/15 px-3 py-2 text-sm hover:bg-current/5 disabled:opacity-50"
            >
              {busy === "publish-markdown" ? "Publishing..." : "Publish current editor and export"}
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
            disabled={busy !== ""}
            className="mt-4 rounded-md bg-black px-3 py-2 text-sm text-white disabled:opacity-50 dark:bg-white dark:text-black"
          >
            {busy === "pdf" ? "Opening..." : "Print or save PDF"}
          </button>
        </div>
      </div>
    </Modal>
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

function filenameFromDisposition(disposition: string) {
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return match?.[1] ?? "";
}
