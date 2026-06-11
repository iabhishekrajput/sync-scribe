package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	if p == nil {
		httpx.WriteError(w, r, httpx.Unauthenticated("Sign in to continue.", nil))
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
		httpx.WriteError(w, r, httpx.Internal("Could not save your profile.", err))
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
		httpx.WriteError(w, r, httpx.BadRequest("Unknown scope. Use all, owned, or shared.", nil))
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			httpx.WriteError(w, r, httpx.BadRequest("Limit must be a positive integer.", err))
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
		httpx.WriteError(w, r, httpx.Internal("Could not load your documents.", err))
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
		httpx.WriteError(w, r, httpx.Internal("Could not create the document.", err))
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

	doc, role, err := s.store.ResolveDocumentRole(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"document": doc, "role": role})
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
		httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
		return
	}
	in.Title = strings.TrimSpace(in.Title)
	if in.Title == "" {
		httpx.WriteError(w, r, httpx.BadRequest("Title is required.", nil))
		return
	}
	doc, err := s.store.RenameDocument(r.Context(), id, p.Subject, in.Title)
	if err != nil {
		writeStoreErr(w, r, err)
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
		writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
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
			httpx.WriteError(w, r, httpx.BadRequest("sinceUpdateId must be a non-negative integer.", err))
			return
		}
		sinceUpdateID = n
	}
	result, err := s.store.GetAttributionUpdates(r.Context(), id, p.Subject, store.AttributionQuery{
		SinceUpdateID: sinceUpdateID,
		Limit:         limit,
	})
	if err != nil {
		writeStoreErr(w, r, err)
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
