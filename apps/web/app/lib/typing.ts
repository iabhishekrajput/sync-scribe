"use client";

import { useEffect, useState } from "react";
import type * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";

// Typing-indicator (M9 plan §8): a collaborator is "typing" if they emitted
// a doc update OR set awareness.user.typingAt within the last 2 seconds.
//
// We use awareness.user.typingAt rather than doc updates as the canonical
// signal because (a) it works for guests on share links, (b) the signal
// survives a moment of silence so the pill doesn't flicker, and (c) it
// doesn't require subscribing to the Y.Doc-wide update stream which is the
// hot path.
export const TYPING_FRESHNESS_MS = 2000;

export type TypingPeer = {
  clientID: number;
  name: string;
  color: string;
};

// Watches `awareness` and returns the list of peers whose typingAt is fresh.
// The local clientID is excluded so we don't tell ourselves we're typing.
export function useTypingPeers(awareness: Awareness | null): TypingPeer[] {
  const [peers, setPeers] = useState<TypingPeer[]>([]);

  useEffect(() => {
    if (!awareness) return;

    const recompute = () => {
      const now = Date.now();
      const out: TypingPeer[] = [];
      awareness.getStates().forEach((state, clientID) => {
        if (clientID === awareness.clientID) return;
        const user = state.user as
          | { name?: string; color?: string; typingAt?: number }
          | undefined;
        if (!user?.typingAt) return;
        if (now - user.typingAt > TYPING_FRESHNESS_MS) return;
        out.push({
          clientID,
          name: user.name || "Someone",
          color: user.color || "#888",
        });
      });
      setPeers(out);
    };

    recompute();
    awareness.on("change", recompute);
    // Repaint when freshness expires even if no awareness event fires.
    const t = setInterval(recompute, TYPING_FRESHNESS_MS / 4);

    return () => {
      awareness.off("change", recompute);
      clearInterval(t);
    };
  }, [awareness]);

  return peers;
}

// makeTypingStamper bumps the local awareness.user.typingAt timestamp on
// every local Y.Doc update, throttled so we don't broadcast an awareness
// frame per keystroke. The 250ms throttle still keeps the 2s freshness
// window accurate.
//
// We key off Transaction.local (a Yjs-provided boolean) rather than the
// origin parameter because editor bindings can apply edits with their own
// origin object. Comparing to null/undefined would never fire, and comparing
// to a specific provider instance couples us to a single sender.
export function makeTypingStamper(awareness: Awareness, ydoc: Y.Doc) {
  let last = 0;

  const stamp = () => {
    const now = Date.now();
    last = now;
    const cur = awareness.getLocalState() ?? {};
    const user = (cur.user as Record<string, unknown> | undefined) ?? {};
    awareness.setLocalStateField("user", { ...user, typingAt: now });
  };

  // Y.Doc emits update(update, origin, doc, transaction). transaction.local
  // is true iff the mutation came from this client, regardless of origin.
  const handler = (
    _u: Uint8Array,
    _origin: unknown,
    _doc: Y.Doc,
    transaction: { local: boolean },
  ) => {
    if (!transaction?.local) return;
    if (Date.now() - last < 250) return;
    stamp();
  };

  ydoc.on("update", handler);
  return () => ydoc.off("update", handler);
}
