package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) listAccess(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	access, err := s.store.ListAccess(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, access)
}

type accessInput struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
}

func (s *Server) upsertAccess(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	var in accessInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
		return
	}
	access, err := s.store.UpsertAccess(r.Context(), id, p.Subject, strings.TrimSpace(in.UserID), strings.TrimSpace(in.Role))
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "access.granted", map[string]any{"user_id": access.UserID, "role": access.Role})
	s.sync.Hub.SetWriteAccess(id, access.UserID, store.CanRoleWrite(access.Role))
	writeJSON(w, http.StatusOK, access)
}

func (s *Server) deleteAccess(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		httpx.WriteError(w, r, httpx.BadRequest("User id is required.", nil))
		return
	}
	if err := s.store.DeleteAccess(r.Context(), id, p.Subject, userID); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "access.revoked", map[string]any{"user_id": userID})
	s.sync.Hub.SetWriteAccess(id, userID, false)
	w.WriteHeader(http.StatusNoContent)
}

type createInviteInput struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

func (s *Server) createInvite(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}

	var in createInviteInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
		return
	}
	role := strings.TrimSpace(in.Role)
	if role == "" {
		role = "editor"
	}

	invite, err := s.store.CreateInvite(r.Context(), id, p.Subject, strings.ToLower(strings.TrimSpace(in.Email)), role)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "invite.created", map[string]any{"email": invite.Email, "role": invite.Role})
	if invite.GrantedUserID != "" {
		s.sync.Hub.SetWriteAccess(id, invite.GrantedUserID, store.CanRoleWrite(invite.Role))
	}
	if err := s.sendInviteEmail(invite); err != nil {
		if invite.GrantedUserID != "" {
			writeJSON(w, http.StatusCreated, invite)
			return
		}
		httpx.WriteError(w, r, httpx.BadGateway("Could not send the invite email.", err))
		return
	}
	writeJSON(w, http.StatusCreated, invite)
}

func (s *Server) listInvites(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	invites, err := s.store.ListInvites(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, invites)
}

func (s *Server) revokeInvite(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	token := chi.URLParam(r, "token")
	if token == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Invite token is required.", nil))
		return
	}
	if err := s.store.RevokeInvite(r.Context(), id, p.Subject, token); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "invite.canceled", map[string]any{"token": token})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) resendInvite(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	token := chi.URLParam(r, "token")
	if token == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Invite token is required.", nil))
		return
	}
	invite, err := s.store.ResendInvite(r.Context(), id, p.Subject, token)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "invite.resent", map[string]any{"email": invite.Email, "role": invite.Role})
	if err := s.sendInviteEmail(invite); err != nil {
		httpx.WriteError(w, r, httpx.BadGateway("Could not send the invite email.", err))
		return
	}
	writeJSON(w, http.StatusCreated, invite)
}

func (s *Server) claimInvite(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	token := chi.URLParam(r, "token")
	if token == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Invite token is required.", nil))
		return
	}
	doc, err := s.store.ClaimInvite(r.Context(), token, p.Subject, strings.ToLower(strings.TrimSpace(p.Email)))
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"document": doc})
}
