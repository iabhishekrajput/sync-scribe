package sync

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/abhishek/sync-scribe/api/internal/auth"
)

// failingStore wraps memStore with a knob to flip AppendUpdate into a
// deterministic error so we can assert the "no ACK on persistence failure"
// guarantee. Reads still succeed so replay tests can share the same fixture.
type failingStore struct {
	*memStore
	failAppend atomic.Bool
}

func newFailingStore() *failingStore { return &failingStore{memStore: newMemStore()} }

func (f *failingStore) AppendUpdate(ctx context.Context, docID uuid.UUID, originUser string, blob []byte) (int64, error) {
	if f.failAppend.Load() {
		return 0, errors.New("synthetic persist failure")
	}
	return f.memStore.AppendUpdate(ctx, docID, originUser, blob)
}

// P1.2 durable-save guarantee: an Ack must never reach the origin until the
// update is durably persisted. If AppendUpdate fails the client's
// pendingSaves counter has to stay non-zero so the UI keeps showing
// "Saving…" rather than a misleading "Saved".
func TestSession_NoAckOnPersistFailure(t *testing.T) {
	st := newFailingStore()
	st.failAppend.Store(true)
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}

	docID := uuid.New()
	a := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	b := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	sess := h.join(docID, a)
	h.join(docID, b)
	t.Cleanup(func() {
		sess.unregister(a)
		sess.unregister(b)
	})

	sess.incoming <- inboundUpdate{
		from: a, blob: []byte{0x01, 0x02, 0x03},
		originUser: a.principal.Subject,
	}

	select {
	case f := <-a.send:
		t.Fatalf("origin must not receive any frame when persist fails, got %v", f)
	case f := <-b.send:
		t.Fatalf("peer must not receive broadcast when persist fails, got %v", f)
	case <-time.After(120 * time.Millisecond):
		// no frame == correct
	}

	stored, _ := st.LoadUpdates(context.Background(), docID)
	if len(stored) != 0 {
		t.Fatalf("expected nothing persisted, got %d rows", len(stored))
	}
}

// Replay ordering — the conn must receive every stored update, then the
// server's SyncStep1, then Readonly when applicable. Order matters: a client
// that observes the server's SyncStep1 treats the local Y.Doc as caught up,
// so late-arriving update frames after that flip would never be applied
// before the provider marks the session live.
func TestReplayYjsInto_EmitsUpdatesThenStep1ThenReadonly(t *testing.T) {
	c := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	updates := [][]byte{{0xAA}, {0xBB, 0xCC}}
	replayYjsInto(c, updates, false)

	for i, want := range updates {
		select {
		case frame := <-c.send:
			msgType, syncType, payload := decodeYjsSyncFrame(t, frame)
			if msgType != MsgSync || syncType != SyncUpdate {
				t.Fatalf("frame %d: got msg=%d sync=%d want sync/update", i, msgType, syncType)
			}
			if string(payload) != string(want) {
				t.Fatalf("frame %d payload: got %v want %v", i, payload, want)
			}
		case <-time.After(time.Second):
			t.Fatalf("frame %d never arrived", i)
		}
	}

	select {
	case frame := <-c.send:
		msgType, syncType, payload := decodeYjsSyncFrame(t, frame)
		if msgType != MsgSync || syncType != SyncStep1 {
			t.Fatalf("expected sync step1, got msg=%d sync=%d", msgType, syncType)
		}
		if len(payload) != 0 {
			t.Fatalf("step1 payload should be empty, got %v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("sync step1 never arrived")
	}

	select {
	case frame := <-c.send:
		if msgType := decodeYjsFlagFrame(t, frame); msgType != MsgReadonly {
			t.Fatalf("expected readonly flag, got %d", msgType)
		}
	case <-time.After(time.Second):
		t.Fatal("readonly flag never arrived")
	}
}

func TestReplayYjsInto_WriteableConnGetsNoReadonly(t *testing.T) {
	c := &conn{send: make(chan []byte, 4), principal: mockPrincipal()}
	replayYjsInto(c, nil, true)

	got := drainSend(c)
	if len(got) != 1 {
		t.Fatalf("expected only SyncStep1 for empty doc, got %d frames: %v", len(got), got)
	}
	msgType, syncType, _ := decodeYjsSyncFrame(t, got[0])
	if msgType != MsgSync || syncType != SyncStep1 {
		t.Fatalf("expected sync step1, got msg=%d sync=%d", msgType, syncType)
	}
}

// History is replayed at connection-open; a client's own SyncStep1 arriving
// afterwards must be ignored — no second replay, no response frames.
func TestConn_ClientSyncStep1AfterReplayIsIgnored(t *testing.T) {
	st := newMemStore()
	docID := uuid.New()
	_, _ = st.AppendUpdate(context.Background(), docID, "u-test", []byte{0x42})
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}

	c := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	c.canWrite.Store(true)
	sess := h.join(docID, c)
	t.Cleanup(func() { sess.unregister(c) })

	c.handleYjsFrame(sess, encodeYjsSyncFrame(SyncStep1, nil))

	select {
	case f := <-c.send:
		t.Fatalf("client SyncStep1 must not trigger any frames, got %v", f)
	case <-time.After(100 * time.Millisecond):
	}
}

// Client SyncStep2 payloads are validated and discarded — never persisted,
// never broadcast. See protocol.go for the compaction rationale.
func TestConn_ClientSyncStep2IsDiscarded(t *testing.T) {
	st := newMemStore()
	docID := uuid.New()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}

	c := &conn{send: make(chan []byte, 16), principal: mockPrincipal()}
	c.canWrite.Store(true)
	sess := h.join(docID, c)
	t.Cleanup(func() { sess.unregister(c) })

	c.handleYjsFrame(sess, encodeYjsSyncFrame(SyncStep2, []byte{0x01, 0x02}))

	time.Sleep(100 * time.Millisecond)
	stored, _ := st.LoadUpdates(context.Background(), docID)
	if len(stored) != 0 {
		t.Fatalf("SyncStep2 must not be persisted, got %d rows", len(stored))
	}
}

// Reconnect-replay correctness: a client that drops mid-session and rejoins
// must see EVERY persisted update — including ones it shipped before the
// drop — replayed back in order. This is what guarantees a Y.Doc snapped
// open on a new tab converges to the same state as the live tab.
func TestSession_ReplayAfterDropContainsAllPersistedUpdates(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	docID := uuid.New()

	writer := &conn{send: make(chan []byte, 32), principal: mockPrincipal()}
	sess := h.join(docID, writer)
	sess.incoming <- inboundUpdate{
		from: writer, blob: []byte{0x10},
		originUser: writer.principal.Subject,
	}
	sess.incoming <- inboundUpdate{
		from: writer, blob: []byte{0x20, 0x21},
		originUser: writer.principal.Subject,
	}
	// Drain the writer's ACKs so the channel doesn't block other tests.
	for got := 0; got < 2; got++ {
		waitForAck(t, writer)
	}
	sess.unregister(writer)

	// Simulate the writer's tab reopening — store reads are unchanged but
	// it's a fresh conn that's never seen any of the bytes.
	rejoin := &conn{send: make(chan []byte, 32), principal: mockPrincipal()}
	stored, err := st.LoadUpdates(context.Background(), docID)
	if err != nil {
		t.Fatalf("LoadUpdates: %v", err)
	}
	replayYjsInto(rejoin, stored, true)

	got := drainSend(rejoin)
	if len(got) != 3 {
		t.Fatalf("expected 3 frames (2 updates + SyncStep1), got %d: %v", len(got), got)
	}
	for i, want := range [][]byte{{0x10}, {0x20, 0x21}} {
		msgType, syncType, body := decodeYjsSyncFrame(t, got[i])
		if msgType != MsgSync || syncType != SyncUpdate || string(body) != string(want) {
			t.Fatalf("frame %d wrong: msg=%d sync=%d body=%v want %v", i, msgType, syncType, body, want)
		}
	}
	if _, syncType, _ := decodeYjsSyncFrame(t, got[2]); syncType != SyncStep1 {
		t.Fatalf("frame 2 should be SyncStep1, got %v", got[2])
	}
}

// "Server restart replays correctly" is structurally identical to reconnect
// replay because the store is the authoritative state and the Hub is
// stateless across processes. Cover the case explicitly so it doesn't drift.
func TestSession_NewHubReplaysSameBytes(t *testing.T) {
	st := newMemStore()
	docID := uuid.New()
	h1 := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	w := &conn{send: make(chan []byte, 32), principal: mockPrincipal()}
	sess := h1.join(docID, w)
	sess.incoming <- inboundUpdate{
		from: w, blob: []byte{0x42},
		originUser: w.principal.Subject,
	}
	waitForAck(t, w)
	sess.unregister(w)

	// New hub, same store — equivalent to a process restart.
	stored, err := st.LoadUpdates(context.Background(), docID)
	if err != nil {
		t.Fatalf("LoadUpdates: %v", err)
	}
	c := &conn{send: make(chan []byte, 4), principal: mockPrincipal()}
	replayYjsInto(c, stored, true)
	got := drainSend(c)
	if len(got) != 2 {
		t.Fatalf("post-restart replay diverged: %v", got)
	}
	if _, syncType, body := decodeYjsSyncFrame(t, got[0]); syncType != SyncUpdate || string(body) != "\x42" {
		t.Fatalf("frame 0 wrong: %v", got[0])
	}
	if _, syncType, _ := decodeYjsSyncFrame(t, got[1]); syncType != SyncStep1 {
		t.Fatalf("frame 1 should be SyncStep1, got %v", got[1])
	}
}

// Readonly viewer must not be able to push updates: a SyncUpdate from a
// !canWrite conn is rejected by acceptUpdate before the session queue — the
// viewer gets a Readonly notice and nothing reaches the store.
func TestConn_ReadonlyViewerCannotAppend(t *testing.T) {
	st := newMemStore()
	h := &Hub{store: st, sessions: map[uuid.UUID]*docSession{}}
	docID := uuid.New()
	viewer := &conn{
		send:      make(chan []byte, 4),
		principal: &auth.Principal{Subject: "u-viewer", Actor: auth.ActorHuman},
	}
	viewer.canWrite.Store(false)
	sess := h.join(docID, viewer)
	t.Cleanup(func() { sess.unregister(viewer) })

	viewer.handleYjsFrame(sess, encodeYjsSyncFrame(SyncUpdate, []byte{0x99}))

	select {
	case f := <-viewer.send:
		if msgType := decodeYjsFlagFrame(t, f); msgType != MsgReadonly {
			t.Fatalf("expected Readonly notice, got msg=%d", msgType)
		}
	case <-time.After(100 * time.Millisecond):
		t.Fatal("viewer never got Readonly notice")
	}
	time.Sleep(50 * time.Millisecond)
	stored, _ := st.LoadUpdates(context.Background(), docID)
	if len(stored) != 0 {
		t.Fatalf("readonly conn somehow wrote %d updates", len(stored))
	}
}

func decodeYjsSyncFrame(t *testing.T, frame []byte) (uint64, uint64, []byte) {
	t.Helper()
	r := byteReader{b: frame}
	msgType, err := r.readVarUint()
	if err != nil {
		t.Fatalf("read msg type: %v", err)
	}
	syncType, err := r.readVarUint()
	if err != nil {
		t.Fatalf("read sync type: %v", err)
	}
	payload, err := r.readVarBytes()
	if err != nil {
		t.Fatalf("read payload: %v", err)
	}
	if r.i != len(r.b) {
		t.Fatalf("frame has trailing bytes: %v", frame[r.i:])
	}
	return msgType, syncType, payload
}

func decodeYjsFlagFrame(t *testing.T, frame []byte) uint64 {
	t.Helper()
	r := byteReader{b: frame}
	msgType, err := r.readVarUint()
	if err != nil {
		t.Fatalf("read msg type: %v", err)
	}
	if r.i != len(r.b) {
		t.Fatalf("flag frame has trailing bytes: %v", frame[r.i:])
	}
	return msgType
}

func drainSend(c *conn) [][]byte {
	var out [][]byte
	for {
		select {
		case f := <-c.send:
			out = append(out, f)
		case <-time.After(20 * time.Millisecond):
			return out
		}
	}
}

func waitForAck(t *testing.T, c *conn) {
	t.Helper()
	for {
		select {
		case f := <-c.send:
			r := byteReader{b: f}
			if msgType, err := r.readVarUint(); err == nil && msgType == MsgAck && r.i == len(r.b) {
				return
			}
		case <-time.After(time.Second):
			t.Fatal("waitForAck: timeout")
		}
	}
}
