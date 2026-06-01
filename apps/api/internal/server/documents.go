package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		auth.WriteUnauthorized(w, "no principal")
		return
	}

	displayName := p.Name
	if displayName == "" {
		displayName = p.Email
	}
	if displayName == "" {
		displayName = p.Subject
	}

	u, err := s.store.UpsertUser(r.Context(), store.User{
		ID:          p.Subject,
		Email:       principalEmail(p),
		DisplayName: displayName,
	})
	if err != nil {
		http.Error(w, "upsert: "+err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, u)
}

func principalEmail(p *auth.Principal) string {
	if p.Email != "" {
		return p.Email
	}
	return p.Subject + "@syncscribe.local"
}

func (s *Server) listDocuments(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "all"
	}
	if scope != "all" && scope != "owned" && scope != "shared" {
		http.Error(w, "invalid scope", http.StatusBadRequest)
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = min(n, 100)
	}
	docs, err := s.store.ListDocumentsForUser(r.Context(), p.Subject, store.DocumentListOptions{
		Query: strings.TrimSpace(r.URL.Query().Get("q")),
		Scope: scope,
		Limit: limit,
	})
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, docs)
}

type createDocumentInput struct {
	Title string `json:"title"`
	// Source describes how this document was created. Currently only
	// "import:markdown" is recognised; clients use it so the activity log can
	// distinguish a hand-created doc from one seeded from a `.md` file.
	Source string `json:"source,omitempty"`
}

func (s *Server) createDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())

	var in createDocumentInput
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&in)
	}

	doc, err := s.store.CreateDocument(r.Context(), p.Subject, strings.TrimSpace(in.Title))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if in.Source == "import:markdown" {
		_ = s.store.RecordActivity(r.Context(), doc.ID, p.Subject, "document.imported",
			map[string]any{"format": "markdown"})
	}
	writeJSON(w, http.StatusCreated, doc)
}

func (s *Server) getDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}

	doc, err := s.store.GetDocument(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"document": doc})
}

func (s *Server) listAccess(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	access, err := s.store.ListAccess(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
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
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	access, err := s.store.UpsertAccess(r.Context(), id, p.Subject, strings.TrimSpace(in.UserID), strings.TrimSpace(in.Role))
	if err != nil {
		writeStoreErr(w, err)
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
		http.Error(w, "user id required", http.StatusBadRequest)
		return
	}
	if err := s.store.DeleteAccess(r.Context(), id, p.Subject, userID); err != nil {
		writeStoreErr(w, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "access.revoked", map[string]any{"user_id": userID})
	s.sync.Hub.SetWriteAccess(id, userID, false)
	w.WriteHeader(http.StatusNoContent)
}

type renameInput struct {
	Title string `json:"title"`
}

func (s *Server) renameDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	var in renameInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		http.Error(w, "title required", http.StatusBadRequest)
		return
	}
	doc, err := s.store.RenameDocument(r.Context(), id, p.Subject, in.Title)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) deleteDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	if err := s.store.SoftDeleteDocument(r.Context(), id, p.Subject); err != nil {
		writeStoreErr(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listSnapshots(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	snapshots, err := s.store.ListSnapshots(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshots)
}

func (s *Server) getSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	version, ok := parseVersion(w, r)
	if !ok {
		return
	}
	snapshot, err := s.store.GetSnapshot(r.Context(), id, version, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, snapshot)
}

// publishSnapshot stores the editor's current text as a new snapshot. The
// client POSTs the live Y.Text content as text/plain or text/markdown; the
// server doesn't parse — just persists bytes. Required for Export Markdown
// to have anything to serve, since M3 took out the M2 auto-save path.
func (s *Server) publishSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	doc, role, err := s.store.ResolveDocumentRole(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	if !store.CanRoleWrite(role) {
		http.Error(w, "read-only", http.StatusForbidden)
		return
	}
	// Cap at 4 MiB — beyond that, the doc is past the markdown editor's
	// reasonable scope and someone is probably misusing the endpoint.
	body, err := readLimitedBody(r, 4<<20)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	version, err := s.store.PutSnapshot(r.Context(), doc.ID, p.Subject, body)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.store.RecordActivity(r.Context(), doc.ID, p.Subject, "snapshot.published", map[string]any{"version": version})
	writeJSON(w, http.StatusCreated, map[string]any{"version": version})
}

func (s *Server) restoreSnapshot(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	version, ok := parseVersion(w, r)
	if !ok {
		return
	}
	doc, newVersion, err := s.store.RestoreSnapshot(r.Context(), id, version, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "snapshot.restored", map[string]any{"from_version": version, "version": newVersion})
	writeJSON(w, http.StatusCreated, map[string]any{"document": doc, "version": newVersion})
}

func (s *Server) exportDocument(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "md"
	}
	if format != "md" {
		http.Error(w, "unsupported export format", http.StatusBadRequest)
		return
	}
	export, err := s.store.ExportMarkdown(r.Context(), id, p.Subject)
	if err != nil {
		if errors.Is(err, store.ErrInvalidInput) {
			http.Error(w, "latest snapshot is not exportable as markdown yet", http.StatusConflict)
			return
		}
		writeStoreErr(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", export.Filename))
	w.Header().Set("X-SyncScribe-Version", strconv.FormatInt(export.Version, 10))
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(export.Body)
}

func (s *Server) getAttribution(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	limit := 500
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	sinceUpdateID := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("sinceUpdateId")); raw != "" {
		n, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || n < 0 {
			http.Error(w, "invalid sinceUpdateId", http.StatusBadRequest)
			return
		}
		sinceUpdateID = n
	}
	result, err := s.store.GetAttributionUpdates(r.Context(), id, p.Subject, store.AttributionQuery{
		SinceUpdateID: sinceUpdateID,
		Limit:         limit,
	})
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"updates": result.Updates,
		"range": map[string]string{
			"from_item": strings.TrimSpace(r.URL.Query().Get("fromItem")),
			"to_item":   strings.TrimSpace(r.URL.Query().Get("toItem")),
		},
		"cursor": map[string]any{
			"since_update_id":      sinceUpdateID,
			"next_since_update_id": result.NextSinceUpdateID,
			"limit":                limit,
		},
	})
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
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	role := strings.TrimSpace(in.Role)
	if role == "" {
		role = "editor"
	}

	invite, err := s.store.CreateInvite(r.Context(), id, p.Subject, strings.ToLower(strings.TrimSpace(in.Email)), role)
	if err != nil {
		writeStoreErr(w, err)
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
		http.Error(w, fmt.Sprintf("send invite email: %v", err), http.StatusBadGateway)
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
		writeStoreErr(w, err)
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
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	if err := s.store.RevokeInvite(r.Context(), id, p.Subject, token); err != nil {
		writeStoreErr(w, err)
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
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	invite, err := s.store.ResendInvite(r.Context(), id, p.Subject, token)
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "invite.resent", map[string]any{"email": invite.Email, "role": invite.Role})
	if err := s.sendInviteEmail(invite); err != nil {
		http.Error(w, fmt.Sprintf("send invite email: %v", err), http.StatusBadGateway)
		return
	}
	writeJSON(w, http.StatusCreated, invite)
}

func (s *Server) claimInvite(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	token := chi.URLParam(r, "token")
	if token == "" {
		http.Error(w, "token required", http.StatusBadRequest)
		return
	}
	doc, err := s.store.ClaimInvite(r.Context(), token, p.Subject, strings.ToLower(strings.TrimSpace(p.Email)))
	if err != nil {
		writeStoreErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"document": doc})
}

func readLimitedBody(r *http.Request, max int64) ([]byte, error) {
	if r.Body == nil {
		return nil, fmt.Errorf("empty body")
	}
	defer r.Body.Close()
	// +1 so we can detect overflow vs. exactly-max.
	body, err := io.ReadAll(io.LimitReader(r.Body, max+1))
	if err != nil {
		return nil, fmt.Errorf("read body: %w", err)
	}
	if int64(len(body)) > max {
		return nil, fmt.Errorf("body too large (max %d bytes)", max)
	}
	return body, nil
}

func parseDocID(w http.ResponseWriter, r *http.Request) (uuid.UUID, bool) {
	raw := chi.URLParam(r, "id")
	id, err := uuid.Parse(raw)
	if err != nil {
		http.Error(w, "invalid id", http.StatusBadRequest)
		return uuid.Nil, false
	}
	return id, true
}

func parseVersion(w http.ResponseWriter, r *http.Request) (int64, bool) {
	version, err := strconv.ParseInt(chi.URLParam(r, "version"), 10, 64)
	if err != nil || version <= 0 {
		http.Error(w, "invalid version", http.StatusBadRequest)
		return 0, false
	}
	return version, true
}

func writeStoreErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		http.Error(w, "not found", http.StatusNotFound)
	case errors.Is(err, store.ErrForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
	case errors.Is(err, store.ErrInvalidInput):
		http.Error(w, err.Error(), http.StatusBadRequest)
	default:
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
