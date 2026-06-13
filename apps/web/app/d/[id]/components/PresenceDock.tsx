"use client";

import { presenceInitial, presenceStatus, type PresencePeer } from "../../../lib/presence";

export function PresenceDock({
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

export function OffScreenCursorIndicators({
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
