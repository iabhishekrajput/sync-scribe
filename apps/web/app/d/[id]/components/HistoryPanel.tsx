"use client";

import { useEffect, useMemo, useState } from "react";

import { api, type SnapshotBody, type SnapshotSummary } from "../../../lib/api";
import { buildLineDiff, type LineDiff } from "../../../lib/lineDiff";
import { notifyError } from "../../../lib/errors";
import { Modal } from "../../../components/Modal";

// Owns the version-history state: snapshot list, selection, body fetch, and
// branch-not-overwrite restore. The page only supplies the live editor text
// (for the diff) and learns about restores via onRestored.
export function HistoryModal({
  open,
  onClose,
  docId,
  currentBody,
  canRestore,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  currentBody: string;
  canRestore: boolean;
  onRestored: (title: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState(0);
  const [snapshotBody, setSnapshotBody] = useState<SnapshotBody | null>(null);
  const [view, setView] = useState<"preview" | "diff">("diff");
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const list = await api.listSnapshots(docId);
        if (!alive) return;
        setSnapshots(list);
        const nextIndex = Math.max(list.length - 1, 0);
        setSelectedSnapshot(nextIndex);
        setView("diff");
        if (list[nextIndex]) {
          const body = await api.getSnapshot(docId, list[nextIndex].version);
          if (alive) setSnapshotBody(body);
        } else {
          setSnapshotBody(null);
        }
      } catch (err) {
        if (alive) notifyError(err, "open-history");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    // Reset to the loading state in cleanup so the next open shows the
    // skeleton, without a synchronous setState in the effect body.
    return () => {
      alive = false;
      setLoading(true);
    };
  }, [docId, open]);

  const diff = useMemo(
    () => buildLineDiff(snapshotBody?.can_preview ? snapshotBody.body : "", currentBody),
    [snapshotBody, currentBody],
  );

  async function chooseSnapshot(index: number) {
    setSelectedSnapshot(index);
    setSnapshotBody(null);
    const snap = snapshots[index];
    if (!snap) return;
    try {
      setSnapshotBody(await api.getSnapshot(docId, snap.version));
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
      const res = await api.restoreSnapshot(docId, snap.version);
      onRestored(res.document.title);
      onClose();
    } catch (err) {
      notifyError(err, "restore-snapshot");
    } finally {
      setRestoring(false);
    }
  }

  const selectedSnapshotSummary = snapshots[selectedSnapshot];
  return (
    <Modal open={open} onClose={onClose} title="Version history" width="max-w-5xl">
      <div>
        {loading ? (
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
                    onClick={() => setView("diff")}
                    className={`min-w-24 rounded px-3 py-1.5 ${
                      view === "diff" ? "bg-black text-white dark:bg-white dark:text-black" : "hover:bg-current/5"
                    }`}
                  >
                    Diff
                  </button>
                  <button
                    onClick={() => setView("preview")}
                    className={`min-w-24 rounded px-3 py-1.5 ${
                      view === "preview" ? "bg-black text-white dark:bg-white dark:text-black" : "hover:bg-current/5"
                    }`}
                  >
                    Snapshot
                  </button>
                </div>
                <button
                  onClick={restoreSelectedSnapshot}
                  disabled={restoring || !canRestore}
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
                ) : view === "preview" ? (
                  <pre className="max-h-[26rem] overflow-auto whitespace-pre-wrap p-4 text-sm">{snapshotBody.body}</pre>
                ) : (
                  <SnapshotDiffView diff={diff} onShowSnapshot={() => setView("preview")} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
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

function snapshotChangeSummary(snapshot: SnapshotSummary) {
  const noun = snapshot.update_count === 1 ? "update" : "updates";
  if (snapshot.update_count <= 0) return `0 ${noun}`;
  if (snapshot.update_start_seq === snapshot.last_seq) return `1 ${noun} · seq ${snapshot.last_seq}`;
  return `${snapshot.update_count} ${noun} · seq ${snapshot.update_start_seq}-${snapshot.last_seq}`;
}

function formatSnapshotDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
