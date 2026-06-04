package httpx

// Structured-log field conventions (audited by operators / dashboards):
//   request_id    chi RequestID — propagated into log lines AND the JSON envelope
//   method, path  populated by RequestLogger
//   status        HTTP status code (AccessLog + WriteError)
//   duration_ms   wall time from middleware entry to handler return (AccessLog)
//   bytes_out     response body bytes written (AccessLog)
//   user_id       auth.Principal.Subject (stamped per-handler via LoggerFrom)
//   doc_id        document UUID, set by handlers that resolve a route param
//   conn_id, seq  WS hub/conn use these for per-session traces
//   code          httpx.Code on the response envelope (stamped by WriteError)

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"
)

type loggerCtxKey struct{}

// RequestLogger seeds the context with a zerolog sub-logger that carries the
// chi RequestID plus the route's method/path. Handlers retrieve it via
// LoggerFrom(ctx) and can extend it (e.g. .Str("doc_id", id)) without
// affecting other in-flight requests.
func RequestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reqID := middleware.GetReqID(r.Context())
		sub := log.With().
			Str("request_id", reqID).
			Str("method", r.Method).
			Str("path", r.URL.Path).
			Logger()
		ctx := context.WithValue(r.Context(), loggerCtxKey{}, &sub)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// LoggerFrom returns the request-scoped logger or, if unset (test code,
// background goroutines), the package-global zerolog logger so callers never
// need a nil check.
func LoggerFrom(ctx context.Context) *zerolog.Logger {
	if v, ok := ctx.Value(loggerCtxKey{}).(*zerolog.Logger); ok && v != nil {
		return v
	}
	return &log.Logger
}

// statusRecorder is a thin wrapper so AccessLog can capture status + bytes
// without monkey-patching handler code. http.ResponseWriter is allowed to
// not be a Flusher/Hijacker; we proxy whatever the underlying writer supports
// at the call site we care about (chi default).
type statusRecorder struct {
	http.ResponseWriter
	status int
	bytes  int
	wrote  bool
}

func (s *statusRecorder) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusRecorder) Write(b []byte) (int, error) {
	if !s.wrote {
		s.status = http.StatusOK
		s.wrote = true
	}
	n, err := s.ResponseWriter.Write(b)
	s.bytes += n
	return n, err
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("httpx: response writer does not implement http.Hijacker")
	}
	return h.Hijack()
}

func (s *statusRecorder) Push(target string, opts *http.PushOptions) error {
	p, ok := s.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return p.Push(target, opts)
}

func (s *statusRecorder) Unwrap() http.ResponseWriter {
	return s.ResponseWriter
}

// AccessLog emits exactly one structured log line per request, after the
// handler returns. Pair with RequestLogger so the line carries request_id.
func AccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		LoggerFrom(r.Context()).Info().
			Int("status", rec.status).
			Int("bytes_out", rec.bytes).
			Int64("duration_ms", time.Since(start).Milliseconds()).
			Msg("access")
	})
}

// Recoverer replaces chi's middleware.Recoverer so panics surface as the
// typed JSON envelope and land in the structured log alongside the stack.
func Recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				LoggerFrom(r.Context()).Error().
					Interface("panic", rec).
					Bytes("stack", debug.Stack()).
					Msg("panic recovered")
				WriteError(w, r, Internal("Something went wrong on our end.", nil))
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// WriteError is the single egress point for the JSON error envelope. Every
// handler funnels through here (directly or via httpx.From). The wire shape
// is frozen — see the package doc comment.
func WriteError(w http.ResponseWriter, r *http.Request, e *Error) {
	if e == nil {
		e = Internal("Something went wrong on our end.", nil)
	}
	reqID := middleware.GetReqID(r.Context())

	body := struct {
		Error errorBody `json:"error"`
	}{
		Error: errorBody{
			Code:      string(e.Code),
			Message:   e.Message,
			RequestID: reqID,
		},
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(e.HTTP)
	_ = json.NewEncoder(w).Encode(body)

	logger := LoggerFrom(r.Context())
	var ev *zerolog.Event
	if e.HTTP >= 500 {
		ev = logger.Error()
	} else {
		ev = logger.Warn()
	}
	ev = ev.Str("code", string(e.Code)).Int("status", e.HTTP)
	if e.Internal != nil {
		ev = ev.Err(e.Internal)
	}
	for k, v := range e.Fields {
		ev = ev.Interface(k, v)
	}
	ev.Msg(e.Message)
}

type errorBody struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id,omitempty"`
}
