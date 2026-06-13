import type { Awareness } from "y-protocols/awareness";

import { TYPING_FRESHNESS_MS } from "./typing";

export type PresencePeer = {
  clientID: number;
  name: string;
  color: string;
  actor: string;
  typingAt?: number;
  connected: boolean;
  lastSeen: number;
};

export const PRESENCE_LINGER_MS = 5000;

// Departed peers linger (greyed) for PRESENCE_LINGER_MS so the dock doesn't
// flicker on brief reconnects.
export function collectPresencePeers(awareness: Awareness, previous: PresencePeer[]) {
  const now = Date.now();
  const previousByID = new Map(previous.map((peer) => [peer.clientID, peer]));
  const seen = new Set<number>();
  const next: PresencePeer[] = [];

  awareness.getStates().forEach((state, clientID) => {
    if (clientID === awareness.clientID) return;
    const user = state.user as
      | { actor?: string; name?: string; color?: string; typingAt?: number }
      | undefined;
    if (!user) return;
    seen.add(clientID);
    next.push({
      clientID,
      name: user.name || "Someone",
      color: user.color || previousByID.get(clientID)?.color || "#737373",
      actor: user.actor || "human",
      typingAt: user.typingAt,
      connected: true,
      lastSeen: now,
    });
  });

  for (const peer of previous) {
    if (seen.has(peer.clientID)) continue;
    if (now - peer.lastSeen > PRESENCE_LINGER_MS) continue;
    next.push({ ...peer, connected: false, typingAt: undefined });
  }

  return next.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

export function samePeerList(a: PresencePeer[], b: PresencePeer[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].clientID !== b[i].clientID || a[i].color !== b[i].color || a[i].name !== b[i].name) {
      return false;
    }
  }
  return true;
}

export function presenceInitial(peer: PresencePeer) {
  if (peer.actor === "guest") return "G";
  return peer.name.trim().charAt(0).toUpperCase() || "U";
}

export function presenceStatus(peer: PresencePeer) {
  const typing = peer.typingAt && Date.now() - peer.typingAt <= TYPING_FRESHNESS_MS;
  if (!peer.connected) return "Left just now";
  if (typing) return "Typing now";
  return "Viewing";
}
