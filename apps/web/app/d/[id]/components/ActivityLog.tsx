"use client";

import { useEffect, useState } from "react";

import { api, type ActivityEvent } from "../../../lib/api";

export function ActivityLog({ docId }: { docId: string }) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const next = await api.listActivity(docId, 50);
        if (alive) setEvents(next);
      } catch {
        if (alive) setError("Could not load activity.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [docId]);

  return (
    <div className="mt-5 border-t border-current/10 pt-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Activity log</h3>
      </div>
      {events.length === 0 ? (
        <p className="text-xs opacity-60">{error || "No activity recorded yet."}</p>
      ) : (
        <ul className="space-y-2">
          {events.map((event) => (
            <li key={event.id} className="rounded-md border border-current/10 px-2 py-1.5 text-xs">
              <span className="font-medium">{event.actor_label}</span>{" "}
              <span className="opacity-75">{activityLabel(event)}</span>
              <span className="block opacity-55">{new Date(event.created_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
      {error && events.length > 0 && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}

export function activityLabel(event: ActivityEvent) {
  const labels: Record<string, string> = {
    "access.granted": "updated document access",
    "access.revoked": "revoked document access",
    "snapshot.published": "published a snapshot",
    "snapshot.restored": "restored a snapshot",
    "invite.created": "sent an invite",
    "access_request.created": "requested edit access",
    "access_request.approved": "approved an access request",
    "access_request.denied": "denied an access request",
    "share_link.created": "created a share link",
    "share_link.revoked": "revoked a share link",
    "comment.created": "added a comment",
    "comment.deleted": "deleted a comment",
    "comment.resolved": "resolved a comment",
  };
  return labels[event.event_type] ?? event.event_type.replaceAll(".", " ");
}
