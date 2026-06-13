package server

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
)

// healthLive is the liveness probe: returns 200 as long as the process is up.
// Load balancers use this to decide whether to restart the container.
func (s *Server) healthLive(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ok",
		"service": "syncscribe-api",
	})
}

// healthReady is the readiness probe: returns 200 only when the API can serve
// traffic (DB reachable). Kubernetes / ECS stops routing here on non-200
// without restarting the container.
func (s *Server) healthReady(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()

	if err := s.store.Pool.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{
			"status": "unavailable",
			"error":  "database unreachable",
		})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"status":  "ready",
		"service": "syncscribe-api",
	})
}

// healthz is kept as an alias for /health/live for backward compatibility.
func (s *Server) healthz(w http.ResponseWriter, r *http.Request) {
	s.healthLive(w, r)
}

// canaryReport is the JSON body for /health/canary.
type canaryReport struct {
	Status      string         `json:"status"`
	GeneratedAt time.Time      `json:"generated_at"`
	Checks      []canaryResult `json:"checks"`
}

type canaryResult struct {
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	LatencyMs int64 `json:"latency_ms"`
	Detail   string `json:"detail,omitempty"`
}

// healthCanary is a deeper probe than /ready: it round-trips DB, pings the
// pub-sub broker (multi-node only), and reports the age of the most recent
// retention run. Operators wire this into the canary alerting pipeline; the
// endpoint returns 503 if any required check fails.
//
// Unlike /health/ready (binary, used by the LB), this returns per-check
// detail so dashboards can surface what is degraded.
func (s *Server) healthCanary(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
	defer cancel()

	report := canaryReport{
		GeneratedAt: time.Now().UTC(),
		Checks:      make([]canaryResult, 0, 3),
	}
	allOK := true

	// DB check.
	t0 := time.Now()
	dbErr := s.store.Pool.Ping(ctx)
	dbCheck := canaryResult{Name: "postgres", OK: dbErr == nil, LatencyMs: time.Since(t0).Milliseconds()}
	if dbErr != nil {
		dbCheck.Detail = dbErr.Error()
		allOK = false
	}
	report.Checks = append(report.Checks, dbCheck)

	// Broker check — only meaningful in multi-node mode.
	if s.broker != nil {
		t1 := time.Now()
		bErr := s.broker.Ping(ctx)
		bCheck := canaryResult{Name: "broker", OK: bErr == nil, LatencyMs: time.Since(t1).Milliseconds()}
		if bErr != nil {
			bCheck.Detail = bErr.Error()
			allOK = false
		}
		report.Checks = append(report.Checks, bCheck)
	}

	// Retention freshness: the loop runs hourly, so anything older than 25h
	// indicates the goroutine is stuck or the process has been restarted in a
	// tight loop without completing a pass.
	t2 := time.Now()
	var finishedAt *time.Time
	retErr := s.store.Pool.QueryRow(ctx,
		`SELECT finished_at FROM retention_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
	).Scan(&finishedAt)
	retCheck := canaryResult{Name: "retention", LatencyMs: time.Since(t2).Milliseconds()}
	switch {
	case errors.Is(retErr, pgx.ErrNoRows):
		// First-boot tolerance — process may not have completed a pass yet.
		retCheck.OK = true
		retCheck.Detail = "no completed retention runs yet"
	case retErr != nil:
		retCheck.OK = false
		retCheck.Detail = retErr.Error()
		allOK = false
	case finishedAt != nil:
		age := time.Since(*finishedAt)
		retCheck.OK = age < 25*time.Hour
		retCheck.Detail = age.Truncate(time.Minute).String() + " since last pass"
		if !retCheck.OK {
			allOK = false
		}
	}
	report.Checks = append(report.Checks, retCheck)

	if allOK {
		report.Status = "ok"
	} else {
		report.Status = "degraded"
	}

	status := http.StatusOK
	if !allOK {
		status = http.StatusServiceUnavailable
	}
	writeJSON(w, status, report)
}
