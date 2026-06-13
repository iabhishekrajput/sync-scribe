package sync

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// WS close codes shared with packages/proto/src/index.ts. The client decodes
// these and decides whether to reconnect with a fresh Y.Doc (RESYNC) or stop
// (PERMISSION_DENIED).
const (
	closeAuthExpired         = 4001
	closeUnsupportedProtocol = 4002
	closePermissionDenied    = 4003
	closeRateLimited         = 4008
	closeResync              = 4010
	closeDocDeleted          = 4404
)

// Defaults sized for a single user typing fast (~20 char/s producing batched
// updates). Tuned high enough that a normal session never trips; abusive
// floods hit it within a second.
const (
	defaultUpdatesPerSec  = 60
	defaultUpdateBurst    = 120
	defaultBytesPerSec    = 1 << 20 // 1 MiB/sec sustained
	defaultByteBurst      = 4 << 20 // 4 MiB burst
	defaultConnsPerIP     = 32
)

// tokenBucket is a minimal monotonic-clock token bucket. We avoid pulling in
// golang.org/x/time/rate because the WS hot path only needs Allow() with a
// single floating-point bucket, and the stdlib-first rule in CLAUDE.md
// prefers we vendor the 30 lines.
type tokenBucket struct {
	mu         sync.Mutex
	capacity   float64
	refillRate float64 // tokens per second
	tokens     float64
	lastRefill time.Time
}

func newTokenBucket(perSec, burst float64) *tokenBucket {
	return &tokenBucket{
		capacity:   burst,
		refillRate: perSec,
		tokens:     burst,
		lastRefill: time.Now(),
	}
}

// take returns true and deducts n tokens if available. Otherwise returns
// false and leaves the bucket alone.
func (b *tokenBucket) take(n float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	b.tokens += elapsed * b.refillRate
	if b.tokens > b.capacity {
		b.tokens = b.capacity
	}
	b.lastRefill = now
	if b.tokens < n {
		return false
	}
	b.tokens -= n
	return true
}

// ipRegistry caps concurrent WS connections per source IP. A botnet of N
// IPs can still exhaust resources, but a single misbehaving client cannot.
// Per-user concurrent caps live a layer up (in the principal-keyed map on
// Hub) — IP cap fires *before* auth so unauthenticated floods are cheap to
// reject.
type ipRegistry struct {
	mu    sync.Mutex
	cap   int
	conns map[string]int
}

func newIPRegistry(cap int) *ipRegistry {
	if cap <= 0 {
		cap = defaultConnsPerIP
	}
	return &ipRegistry{cap: cap, conns: map[string]int{}}
}

// tryAcquire reserves a slot for ip. Returns false if the cap is reached.
func (r *ipRegistry) tryAcquire(ip string) bool {
	if ip == "" {
		return true
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.conns[ip] >= r.cap {
		return false
	}
	r.conns[ip]++
	return true
}

func (r *ipRegistry) release(ip string) {
	if ip == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	n := r.conns[ip] - 1
	if n <= 0 {
		delete(r.conns, ip)
		return
	}
	r.conns[ip] = n
}

// clientIP extracts the source IP, honoring X-Forwarded-For only if the
// request appears to come from a trusted loopback. In production deploys
// behind a reverse proxy you'd tighten this to a configured CIDR list; for
// Phase 1 single-node + dev loopback the simple rule is enough.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if isLoopback(host) {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			// First IP in the chain is the original client per RFC 7239.
			for i := 0; i < len(xff); i++ {
				if xff[i] == ',' {
					return trim(xff[:i])
				}
			}
			return trim(xff)
		}
	}
	return host
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func trim(s string) string {
	start, end := 0, len(s)
	for start < end && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}
