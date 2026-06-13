"use client";

import { useState } from "react";
import Link from "next/link";

import type { Document } from "../../../lib/api";

export function DocumentSidebar({
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
