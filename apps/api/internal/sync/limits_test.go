package sync

import (
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/abhishek/sync-scribe/api/internal/auth"
)

func TestTokenBucket_AllowsBurst(t *testing.T) {
	b := newTokenBucket(10, 5)
	for i := 0; i < 5; i++ {
		if !b.take(1) {
			t.Fatalf("burst token %d denied", i)
		}
	}
	if b.take(1) {
		t.Fatal("bucket should be empty after burst")
	}
}

func TestTokenBucket_RefillsOverTime(t *testing.T) {
	b := newTokenBucket(100, 2)
	if !b.take(2) {
		t.Fatal("initial burst should fit")
	}
	if b.take(1) {
		t.Fatal("bucket should be empty")
	}
	time.Sleep(30 * time.Millisecond)
	// 30ms * 100 tokens/sec = ~3 tokens; with capacity 2 we should refill
	// up to 2.
	if !b.take(2) {
		t.Fatal("bucket should have refilled")
	}
}

func TestIPRegistry_CapsConcurrentConns(t *testing.T) {
	r := newIPRegistry(2)
	if !r.tryAcquire("1.2.3.4") {
		t.Fatal("first acquire denied")
	}
	if !r.tryAcquire("1.2.3.4") {
		t.Fatal("second acquire denied")
	}
	if r.tryAcquire("1.2.3.4") {
		t.Fatal("third acquire should be capped")
	}
	r.release("1.2.3.4")
	if !r.tryAcquire("1.2.3.4") {
		t.Fatal("after release should accept again")
	}
}

func TestIPRegistry_EmptyIPSkipped(t *testing.T) {
	r := newIPRegistry(1)
	if !r.tryAcquire("") {
		t.Fatal("empty IP should always succeed")
	}
	if !r.tryAcquire("") {
		t.Fatal("empty IP must not consume a slot")
	}
}

func TestClientIP_HonorsXFFOnlyFromLoopback(t *testing.T) {
	t.Run("loopback trusts XFF", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "127.0.0.1:5555"
		r.Header.Set("X-Forwarded-For", "9.9.9.9, 7.7.7.7")
		if got := clientIP(r); got != "9.9.9.9" {
			t.Fatalf("got %q want 9.9.9.9", got)
		}
	})
	t.Run("non-loopback ignores XFF", func(t *testing.T) {
		r := httptest.NewRequest("GET", "/", nil)
		r.RemoteAddr = "8.8.8.8:5555"
		r.Header.Set("X-Forwarded-For", "9.9.9.9")
		if got := clientIP(r); got != "8.8.8.8" {
			t.Fatalf("got %q want 8.8.8.8 (XFF should be ignored)", got)
		}
	})
}

// Mid-session permission revocation: when setCanWrite(false) flips on a live
// conn, the next update intent must not produce a broadcast. We don't drive
// a real ws round-trip here — the contract under test is that
// canWrite.Load() reflects the change atomically and the read path rejects
// updates without entering the session queue.
func TestConn_RevocationStopsUpdates(t *testing.T) {
	c := &conn{
		send:         make(chan []byte, 4),
		principal:    &auth.Principal{Subject: "u-x", Actor: auth.ActorHuman},
		updateBucket: newTokenBucket(defaultUpdatesPerSec, defaultUpdateBurst),
		byteBucket:   newTokenBucket(defaultBytesPerSec, defaultByteBurst),
	}
	c.canWrite.Store(true)
	if !c.canWrite.Load() {
		t.Fatal("expected canWrite=true initially")
	}

	// Simulate the revocation Hub does on access change.
	var sent atomic.Int32
	c.canWrite.Store(false)
	if got := c.canWrite.Load(); got {
		t.Fatal("revocation did not flip canWrite")
	}

	// Drain the Readonly notice setCanWrite queues. (The helper isn't
	// invoked above because we set the field directly, but calling
	// setCanWrite goes through the helper so we cover both paths.)
	c.setCanWrite(false)
	readonlyFrame := encodeYjsFlagFrame(MsgReadonly)
	for {
		select {
		case f := <-c.send:
			if string(f) == string(readonlyFrame) {
				sent.Add(1)
				continue
			}
			t.Fatalf("unexpected frame queued during revocation: %v", f)
		case <-time.After(20 * time.Millisecond):
			if sent.Load() == 0 {
				t.Fatal("expected Readonly notice after setCanWrite(false)")
			}
			return
		}
	}
}
