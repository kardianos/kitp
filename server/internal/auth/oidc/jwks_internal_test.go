package oidc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestUnknownKidFetchesOnce (review 2026-11-05 round 6): tokens naming
// made-up kids fetch the IdP's keys at most once per jwksMissRefresh, a
// fetch that fails included, and callers arriving during a fetch share it.
func TestUnknownKidFetchesOnce(t *testing.T) {
	var fetches atomic.Int32
	release := make(chan struct{})
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			if err := json.NewEncoder(w).Encode(map[string]string{"issuer": srv.URL, "jwks_uri": srv.URL + "/jwks"}); err != nil {
				t.Error(err)
			}
		case "/jwks":
			fetches.Add(1)
			<-release
			http.Error(w, "down", http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	v := NewValidator(&Config{Issuer: srv.URL}, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var wg sync.WaitGroup
	for range 5 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := v.lookupKey(ctx, "made-up"); err == nil {
				t.Error("a made-up kid found a key")
			}
		}()
	}
	time.Sleep(200 * time.Millisecond) // let them all arrive during the fetch
	close(release)
	wg.Wait()
	if _, err := v.lookupKey(ctx, "another"); err == nil {
		t.Error("another made-up kid found a key")
	}
	if n := fetches.Load(); n != 1 {
		t.Errorf("%d JWKS fetches, want 1 (concurrent callers share it; a failed one waits too)", n)
	}
}
