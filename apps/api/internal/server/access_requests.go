package server

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
)

type createAccessRequestInput struct {
	Role    string `json:"role"`
	Message string `json:"message"`
}

func (s *Server) listAccessRequests(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	requests, err := s.store.ListAccessRequests(r.Context(), id, p.Subject)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, requests)
}

func (s *Server) createAccessRequest(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	var in createAccessRequestInput
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			httpx.WriteError(w, r, httpx.BadRequest("Could not parse the request body.", err))
			return
		}
	}
	role := strings.TrimSpace(in.Role)
	if role == "" {
		role = "editor"
	}
	message := strings.TrimSpace(in.Message)
	if len(message) > 500 {
		message = message[:500]
	}
	request, err := s.store.RequestAccess(r.Context(), id, p.Subject, role, message)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "access_request.created", map[string]any{"requested_role": request.RequestedRole})
	writeJSON(w, http.StatusCreated, request)
}

func (s *Server) approveAccessRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveAccessRequest(w, r, "approved")
}

func (s *Server) denyAccessRequest(w http.ResponseWriter, r *http.Request) {
	s.resolveAccessRequest(w, r, "denied")
}

func (s *Server) resolveAccessRequest(w http.ResponseWriter, r *http.Request, decision string) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	requestID, err := uuid.Parse(chi.URLParam(r, "requestID"))
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Access request id is not a valid UUID.", err))
		return
	}
	request, err := s.store.ResolveAccessRequest(r.Context(), id, requestID, p.Subject, decision)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}
	_ = s.store.RecordActivity(r.Context(), id, p.Subject, "access_request."+decision, map[string]any{
		"requester_id":   request.RequesterID,
		"requested_role": request.RequestedRole,
	})
	if decision == "approved" {
		s.sync.Hub.SetWriteAccess(id, request.RequesterID, request.RequestedRole == "editor")
	}
	writeJSON(w, http.StatusOK, request)
}
