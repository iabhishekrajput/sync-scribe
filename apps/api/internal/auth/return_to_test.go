package auth

import "testing"

func TestSafeReturnTo(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		// Allowed.
		{"/", "/"},
		{"/d/abc", "/d/abc"},
		{"/p/some-token", "/p/some-token"},
		{"/path?q=1&x=2", "/path?q=1&x=2"},

		// Rejected — open-redirect vectors.
		{"", "/"},
		{"//evil.com", "/"},
		{"//evil.com/d/abc", "/"},
		{"http://evil.com", "/"},
		{"https://evil.com", "/"},
		{"javascript:alert(1)", "/"},
		{"\\evil", "/"},
		{"/path\r\nSet-Cookie: x", "/"},
	}
	for _, c := range cases {
		got := safeReturnTo(c.in)
		if got != c.want {
			t.Errorf("safeReturnTo(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
