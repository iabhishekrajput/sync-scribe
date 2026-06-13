"use client";

import { useEffect, useState } from "react";

import { api, type AccessRequest, type DocumentAccess, type Invite } from "../../../lib/api";
import { notifyError } from "../../../lib/errors";
import { Modal } from "../../../components/Modal";
import { ShareLinksPanel } from "../../../components/ShareLinksPanel";
import { ActivityLog } from "./ActivityLog";

type InviteRole = "viewer" | "editor";
type AccessRole = "viewer" | "editor" | "owner";

// Owns the sharing surface: email invites, the access list with role
// management, pending invites, viewer-initiated access requests, share
// links, and the activity log.
export function ShareModal({
  open,
  onClose,
  docId,
  isOwner,
  documentRole,
}: {
  open: boolean;
  onClose: () => void;
  docId: string;
  isOwner: boolean;
  documentRole: AccessRole;
}) {
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<InviteRole>("editor");
  const [inviteState, setInviteState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [accessList, setAccessList] = useState<DocumentAccess[]>([]);
  const [pendingInvites, setPendingInvites] = useState<Invite[]>([]);
  const [accessRequests, setAccessRequests] = useState<AccessRequest[]>([]);
  const [accessLoading, setAccessLoading] = useState(true);
  const [accessBusyUserID, setAccessBusyUserID] = useState("");
  const [accessRequestState, setAccessRequestState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [accessRequestBusyID, setAccessRequestBusyID] = useState("");

  async function refreshAccessList() {
    if (!isOwner) return;
    setAccessLoading(true);
    try {
      const access = await api.listAccess(docId);
      setAccessList(access);
      setPendingInvites(await api.listInvites(docId));
      setAccessRequests(await api.listAccessRequests(docId));
    } catch (err) {
      notifyError(err, "list-access");
    } finally {
      setAccessLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !isOwner) return;
    let alive = true;
    (async () => {
      try {
        const access = await api.listAccess(docId);
        if (!alive) return;
        setAccessList(access);
        setPendingInvites(await api.listInvites(docId));
        setAccessRequests(await api.listAccessRequests(docId));
      } catch (err) {
        if (alive) notifyError(err, "list-access");
      } finally {
        if (alive) setAccessLoading(false);
      }
    })();
    // Reset to loading in cleanup so reopening re-fetches without a
    // synchronous setState in the effect body.
    return () => {
      alive = false;
      setAccessLoading(true);
    };
  }, [docId, isOwner, open]);

  function close() {
    setInviteState("idle");
    setAccessRequestState("idle");
    onClose();
  }

  async function sendInvite() {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteState("sending");
    try {
      await api.createInvite(docId, email, inviteRole);
      setInviteEmail("");
      setInviteState("sent");
      await refreshAccessList();
    } catch (err) {
      notifyError(err, "send-invite");
      setInviteState("error");
    }
  }

  async function revokeInvite(token: string) {
    try {
      await api.revokeInvite(docId, token);
      setPendingInvites((prev) => prev.filter((invite) => invite.token !== token));
    } catch (err) {
      notifyError(err, "revoke-invite");
    }
  }

  async function resendInvite(token: string) {
    try {
      const invite = await api.resendInvite(docId, token);
      setPendingInvites((prev) => [invite, ...prev.filter((item) => item.token !== token)]);
    } catch (err) {
      notifyError(err, "resend-invite");
    }
  }

  async function updateAccessRole(access: DocumentAccess, role: AccessRole) {
    setAccessBusyUserID(access.user_id);
    try {
      const updated = await api.upsertAccess(docId, access.user_id, role);
      setAccessList((prev) => prev.map((item) => (item.user_id === access.user_id ? { ...item, ...updated } : item)));
    } catch (err) {
      notifyError(err, "update-access");
    } finally {
      setAccessBusyUserID("");
    }
  }

  async function revokeAccess(access: DocumentAccess) {
    setAccessBusyUserID(access.user_id);
    try {
      await api.deleteAccess(docId, access.user_id);
      setAccessList((prev) => prev.filter((item) => item.user_id !== access.user_id));
    } catch (err) {
      notifyError(err, "revoke-access");
    } finally {
      setAccessBusyUserID("");
    }
  }

  async function requestEditAccess() {
    setAccessRequestState("sending");
    try {
      await api.requestAccess(docId, "editor");
      setAccessRequestState("sent");
    } catch (err) {
      notifyError(err, "request-edit-access");
      setAccessRequestState("error");
    }
  }

  async function resolveAccessRequest(request: AccessRequest, decision: "approved" | "denied") {
    setAccessRequestBusyID(request.id);
    try {
      if (decision === "approved") {
        await api.approveAccessRequest(docId, request.id);
      } else {
        await api.denyAccessRequest(docId, request.id);
      }
      setAccessRequests((prev) => prev.filter((item) => item.id !== request.id));
      if (decision === "approved") await refreshAccessList();
    } catch (err) {
      notifyError(err, "resolve-access-request");
    } finally {
      setAccessRequestBusyID("");
    }
  }

  return (
    <Modal open={open} onClose={close} title="Share document" width="max-w-xl">
      {isOwner ? (
        <>
          <label className="mb-1 block text-xs opacity-70" htmlFor="invite-email">
            Share by email
          </label>
          <div className="flex gap-2">
            <input
              id="invite-email"
              value={inviteEmail}
              type="email"
              onChange={(e) => {
                setInviteEmail(e.target.value);
                setInviteState("idle");
              }}
              className="min-w-0 flex-1 rounded-md border border-current/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-current/40"
              placeholder="teammate@example.com"
            />
            <button
              onClick={sendInvite}
              disabled={inviteState === "sending" || !inviteEmail.trim()}
              className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {inviteState === "sending" ? "Sharing…" : "Share"}
            </button>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 rounded-md bg-current/5 p-1">
            {(["editor", "viewer"] as const).map((role) => (
              <button
                key={role}
                onClick={() => setInviteRole(role)}
                className={`rounded px-2 py-1.5 text-sm capitalize ${
                  inviteRole === role ? "bg-white shadow-sm dark:bg-neutral-800" : "opacity-70"
                }`}
              >
                {role}
              </button>
            ))}
          </div>
          {inviteState === "sent" && (
            <p className="mt-3 text-sm text-emerald-600 dark:text-emerald-400">Access shared.</p>
          )}
          {inviteState === "error" && (
            <p className="mt-3 text-sm text-red-600 dark:text-red-400">Could not share access.</p>
          )}
          {accessRequests.length > 0 && (
            <div className="mt-5 border-t border-current/10 pt-4">
              <h3 className="mb-2 text-sm font-semibold">Access requests</h3>
              <ul className="divide-y divide-current/10 rounded-md border border-current/10">
                {accessRequests.map((request) => (
                  <li key={request.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">
                        {request.requester_name || request.requester_email || request.requester_id}
                      </p>
                      <p className="truncate text-xs opacity-60">
                        Wants {request.requested_role} access · {new Date(request.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <button
                      onClick={() => void resolveAccessRequest(request, "approved")}
                      disabled={accessRequestBusyID === request.id}
                      className="rounded px-2 py-1 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:text-emerald-300 dark:hover:bg-emerald-950/30"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => void resolveAccessRequest(request, "denied")}
                      disabled={accessRequestBusyID === request.id}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Deny
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-5 border-t border-current/10 pt-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">People with access</h3>
              <button onClick={() => void refreshAccessList()} className="text-xs opacity-70 hover:opacity-100">
                Refresh
              </button>
            </div>
            {accessLoading ? (
              <p className="rounded-md border border-current/10 p-3 text-sm opacity-60">Loading access…</p>
            ) : accessList.length === 0 ? (
              <p className="rounded-md border border-dashed border-current/20 p-3 text-sm opacity-60">
                Only you have access.
              </p>
            ) : (
              <ul className="divide-y divide-current/10 rounded-md border border-current/10">
                {accessList.map((access) => (
                  <li key={access.user_id} className="flex items-center gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {access.display_name || access.email || access.user_id}
                      </p>
                      <p className="truncate text-xs opacity-60">{access.email || access.user_id}</p>
                    </div>
                    <select
                      value={access.role}
                      disabled={accessBusyUserID === access.user_id}
                      onChange={(e) => void updateAccessRole(access, e.target.value as AccessRole)}
                      className="rounded-md border border-current/15 bg-transparent px-2 py-1 text-sm capitalize outline-none focus:border-current/40"
                    >
                      <option value="editor">Editor</option>
                      <option value="viewer">Viewer</option>
                      <option value="owner">Owner</option>
                    </select>
                    <button
                      onClick={() => void revokeAccess(access)}
                      disabled={accessBusyUserID === access.user_id}
                      className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Revoke
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {pendingInvites.length > 0 && (
              <div className="mt-4">
                <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide opacity-60">Pending invites</h4>
                <ul className="divide-y divide-current/10 rounded-md border border-current/10">
                  {pendingInvites.map((invite) => (
                    <li key={invite.token} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{invite.email}</p>
                        <p className="truncate text-xs opacity-60">
                          {invite.role} · expires {new Date(invite.expires_at).toLocaleDateString()}
                        </p>
                      </div>
                      <button onClick={() => void resendInvite(invite.token)} className="rounded px-2 py-1 text-xs hover:bg-current/5">
                        Resend
                      </button>
                      <button
                        onClick={() => void revokeInvite(invite.token)}
                        className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        Cancel
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-md border border-current/10 p-3">
          <p className="text-sm opacity-70">Only the owner can manage document sharing.</p>
          {documentRole === "viewer" && (
            <div className="mt-3 flex items-center gap-3">
              <button
                onClick={() => void requestEditAccess()}
                disabled={accessRequestState === "sending" || accessRequestState === "sent"}
                className="rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {accessRequestState === "sending" ? "Requesting..." : accessRequestState === "sent" ? "Requested" : "Request edit access"}
              </button>
              {accessRequestState === "error" && <span className="text-sm text-red-600 dark:text-red-400">Could not send request.</span>}
            </div>
          )}
        </div>
      )}
      <ShareLinksPanel docId={docId} isOwner={isOwner} />
      {isOwner && <ActivityLog docId={docId} />}
    </Modal>
  );
}
