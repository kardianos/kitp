package oidc

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
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

// TestAHungUpCallerDoesntCancelTheKeyFetch (review 2026-11-06 #4): the
// caller that starts a JWKS fetch hanging up — on a logout route, anyone —
// doesn't cancel it: the keys still load, and a sign-in right after finds
// the IdP's key instead of waiting out jwksMissRefresh.
func TestAHungUpCallerDoesntCancelTheKeyFetch(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
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
			jwk := map[string]string{
				"kty": "RSA", "kid": "real", "alg": "RS256", "use": "sig",
				"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
				"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
			}
			if err := json.NewEncoder(w).Encode(map[string]any{"keys": []any{jwk}}); err != nil {
				t.Error(err)
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	v := NewValidator(&Config{Issuer: srv.URL}, nil)

	// The stranger's request: a made-up kid, gone 20ms in, mid-fetch.
	hangUp, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := v.lookupKey(hangUp, "made-up")
		done <- err
	}()
	time.Sleep(100 * time.Millisecond)
	close(release)
	if err := <-done; err == nil {
		t.Error("a made-up kid found a key")
	}

	// The real sign-in, inside the miss window: the key is there.
	ctx, cancel2 := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel2()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := v.knownKey("real"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the cancelled caller's fetch never loaded the keys")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := v.lookupKey(ctx, "real"); err != nil {
		t.Fatalf("the sign-in after a hung-up fetch: %v", err)
	}
	if n := fetches.Load(); n != 1 {
		t.Errorf("%d JWKS fetches, want 1", n)
	}
}
