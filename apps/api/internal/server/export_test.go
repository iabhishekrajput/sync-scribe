package server

import (
	"net/http"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
)

// exportTestRouter wires just the export endpoint with a stub auth middleware
// so we can test HTTP-level behaviour without a live database.
func exportTestRouter(s *Server) http.Handler {
	r := chi.NewRouter()
	r.With(func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
			ctx := auth.WithPrincipal(req.Context(), &auth.Principal{Subject: "user-test"})
			next.ServeHTTP(w, req.WithContext(ctx))
		})
	}).Get("/documents/{id}/export", s.exportDocument)
	return r
}

func TestExportDocument_UnsupportedFormat(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/documents/"+uuid.New().String()+"/export?format=csv", nil)
	if err != nil {
		t.Fatal(err)
	}
	rr := newRecorder()
	exportTestRouter(&Server{}).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("format=csv: got %d, want 400", rr.Code)
	}
}

func TestExportDocument_InvalidDocID(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/documents/not-a-uuid/export?format=md", nil)
	if err != nil {
		t.Fatal(err)
	}
	rr := newRecorder()
	exportTestRouter(&Server{}).ServeHTTP(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Errorf("invalid doc id: got %d, want 400", rr.Code)
	}
}

func TestExportDocument_DefaultFormatIsMd(t *testing.T) {
	req, err := http.NewRequest(http.MethodGet, "/documents/"+uuid.New().String()+"/export", nil)
	if err != nil {
		t.Fatal(err)
	}
	rr := newRecorder()

	defer func() {
		if recover() == nil {
			t.Fatal("expected nil store panic once format defaults to md")
		}
	}()
	exportTestRouter(&Server{}).ServeHTTP(rr, req)
}

type responseRecorder struct {
	header http.Header
	Code   int
}

func newRecorder() *responseRecorder {
	return &responseRecorder{header: make(http.Header)}
}

func (r *responseRecorder) Header() http.Header {
	return r.header
}

func (r *responseRecorder) Write(p []byte) (int, error) {
	if r.Code == 0 {
		r.Code = http.StatusOK
	}
	return len(p), nil
}

func (r *responseRecorder) WriteHeader(statusCode int) {
	r.Code = statusCode
}
