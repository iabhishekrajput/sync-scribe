package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/abhishek/sync-scribe/api/internal/auth"
	"github.com/abhishek/sync-scribe/api/internal/httpx"
	"github.com/abhishek/sync-scribe/api/internal/store"
)

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

func (s *Server) streamEvents(w http.ResponseWriter, r *http.Request) {
	p := auth.FromContext(r.Context())
	id, ok := parseDocID(w, r)
	if !ok {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.WriteError(w, r, httpx.Internal("Streaming is not supported by this server.", nil))
		return
	}
	afterID, err := parseEventCursor(r)
	if err != nil {
		httpx.WriteError(w, r, httpx.BadRequest("Event cursor must be a non-negative integer.", err))
		return
	}
	initialEvents, err := s.store.ListActivityAfter(r.Context(), id, p.Subject, afterID, 100)
	if err != nil {
		writeStoreErr(w, r, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	writeEvents := func(events []store.ActivityEvent) error {
		for _, event := range events {
			data, err := json.Marshal(event)
			if err != nil {
				return err
			}
			if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.ID, event.EventType, data); err != nil {
				return err
			}
			afterID = event.ID
		}
		flusher.Flush()
		return nil
	}
	sendBatch := func() error {
		events, err := s.store.ListActivityAfter(r.Context(), id, p.Subject, afterID, 100)
		if err != nil {
			return err
		}
		return writeEvents(events)
	}
	if err := writeEvents(initialEvents); err != nil {
		return
	}

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if err := sendBatch(); err != nil {
				return
			}
		}
	}
}

func parseEventCursor(r *http.Request) (int64, error) {
	raw := strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	if query := strings.TrimSpace(r.URL.Query().Get("sinceEventId")); query != "" {
		raw = query
	}
	if raw == "" {
		return 0, nil
	}
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("invalid event cursor %q", raw)
	}
	return n, nil
}
