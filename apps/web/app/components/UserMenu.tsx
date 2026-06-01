"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "../lib/auth";
import { Avatar, type AvatarStatus } from "./Avatar";

export type MeShape = {
  id: string;
  email: string;
  display_name: string;
};

// Avatar + click-popover replacing the bare email text. Mirrors Google Docs'
// account chip: small circle in the topbar, details (name + email) +
// account actions in the dropdown.
//
// `status`, if passed, is rendered as a colored pip on the avatar — it's the
// live realtime indicator (replaces the separate "● Live" pill).
export function UserMenu({
  me,
  status,
  onSignedOut,
}: {
  me: MeShape;
  status?: AvatarStatus;
  onSignedOut?: () => void;
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

  const name = me.display_name || me.email || me.id;

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center rounded-full p-0.5 hover:bg-current/10"
        aria-haspopup="menu"
        aria-expanded={open}
        title={status ? `${name} · ${status}` : name}
      >
        <Avatar id={me.id} name={name} size={32} ring status={status} />
      </button>

      {open && (
        <div
          role="menu"
          className="fixed right-2 top-12 z-50 mt-1 w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-current/10 bg-white shadow-xl dark:bg-neutral-950 sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-72"
        >
          <div className="flex items-center gap-3 border-b border-current/10 px-4 py-3">
            <Avatar id={me.id} name={name} size={40} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{me.display_name || me.email}</p>
              <p className="truncate text-xs opacity-70">{me.email || me.id}</p>
            </div>
          </div>
          <button
            onClick={async () => {
              await signOut();
              setOpen(false);
              onSignedOut?.();
            }}
            className="block w-full px-4 py-2.5 text-left text-sm hover:bg-current/5"
            role="menuitem"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
