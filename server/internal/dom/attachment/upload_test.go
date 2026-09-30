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
	"github.com/kitp/kitp/server/internal/auth"
)

func TestVerifyUploadURL(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	now := time.Now().Unix()
	exp := now + int64(linkTTL.Seconds())
	g := uploadGrant{CardID: 12, ActorID: 34, Filename: "a|b.pdf", MimeType: "application/pdf"}
	good := signUploadPayload(g, exp)
	with := func(mut func(*uploadGrant)) uploadGrant {
		c := g
		mut(&c)
		return c
	}

	cases := []struct {
		name    string
		g       uploadGrant
		exp     int64
		sig     string
		wantErr bool
	}{
		{name: "valid", g: g, exp: exp, sig: good},
		{name: "expired", g: g, exp: now - 1, sig: signUploadPayload(g, now-1), wantErr: true},
		{name: "far future", g: g, exp: now + 86400, sig: signUploadPayload(g, now+86400), wantErr: true},
		{name: "tampered sig", g: g, exp: exp, sig: good + "x", wantErr: true},
		{name: "other card", g: with(func(c *uploadGrant) { c.CardID++ }), exp: exp, sig: good, wantErr: true},
		{name: "other actor", g: with(func(c *uploadGrant) { c.ActorID++ }), exp: exp, sig: good, wantErr: true},
		{name: "other filename", g: with(func(c *uploadGrant) { c.Filename = "other.pdf" }), exp: exp, sig: good, wantErr: true},
		{name: "other mime", g: with(func(c *uploadGrant) { c.MimeType = "text/html" }), exp: exp, sig: good, wantErr: true},
		// A '|' in the filename must not let bytes shift into mime_type.
		{name: "field shift", g: with(func(c *uploadGrant) { c.Filename, c.MimeType = "a", "b.pdf|application/pdf" }), exp: exp, sig: good, wantErr: true},
		// A download signature for the same id never verifies as an upload.
		{name: "download sig replay", g: g, exp: exp, sig: signLinkPayload(g.CardID, "download", exp), wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := verifyUploadURL(tc.g, tc.exp, tc.sig, now)
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("valid link rejected: %v", err)
				}
				return
			}
			var he *api.HTTPError
			if !errors.As(err, &he) || he.Status != 403 {
				t.Fatalf("want 403 forbidden, got %v", err)
			}
		})
	}
}

func TestVerifyUploadURL_NoSecret(t *testing.T) {
	SetLinkDeps("", nil)
	t.Cleanup(func() { SetLinkDeps("", nil) })
	now := time.Now().Unix()
	err := verifyUploadURL(uploadGrant{CardID: 1, ActorID: 1, Filename: "a.txt"}, now+60, "anything", now)
	var he *api.HTTPError
	if !errors.As(err, &he) || he.Status != 500 {
		t.Fatalf("want 500 internal when secret unset, got %v", err)
	}
}

// TestSignUploadURLs exercises the PostRun hook: it binds the calling
// actor + a fresh expiry and emits a URL whose query round-trips back
// into a grant that verifies.
func TestSignUploadURLs(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	ctx := auth.WithUser(context.Background(), &auth.UserCtx{ID: 77})
	outs := []any{UploadURLOutput{CardID: 5, Filename: "notes v2 & more.txt", MimeType: "text/plain"}}
	if err := signUploadURLs(ctx, nil, nil, outs); err != nil {
		t.Fatalf("signUploadURLs: %v", err)
	}
	out := outs[0].(UploadURLOutput)
	if !strings.HasPrefix(out.URL, "https://kitp.example.com/api/v1/attachment/upload?") {
		t.Fatalf("unexpected url: %s", out.URL)
	}
	if _, err := time.Parse(time.RFC3339, out.ExpiresAt); err != nil {
		t.Fatalf("expires_at not RFC3339: %q", out.ExpiresAt)
	}
	u, err := url.Parse(out.URL)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	q := u.Query()
	if q.Get("actor_id") != "77" || q.Get("card_id") != "5" || q.Get("filename") != "notes v2 & more.txt" {
		t.Fatalf("bad query: %v", q)
	}
	expN, _ := strconv.ParseInt(q.Get("exp"), 10, 64)
	g := uploadGrant{CardID: 5, ActorID: 77, Filename: q.Get("filename"), MimeType: q.Get("mime_type")}
	if err := verifyUploadURL(g, expN, q.Get("sig"), time.Now().Unix()); err != nil {
		t.Fatalf("minted url failed verification: %v", err)
	}
}

// TestSignUploadURLs_Refuses confirms the PostRun fails the batch rather
// than emitting an unverifiable or actor-less link.
func TestSignUploadURLs_Refuses(t *testing.T) {
	cases := []struct {
		name   string
		secret []byte
		ctx    context.Context
	}{
		{name: "no secret", ctx: auth.WithUser(context.Background(), &auth.UserCtx{ID: 1})},
		{name: "no actor", secret: []byte("test-secret"), ctx: context.Background()},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			SetLinkDeps("", tc.secret)
			t.Cleanup(func() { SetLinkDeps("", nil) })
			err := signUploadURLs(tc.ctx, nil, nil, []any{UploadURLOutput{CardID: 1, Filename: "a.txt"}})
			if err == nil {
				t.Fatalf("expected error")
			}
		})
	}
}

// failReader fails the test if the upload route reads the body — every
// rejection below must happen before a single byte is consumed.
type failReader struct{ t *testing.T }

func (r failReader) Read([]byte) (int, error) {
	r.t.Error("body read before the link was verified")
	return 0, errors.New("unexpected read")
}

// TestHandleSignedUpload_RejectsBeforeBody verifies the public route
// refuses a malformed / unsigned / expired link without reading the
// body or touching the (zero-valued) Config.
func TestHandleSignedUpload_RejectsBeforeBody(t *testing.T) {
	testSecret(t, "https://kitp.example.com")
	now := time.Now().Unix()
	g := uploadGrant{CardID: 9, ActorID: 2, Filename: "a.txt", MimeType: "text/plain"}
	query := func(g uploadGrant, exp int64, sig string) string {
		q := url.Values{}
		q.Set("card_id", strconv.FormatInt(g.CardID, 10))
		q.Set("actor_id", strconv.FormatInt(g.ActorID, 10))
		q.Set("filename", g.Filename)
		q.Set("mime_type", g.MimeType)
		q.Set("exp", strconv.FormatInt(exp, 10))
		q.Set("sig", sig)
		return q.Encode()
	}
	cases := []struct {
		name       string
		query      string
		wantStatus int
	}{
		{name: "bad signature", query: query(g, now+60, "bogus"), wantStatus: 403},
		{name: "expired", query: query(g, now-1, signUploadPayload(g, now-1)), wantStatus: 403},
		{name: "missing card_id", query: "actor_id=2&exp=1&sig=x", wantStatus: 400},
		{name: "missing actor_id", query: "card_id=9&exp=1&sig=x", wantStatus: 400},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("PUT", "/api/v1/attachment/upload?"+tc.query, failReader{t})
			w := httptest.NewRecorder()
			err := handleSignedUpload(req.Context(), w, req, Config{})
			var he *api.HTTPError
			if !errors.As(err, &he) || he.Status != tc.wantStatus {
				t.Fatalf("want %d, got %v", tc.wantStatus, err)
			}
		})
	}
}
