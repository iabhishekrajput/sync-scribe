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
		writeStoreErr(w, err)
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
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	anchorStart, err := decodeCommentAnchor(in.AnchorStart)
	if err != nil {
		http.Error(w, "bad anchor_start", http.StatusBadRequest)
		return
	}
	anchorEnd, err := decodeCommentAnchor(in.AnchorEnd)
	if err != nil {
		http.Error(w, "bad anchor_end", http.StatusBadRequest)
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
		writeStoreErr(w, err)
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
		http.Error(w, "bad comment id", http.StatusBadRequest)
		return
	}
	comment, err := s.store.ResolveComment(r.Context(), id, commentID, p.Subject)
	if err != nil {
		writeStoreErr(w, err)
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
		http.Error(w, "bad comment id", http.StatusBadRequest)
		return
	}
	if err := s.store.DeleteComment(r.Context(), id, commentID, p.Subject); err != nil {
		writeStoreErr(w, err)
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
			http.Error(w, "invalid limit", http.StatusBadRequest)
			return
		}
		limit = min(n, 100)
	}
	events, err := s.store.ListActivity(r.Context(), id, p.Subject, limit)
	if err != nil {
		writeStoreErr(w, err)
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
