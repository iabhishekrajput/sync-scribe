"use client";

import { useEffect, useRef } from "react";

type Props = {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Tailwind max-width — e.g. "max-w-md", "max-w-3xl". Defaults to max-w-md. */
  width?: string;
  children: React.ReactNode;
  /** Right-side header content (extra buttons next to Close). */
  headerExtra?: React.ReactNode;
};

// Generic centered modal with escape-to-close + click-outside-to-close,
// + scroll-lock on body while open. Used by the share dialog, history,
// any other future popovers. Single component = single accessibility model.
export function Modal({ open, onClose, title, width = "max-w-md", children, headerExtra }: Props) {
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="no-print fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (!cardRef.current?.contains(e.target as Node)) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal
        aria-label={title}
        className={`flex max-h-[90vh] w-full ${width} flex-col overflow-hidden rounded-xl border border-current/10 bg-white shadow-2xl dark:bg-neutral-950`}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-current/10 px-4 py-3">
            <h2 className="text-base font-semibold">{title}</h2>
            <div className="flex items-center gap-2">
              {headerExtra}
              <button
                onClick={onClose}
                className="rounded-md px-2 py-1 text-sm hover:bg-current/5"
                aria-label="Close"
              >
                Close
              </button>
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
