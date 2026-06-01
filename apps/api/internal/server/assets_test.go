package server

import (
	"testing"

	"github.com/abhishek/sync-scribe/api/internal/store"
)

func TestSanitizeAssetFilename(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ct   string
		want string
	}{
		{"empty falls back to content type ext", "", "image/png", "upload.png"},
		{"empty with unknown ct falls back to .bin", "", "application/octet-stream", "upload.bin"},
		{"plain filename passes through", "screenshot.png", "image/png", "screenshot.png"},
		{"unix path stripped", "/etc/passwd/evil.png", "image/png", "evil.png"},
		{"windows path stripped", `C:\Users\me\evil.png`, "image/png", "evil.png"},
		{"trailing slash returns default", "foo/", "image/jpeg", "upload.jpg"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := sanitizeAssetFilename(tc.in, tc.ct)
			if got != tc.want {
				t.Fatalf("sanitizeAssetFilename(%q, %q) = %q, want %q", tc.in, tc.ct, got, tc.want)
			}
		})
	}
}

func TestAllowedAssetTypesCoverage(t *testing.T) {
	// Image types the editor actively pastes/drops. Drift between the
	// client (apps/web/.../page.tsx ALLOWED_ASSET_TYPES) and the server
	// here would silently 415, so this test pins the contract.
	required := []string{
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
		"image/svg+xml",
	}
	for _, ct := range required {
		if _, ok := allowedAssetTypes[ct]; !ok {
			t.Errorf("allowedAssetTypes missing %q", ct)
		}
	}
}

func TestMaxAssetBytesContract(t *testing.T) {
	// The editor enforces an 8 MiB pre-upload check; the server caps at the
	// same value. If the server cap is widened without bumping the client,
	// users will see confusing "file too large" errors only after the upload
	// round-trip — pin the contract here.
	const expected = 8 * 1024 * 1024
	if store.MaxAssetBytes != expected {
		t.Fatalf("MaxAssetBytes = %d, want %d", store.MaxAssetBytes, expected)
	}
}
