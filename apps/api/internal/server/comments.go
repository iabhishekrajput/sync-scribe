package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

type createCommentInput struct {
	Kind        string `json:"kind"`
	LineNumber  *int   `json:"line_number"`
	AnchorStart string `json:"anchor_start"`
	AnchorEnd   string `json:"anchor_end"`
	AnchorText  string `json:"anchor_text"`
	Body        string `json:"body"`
}

func (s *Server) listComments(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	includeResolved := r.URL.Query().Get("include_resolved") == "true"
	comments, err := s.store.ListComments(r.Context(), id, p.Subject, includeResolved)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, comments)
}

func (s *Server) createComment(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	var in createCommentInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
		return
	}
	anchorStart, err := decodeCommentAnchor(in.AnchorStart)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("anchor_start is not valid base64.", err))
		return
	}
	anchorEnd, err := decodeCommentAnchor(in.AnchorEnd)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("anchor_end is not valid base64.", err))
		return
	}
	comment, err := s.store.CreateComment(
		r.Context(),
		id,
		p.Subject,
		strings.TrimSpace(in.Kind),
		in.LineNumber,
		anchorStart,
		anchorEnd,
		in.AnchorText,
		in.Body,
	)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, comment)
}

func (s *Server) resolveComment(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	commentID, err := uuid.Parse(chi.URLParam(r, "commentID"))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Comment id is not a valid UUID.", err))
		return
	}
	comment, err := s.store.ResolveComment(r.Context(), id, commentID, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, comment)
}

func (s *Server) deleteComment(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	commentID, err := uuid.Parse(chi.URLParam(r, "commentID"))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Comment id is not a valid UUID.", err))
		return
	}
	if err := s.store.DeleteComment(r.Context(), id, commentID, p.Subject); err != nil {
		writeStoreErr(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listActivity(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
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
	events, err := s.store.ListActivity(r.Context(), id, p.Subject, limit)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func decodeCommentAnchor(raw string) ([]byte, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}
	return base64.StdEncoding.DecodeString(raw)
}
