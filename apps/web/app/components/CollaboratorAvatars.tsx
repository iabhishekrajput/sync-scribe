"use client";

import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness";
import { Avatar } from "./Avatar";

type Peer = {
  clientID: number;
  name: string;
  email?: string;
  color?: string;
  actor: string;
};

// Avatar strip that lives in the topbar. Shows everyone OTHER than the
// local user connected to this doc — the local user's identity is already
// communicated by the UserMenu avatar on the far right, and Google Docs'
// strip works the same way (self isn't doubled up).
export function CollaboratorAvatars({
  awareness,
  selfClientID,
}: {
  awareness: Awareness | null;
  selfClientID?: number;
}) {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    if (!awareness) return;
    const recompute = () => {
      const out: Peer[] = [];
      awareness.getStates().forEach((state, clientID) => {
        if (clientID === selfClientID) return; // never include self
        const user = state.user as
          | { name?: string; color?: string; email?: string; actor?: string }
          | undefined;
        if (!user) return;
        out.push({
          clientID,
          name: user.name || "Someone",
          email: user.email,
          color: user.color,
          actor: user.actor || "human",
        });
      });
      out.sort((a, b) => a.clientID - b.clientID);
      setPeers(out);
    };
    recompute();
    awareness.on("change", recompute);
    return () => awareness.off("change", recompute);
  }, [awareness, selfClientID]);

  if (peers.length === 0) return null;

  // Show up to 4 avatars; collapse the rest into a "+N" chip.
  const visible = peers.slice(0, 4);
  const overflow = peers.length - visible.length;

  return (
    <div className="flex items-center -space-x-1.5">
      {visible.map((p) => (
        <Tooltip key={p.clientID} label={p.name} sub={p.email}>
          <Avatar id={String(p.clientID)} name={p.name} color={p.color} size={28} ring />
        </Tooltip>
      ))}
      {overflow > 0 && (
        <Tooltip label={`${overflow} more`}>
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-current/15 text-[11px] font-semibold ring-2 ring-white dark:ring-neutral-900">
            +{overflow}
          </span>
        </Tooltip>
      )}
    </div>
  );
}

function Tooltip({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-40 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-neutral-900 px-2 py-1 text-[11px] text-white opacity-0 shadow-lg transition group-hover:opacity-100 dark:bg-neutral-100 dark:text-neutral-900"
      >
        <span className="block font-medium">{label}</span>
        {sub && <span className="block text-[10px] opacity-70">{sub}</span>}
      </span>
    </span>
  );
}
