"use client";

import { colorForUser, initials } from "../lib/avatar";

export type AvatarStatus = "live" | "syncing" | "connecting" | "readonly" | "offline";

type Props = {
  id?: string;
  name?: string;
  size?: number;
  color?: string;
  /** Highlight ring (used for the active user or "you" affordance). */
  ring?: boolean;
  className?: string;
  title?: string;
  /** Realtime status indicator rendered as a small dot on the avatar. */
  status?: AvatarStatus;
};

// Single avatar dot — colored circle with initials. Used in the topbar, in
// the collaborator strip, and inside the user-menu popover.
//
// `status` adds a small bottom-right pip whose color encodes the realtime
// connection state. Replaces the standalone "Live" pill so the topbar reads
// at a glance: who am I + how are we doing, in one widget.
export function Avatar({
  id,
  name,
  size = 28,
  color,
  ring,
  className = "",
  title,
  status,
}: Props) {
  const fill = color ?? colorForUser(id ?? name ?? "?").color;
  const dot = status ? STATUS_COLORS[status] : null;
  // Pip is roughly 1/3 of the avatar with a min of 8px.
  const dotSize = Math.max(8, Math.round(size / 3));

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      title={title}
    >
      <span
        role="img"
        aria-label={name ?? title ?? "user"}
        className={`inline-flex h-full w-full items-center justify-center rounded-full text-[11px] font-semibold uppercase tracking-tight text-white select-none ${
          ring ? "ring-2 ring-white shadow-sm dark:ring-neutral-900" : ""
        }`}
        style={{ background: fill }}
      >
        {initials(name)}
      </span>
      {dot && (
        <span
          aria-label={`status: ${status}`}
          className={`absolute bottom-0 right-0 rounded-full ring-2 ring-white dark:ring-neutral-950 ${dot.cls}`}
          style={{ width: dotSize, height: dotSize }}
        />
      )}
    </span>
  );
}

const STATUS_COLORS: Record<AvatarStatus, { cls: string }> = {
  live: { cls: "bg-emerald-500" },
  syncing: { cls: "bg-amber-500" },
  connecting: { cls: "bg-neutral-400" },
  readonly: { cls: "bg-sky-500" },
  offline: { cls: "bg-red-500" },
};
