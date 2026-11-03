package logpath

import "testing"

func TestOf(t *testing.T) {
	Mark("/api/v1/test-secret/")
	Mark("/api/v1/test-secret/") // twice is fine
	for _, c := range []struct{ in, want string }{
		{"/api/v1/test-secret/abcdef.ics", "/api/v1/test-secret/…"},
		{"/api/v1/test-secret/", "/api/v1/test-secret/…"},
		{"/api/v1/batch", "/api/v1/batch"},
		{"/api/v1/test-secre", "/api/v1/test-secre"},
	} {
		if got := Of(c.in); got != c.want {
			t.Errorf("Of(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	for _, p := range []string{"/api/v1/test-secret/abcdef", "/api/v1/batch"} {
		if n := testing.AllocsPerRun(100, func() { _ = Of(p) }); n != 0 {
			t.Errorf("Of(%q) allocates %v times", p, n)
		}
	}
}
