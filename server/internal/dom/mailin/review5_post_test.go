package mailin_test

// Regression test for the fifth 2026-11-03 review, #15.

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/dom/mailin"
)

// TestSlowBodiesHoldOnlyTheirRoute (#15): uploads that never finish, sent
// with one route's token, take that route's read slots, not every route's;
// a third on the same route is told to come back.
func TestSlowBodiesHoldOnlyTheirRoute(t *testing.T) {
	f := setup(t, "kitp_test_r5_post_slow")
	slowRoute := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, nil, "")
	otherRoute := f.route(t, mailin.PurposePOST, mailin.ProviderRaw, nil, "")
	srv := httptest.NewServer(f.handler(0))
	defer srv.Close()

	var writers []*io.PipeWriter
	defer func() {
		for _, w := range writers {
			_ = w.Close()
		}
	}()
	for i := 0; i < 4; i++ {
		pr, pw := io.Pipe()
		writers = append(writers, pw)
		req, err := http.NewRequest("POST", srv.URL+mailin.InboundPathPrefix+slowRoute.Token, pr)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Content-Type", "message/rfc822")
		go func() {
			if resp, err := http.DefaultClient.Do(req); err == nil {
				resp.Body.Close()
			}
		}()
		go func() { _, _ = pw.Write([]byte("From: a@example.com\r\n")) }() // a first byte, then nothing
	}
	time.Sleep(500 * time.Millisecond)

	resp, err := http.Post(srv.URL+mailin.InboundPathPrefix+otherRoute.Token, "message/rfc822",
		bytes.NewReader(mailText("<post-slow@example.com>", "Ada <ada@example.com>", "Hello")))
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode == http.StatusServiceUnavailable {
		t.Errorf("another route's message while one route's uploads hang: %d %s", resp.StatusCode, bytes.TrimSpace(body))
	}

	resp, err = http.Post(srv.URL+mailin.InboundPathPrefix+slowRoute.Token, "message/rfc822",
		bytes.NewReader(mailText("<post-slow-2@example.com>", "Ada <ada@example.com>", "Hello")))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("the hanging route's next message: %d, want 503 (its read slots are taken)", resp.StatusCode)
	}
}
