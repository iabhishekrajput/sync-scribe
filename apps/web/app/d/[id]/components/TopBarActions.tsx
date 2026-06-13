"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import type { SaveState } from "../../../lib/yjs";
import {
  CheckIcon,
  CloudOffIcon,
  CloudUpIcon,
  DownloadIcon,
  HistoryIcon,
  MenuIcon,
  MessageSquareIcon,
  PrinterIcon,
  ShareIcon,
  SpinnerIcon,
} from "../../../components/icons";

export type PublishState = "idle" | "saving" | "saved" | "error";

// IconBtn — uniform 32×32 hover-tinted icon button. Every action in the
// editor topbar wears the same style; no "accent" variants — UI/UX uniformity
// reads as polish at a glance, where one filled circle reads as inconsistent.
export function IconBtn({
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
  children: ReactNode;
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

export function ServerSaveStatus({ state }: { state: SaveState }) {
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

export function publishIconClass(state: PublishState) {
  if (state === "saved") return "text-emerald-600 dark:text-emerald-400";
  if (state === "error") return "text-red-600 dark:text-red-400";
  if (state === "saving") return "animate-pulse text-neutral-600 dark:text-neutral-300";
  return "";
}

export function MobileActionsMenu({
  publishState,
  onPublish,
  onShare,
  onExport,
  onPrint,
  onHistory,
  onReview,
}: {
  publishState: PublishState;
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
