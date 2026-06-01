package auth

import (
	"net/http/httptest"
	"testing"
)

func TestBearerToken_ParsesYjsSubprotocolHeader(t *testing.T) {
	r := httptest.NewRequest("GET", "/api/sync/doc", nil)
	r.Header.Set("Sec-WebSocket-Protocol", "syncscribe.yjs.v1, syncscribe.v1, ws-token")

	if got := bearerToken(r); got != "ws-token" {
		t.Fatalf("bearerToken() = %q, want ws-token", got)
	}
}
