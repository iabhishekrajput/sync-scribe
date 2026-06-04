package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

type createShareLinkInput struct {
	Role        string `json:"role"`
	ExpiresInMs int64  `json:"expires_in_ms,omitempty"`
}

func (s *Server) listShareLinks(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	links, err := s.store.ListShareLinks(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, links)
}

func (s *Server) createShareLink(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	var in createShareLinkInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
		return
	}
	in.Role = strings.TrimSpace(in.Role)
	if in.Role == "" {
		in.Role = "viewer"
	}

	var expires *time.Time
	if in.ExpiresInMs > 0 {
		t := time.Now().Add(time.Duration(in.ExpiresInMs) * time.Millisecond)
		expires = &t
	}

	link, err := s.store.CreateShareLink(r.Context(), id, p.Subject, in.Role, expires)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "share_link.created", map[string]any{"role": link.Role, "expires_at": link.ExpiresAt})
	writeJSON(w, http.StatusCreated, link)
}

func (s *Server) revokeShareLink(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	token := chi.URLParam(r, "token")
	if token == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Share token is required.", nil))
		return
	}
	if err := s.store.RevokeShareLink(r.Context(), id, p.Subject, token); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "share_link.revoked", map[string]any{"token": token})
	w.WriteHeader(http.StatusNoContent)
}

// publicShareInfo is the unauthenticated endpoint a share-link recipient hits
// to render the read-only page before opening the WS. Returns the minimum
// surface — title + the link's role. NEVER include owner_id, access roster,
// or anything else identifying.
type publicShareInfoResponse struct {
	Token     string `json:"token"`
	DocID     string `json:"document_id"`
	Title     string `json:"title"`
	Role      string `json:"role"`
	ExpiresAt string `json:"expires_at,omitempty"`
}

func (s *Server) publicShareInfo(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Share token is required.", nil))
		return
	}
	link, doc, err := s.store.LookupShareLink(r.Context(), token)
	if err != nil {
		// Don't distinguish revoked/expired/missing — minimizes the oracle
		// surface for token-guessing attacks.
		writeStoreErr(w, r, store.ErrNotFound)
		return
	}
	out := publicShareInfoResponse{
		Token: link.Token,
		DocID: doc.ID.String(),
		Title: doc.Title,
		Role:  link.Role,
	}
	if link.ExpiresAt != nil {
		out.ExpiresAt = link.ExpiresAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, http.StatusOK, out)
}
