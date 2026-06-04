package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"

	"github.com/abhishek/sync-scribe/api/internal/store"
)

func TestFromMappingStoreSentinels(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want Code
		http int
	}{
		{"not found", store.ErrNotFound, CodeNotFound, http.StatusNotFound},
		{"forbidden", store.ErrForbidden, CodeForbidden, http.StatusForbidden},
		{"invalid input", store.ErrInvalidInput, CodeBadRequest, http.StatusBadRequest},
		{"wrapped not found", wrap(store.ErrNotFound), CodeNotFound, http.StatusNotFound},
		{"random error", errors.New("boom"), CodeInternal, http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := From(tc.err)
			if got.Code != tc.want || got.HTTP != tc.http {
				t.Fatalf("From(%v) = {%s, %d}, want {%s, %d}", tc.err, got.Code, got.HTTP, tc.want, tc.http)
			}
		})
	}
}

func TestFromPassThroughTypedError(t *testing.T) {
	e := Conflict("dup", nil)
	got := From(e)
	if got != e {
		t.Fatalf("From(*Error) returned a different pointer")
	}
}

func TestWriteErrorEnvelopeShape(t *testing.T) {
	var buf bytes.Buffer
	prev := zerolog.New(&buf)
	logger := prev.With().Logger()
	ctx := context.WithValue(context.Background(), loggerCtxKey{}, &logger)
	ctx = context.WithValue(ctx, middleware.RequestIDKey, "req-123")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/x", nil).WithContext(ctx)

	WriteError(rec, req, Forbidden("nope", errors.New("internal-detail")))

	if got := rec.Code; got != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", got)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type = %q, want application/json", ct)
	}

	var body struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
		} `json:"error"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "forbidden" {
		t.Fatalf("code = %q, want forbidden", body.Error.Code)
	}
	if body.Error.Message != "nope" {
		t.Fatalf("message = %q, want nope", body.Error.Message)
	}
	if body.Error.RequestID != "req-123" {
		t.Fatalf("request_id = %q, want req-123", body.Error.RequestID)
	}
	if strings.Contains(rec.Body.String(), "internal-detail") {
		t.Fatalf("internal error leaked into wire body: %s", rec.Body.String())
	}

	logged := buf.String()
	if !strings.Contains(logged, "internal-detail") {
		t.Fatalf("internal error missing from log line: %s", logged)
	}
	if !strings.Contains(logged, "\"code\":\"forbidden\"") {
		t.Fatalf("structured code missing from log line: %s", logged)
	}
}

func TestRequestLoggerAttachesIDAndAccessLogEmitsOneLine(t *testing.T) {
	var buf bytes.Buffer
	prev := zerolog.New(&buf)

	// Swap the package logger for the test; restore on exit so other tests
	// don't see test-only output captured in buf.
	origLogger := loggerForTesting(prev)
	defer loggerForTesting(origLogger)

	stack := middleware.RequestID(RequestLogger(AccessLog(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			LoggerFrom(r.Context()).Warn().Msg("handler-warn")
			w.WriteHeader(http.StatusTeapot)
			_, _ = w.Write([]byte("hi"))
		},
	))))

	srv := httptest.NewServer(stack)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/probe")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusTeapot {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	out := buf.String()
	// Both lines should share the same request_id and carry method/path.
	if !strings.Contains(out, "handler-warn") {
		t.Fatalf("handler log missing: %s", out)
	}
	if !strings.Contains(out, "\"message\":\"access\"") {
		t.Fatalf("access log line missing: %s", out)
	}
	if !strings.Contains(out, "\"status\":418") {
		t.Fatalf("access log missing status: %s", out)
	}
	if !strings.Contains(out, "\"bytes_out\":2") {
		t.Fatalf("access log missing bytes_out: %s", out)
	}
	if strings.Count(out, "\"request_id\":") < 2 {
		t.Fatalf("expected request_id on both handler + access lines: %s", out)
	}
}

func TestRecovererReturnsEnvelope(t *testing.T) {
	var buf bytes.Buffer
	prev := zerolog.New(&buf)
	orig := loggerForTesting(prev)
	defer loggerForTesting(orig)

	stack := middleware.RequestID(RequestLogger(Recoverer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			panic("kaboom")
		},
	))))

	srv := httptest.NewServer(stack)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.StatusCode)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != "internal" {
		t.Fatalf("code = %q, want internal", body.Error.Code)
	}

	out := buf.String()
	if !strings.Contains(out, "panic recovered") {
		t.Fatalf("panic line missing: %s", out)
	}
	if !strings.Contains(out, "kaboom") {
		t.Fatalf("panic value missing: %s", out)
	}
}

func wrap(err error) error { return errWrap{inner: err} }

type errWrap struct{ inner error }

func (e errWrap) Error() string { return "wrapped: " + e.inner.Error() }
func (e errWrap) Unwrap() error { return e.inner }
