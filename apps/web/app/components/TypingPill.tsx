"use client";

import type { Awareness } from "y-protocols/awareness";
import { useTypingPeers } from "../lib/typing";

// Visible "X is typing…" footer pill. Renders nothing when no peer is
// actively typing — empty UI shouldn't take vertical space.
export function TypingPill({ awareness }: { awareness: Awareness | null }) {
  const peers = useTypingPeers(awareness);
  if (peers.length === 0) return null;

  const names = peers.map((p) => p.name);
  let text: string;
  if (names.length === 1) text = `${names[0]} is typing…`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing…`;
  else text = `${names.length} people are typing…`;

  return (
    <div className="flex items-center gap-2 px-3 py-1 text-xs opacity-70">
      <span className="inline-flex gap-0.5">
        {peers.slice(0, 3).map((p) => (
          <span
            key={p.clientID}
            className="block h-2 w-2 rounded-full"
            style={{ background: p.color }}
            aria-label={p.name}
          />
        ))}
      </span>
      <span>{text}</span>
    </div>
  );
}
