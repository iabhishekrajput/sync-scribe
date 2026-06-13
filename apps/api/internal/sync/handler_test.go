package sync

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Clients that don't offer syncscribe.yjs.v1 must be refused with close code
// 4002 after the upgrade — not silently served frames they can't parse.
func TestEnsureYjsSubprotocol(t *testing.T) {
	upgrader := websocket.Upgrader{Subprotocols: []string{SubprotocolYjs}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		if !ensureYjsSubprotocol(ws) {
			return
		}
		// Accepted conn: hold open until the client hangs up.
		defer ws.Close()
		for {
			if _, _, err := ws.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http")

	t.Run("yjs subprotocol accepted", func(t *testing.T) {
		d := websocket.Dialer{Subprotocols: []string{SubprotocolYjs}}
		ws, _, err := d.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer ws.Close()
		if got := ws.Subprotocol(); got != SubprotocolYjs {
			t.Fatalf("negotiated %q, want %q", got, SubprotocolYjs)
		}
		// The server must NOT close us: a read should time out, not error
		// with a close frame.
		_ = ws.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
		_, _, err = ws.ReadMessage()
		if websocket.IsCloseError(err, closeUnsupportedProtocol) {
			t.Fatal("yjs conn was rejected with 4002")
		}
	})

	t.Run("no subprotocol rejected with 4002", func(t *testing.T) {
		ws, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
		if err != nil {
			t.Fatalf("dial: %v", err)
		}
		defer ws.Close()
		_ = ws.SetReadDeadline(time.Now().Add(2 * time.Second))
		_, _, err = ws.ReadMessage()
		if !websocket.IsCloseError(err, closeUnsupportedProtocol) {
			t.Fatalf("expected close %d, got %v", closeUnsupportedProtocol, err)
		}
	})
}
