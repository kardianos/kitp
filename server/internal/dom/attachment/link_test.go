package attachment

import (
	"context"
	"errors"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/api"
)

// testSecret installs a fixed signing secret + base URL for the
// duration of a test. Tests run in one process and share the package
// linkDeps var, so each signing test sets it explicitly.
func testSecret(t *testing.T, publicURL string) {
	t.Helper()
	SetLinkDeps(publicURL, []byte("test-secret-0123456789abcdef"))
	t.Cleanup(func() { SetLinkDeps("", nil) })
}

func TestVerifyDownloadURL_RoundTrip(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	now := time.Now().Unix()
	exp := now + int64(linkTTL.Seconds())
	sig := signLinkPayload(42, "download", exp)
	if err := verifyDownloadURL(42, "download", exp, sig, now); err != nil {
		t.Fatalf("valid link rejected: %v", err)
	}
}

func TestVerifyDownloadURL_Rejections(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	now := time.Now().Unix()
	exp := now + int64(linkTTL.Seconds())
	good := signLinkPayload(7, "view", exp)

	cases := []struct {
		name           string
		id             int64
		mode           string
		exp            string
		sig            string
		wantForbidden  bool
		wantSpecificFn func(error) bool
	}{
		{name: "expired", id: 7, mode: "view", exp: strconv.FormatInt(now-1, 10), sig: signLinkPayload(7, "view", now-1), wantForbidden: true},
		{name: "far future", id: 7, mode: "view", exp: strconv.FormatInt(now+86400, 10), sig: signLinkPayload(7, "view", now+86400), wantForbidden: true},
		{name: "tampered sig", id: 7, mode: "view", exp: strconv.FormatInt(exp, 10), sig: good + "x", wantForbidden: true},
		{name: "wrong id", id: 8, mode: "view", exp: strconv.FormatInt(exp, 10), sig: good, wantForbidden: true},
		{name: "wrong mode", id: 7, mode: "download", exp: strconv.FormatInt(exp, 10), sig: good, wantForbidden: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			expN, _ := strconv.ParseInt(tc.exp, 10, 64)
			err := verifyDownloadURL(tc.id, tc.mode, expN, tc.sig, now)
			if err == nil {
				t.Fatalf("expected rejection, got nil")
			}
			if tc.wantForbidden {
				var he *api.HTTPError
				if !errors.As(err, &he) || he.Status != 403 {
					t.Fatalf("want 403 forbidden, got %v", err)
				}
			}
		})
	}
}

func TestVerifyDownloadURL_NoSecret(t *testing.T) {
	SetLinkDeps("", nil)
	t.Cleanup(func() { SetLinkDeps("", nil) })
	err := verifyDownloadURL(1, "download", time.Now().Unix()+60, "anything", time.Now().Unix())
	var he *api.HTTPError
	if !errors.As(err, &he) || he.Status != 500 {
		t.Fatalf("want 500 internal when secret unset, got %v", err)
	}
}

func TestBuildDownloadURL(t *testing.T) {
	now := time.Now().Unix()
	exp := now + 300

	t.Run("absolute", func(t *testing.T) {
		testSecret(t, "https://kitp.example.com/")
		got := buildDownloadURL(99, "thumb", exp)
		if !strings.HasPrefix(got, "https://kitp.example.com/api/v1/attachment/99/dl?") {
			t.Fatalf("unexpected url: %s", got)
		}
		u, err := url.Parse(got)
		if err != nil {
			t.Fatalf("parse: %v", err)
		}
		q := u.Query()
		if q.Get("mode") != "thumb" || q.Get("exp") != strconv.FormatInt(exp, 10) || q.Get("sig") == "" {
			t.Fatalf("bad query: %v", q)
		}
		// The minted sig must verify.
		if err := verifyDownloadURL(99, "thumb", exp, q.Get("sig"), now); err != nil {
			t.Fatalf("minted url failed verification: %v", err)
		}
	})

	t.Run("relative when no public url", func(t *testing.T) {
		testSecret(t, "")
		got := buildDownloadURL(5, "download", exp)
		if !strings.HasPrefix(got, "/api/v1/attachment/5/dl?") {
			t.Fatalf("want site-relative path, got: %s", got)
		}
	})
}

// TestSignDownloadURLs exercises the PostRun hook end-to-end: it should
// stamp a fresh expiry + a verifiable signed URL onto each
// DownloadURLOutput the SQL layer produced.
func TestSignDownloadURLs(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	outs := []any{
		DownloadURLOutput{ID: 123, Mode: "download", Filename: "a.pdf", MimeType: "application/pdf", SizeBytes: 10},
		DownloadURLOutput{ID: 124, Mode: "view"},
	}
	if err := signDownloadURLs(context.TODO(), nil, nil, outs); err != nil {
		t.Fatalf("signDownloadURLs: %v", err)
	}
	for i, raw := range outs {
		out := raw.(DownloadURLOutput)
		if out.URL == "" || out.ExpiresAt == "" {
			t.Fatalf("out[%d] missing url/expires_at: %+v", i, out)
		}
		u, err := url.Parse(out.URL)
		if err != nil {
			t.Fatalf("out[%d] parse url: %v", i, err)
		}
		q := u.Query()
		expN, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
		if err := verifyDownloadURL(out.ID, out.Mode, expN, q.Get("sig"), time.Now().Unix()); err != nil {
			t.Fatalf("out[%d] minted url failed verification: %v", i, err)
		}
		if _, err := time.Parse(time.RFC3339, out.ExpiresAt); err != nil {
			t.Fatalf("out[%d] expires_at not RFC3339: %q", i, out.ExpiresAt)
		}
	}
}

// TestSignDownloadURLs_NoSecret confirms the PostRun fails the batch
// rather than emitting an unverifiable link when the secret is unset.
func TestSignDownloadURLs_NoSecret(t *testing.T) {
	SetLinkDeps("https://kitp.example.com", nil)
	t.Cleanup(func() { SetLinkDeps("", nil) })
	err := signDownloadURLs(context.TODO(), nil, nil, []any{DownloadURLOutput{ID: 1, Mode: "download"}})
	if err == nil {
		t.Fatalf("expected error when secret unset")
	}
}

// TestHandleSignedStream_RejectsBadSignature verifies the public route
// refuses an invalid signature before it ever touches the DB/Storage
// (cfg is zero-valued here, so reaching streamBytes would panic).
func TestHandleSignedStream_RejectsBadSignature(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	req := httptest.NewRequest("GET", "/api/v1/attachment/9/dl?mode=download&exp="+
		strconv.FormatInt(time.Now().Unix()+60, 10)+"&sig=bogus", nil)
	req.SetPathValue("id", "9")
	w := httptest.NewRecorder()
	err := handleSignedStream(req.Context(), w, req, Config{})
	var he *api.HTTPError
	if !errors.As(err, &he) || he.Status != 403 {
		t.Fatalf("want 403 for bad signature, got %v", err)
	}
}
