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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// jwksServer serves discovery and a JWKS holding key as kid "real" (or no
// keys once dropped), and answers 503 while down.
type jwksServer struct {
	srv     *httptest.Server
	down    atomic.Bool
	dropped atomic.Bool
	fetches atomic.Int32
}

func newJWKSServer(t *testing.T, key *rsa.PrivateKey) *jwksServer {
	t.Helper()
	j := &jwksServer{}
	j.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/.well-known/openid-configuration":
			if err := json.NewEncoder(w).Encode(map[string]string{"issuer": j.srv.URL, "jwks_uri": j.srv.URL + "/jwks"}); err != nil {
				t.Error(err)
			}
		case "/jwks":
			j.fetches.Add(1)
			if j.down.Load() {
				http.Error(w, "down", http.StatusServiceUnavailable)
				return
			}
			keys := []any{}
			if !j.dropped.Load() {
				keys = append(keys, map[string]string{"kty": "RSA", "kid": "real",
					"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
					"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes())})
			}
			if err := json.NewEncoder(w).Encode(map[string]any{"keys": keys}); err != nil {
				t.Error(err)
			}
		}
	}))
	t.Cleanup(j.srv.Close)
	return j
}

// TestAHeldKeyOutlivesAFailedRefresh (review 2026-11-06 round 8 L11):
// while the IdP's keys endpoint is down, a key kitp holds still verifies,
// past jwksTTL, with one refetch per jwksMissRefresh rather than one per
// lookup; a refresh that works and no longer lists the key ends it; and a
// key held too long past its fetch isn't used.
func TestAHeldKeyOutlivesAFailedRefresh(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	j := newJWKSServer(t, key)
	v := NewValidator(&Config{Issuer: j.srv.URL}, nil)
	v.jwksTTL = 20 * time.Millisecond
	ctx := context.Background()
	if _, err := v.lookupKey(ctx, "real"); err != nil {
		t.Fatal(err)
	}
	j.down.Store(true)
	time.Sleep(30 * time.Millisecond)
	v.mu.Lock()
	v.jwksTriedAt = time.Now().Add(-time.Hour) // the last try was a while ago
	v.mu.Unlock()
	before := j.fetches.Load()
	for i := 0; i < 5; i++ {
		if _, err := v.lookupKey(ctx, "real"); err != nil {
			t.Errorf("lookup %d of a held key while the keys endpoint is down: %v", i, err)
		}
	}
	if n := j.fetches.Load() - before; n != 1 {
		t.Errorf("%d fetches for 5 lookups, want 1", n)
	}
	// Up again, without the key: once the next try is due, it's gone.
	j.down.Store(false)
	j.dropped.Store(true)
	v.mu.Lock()
	v.jwksTriedAt = time.Time{}
	v.mu.Unlock()
	if _, err := v.lookupKey(ctx, "real"); err == nil {
		t.Error("a key the IdP no longer lists still verifies")
	}

	// Held, but fetched longer ago than jwksTTL + jwksMaxStale.
	j.dropped.Store(false)
	v2 := NewValidator(&Config{Issuer: j.srv.URL}, nil)
	if _, err := v2.lookupKey(ctx, "real"); err != nil {
		t.Fatal(err)
	}
	j.down.Store(true)
	v2.mu.Lock()
	v2.jwksFetchedAt = time.Now().Add(-(v2.jwksTTL + jwksMaxStale + time.Minute))
	v2.mu.Unlock()
	if _, err := v2.lookupKey(ctx, "real"); err == nil {
		t.Error("a key held past jwksMaxStale still verifies while the refresh fails")
	}
}

// TestKeyLookupsRaceFree: lookups, discovery and refreshes at once (run
// with -race; refreshJWKS read v.disco without the lock).
func TestKeyLookupsRaceFree(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	j := newJWKSServer(t, key)
	v := NewValidator(&Config{Issuer: j.srv.URL}, nil)
	v.jwksTTL = time.Nanosecond
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for k := 0; k < 20; k++ {
				if _, err := v.lookupKey(ctx, "real"); err != nil {
					t.Errorf("lookup: %v", err)
					return
				}
				if _, err := v.TokenEndpoint(ctx); err != nil && !strings.Contains(err.Error(), "token_endpoint") {
					t.Errorf("token endpoint: %v", err)
					return
				}
			}
		}()
	}
	wg.Wait()
}

// TestTheStateCookieFitsABrowser (review 2026-11-06 round 8 L10): a deep
// link safeLocalRedirect keeps seals to a cookie a browser keeps — its
// '&'s one byte each — and one that would still be too large signs in to
// "/" instead of failing.
func TestTheStateCookieFitsABrowser(t *testing.T) {
	cfg := BFFConfig{StateKey: []byte("k")}
	for _, c := range []struct {
		raw      string
		wantKept bool
	}{
		{"/tasks?" + strings.Repeat("a=1&", 325), true}, // 1307 bytes: 4.2 KB before
		{"/" + strings.Repeat("&", 2000), true},
		{"/" + strings.Repeat(`"`, 2000), false}, // \" twice the bytes
	} {
		red := safeLocalRedirect(c.raw)
		if red != c.raw {
			t.Fatalf("safeLocalRedirect dropped %.20q…", c.raw)
		}
		state, err := randomURLString(24)
		if err != nil {
			t.Fatal(err)
		}
		sealed, err := sealState(cfg, signInState{State: state, Verifier: strings.Repeat("v", 64), Nonce: strings.Repeat("n", 32),
			Redirect: red, Expires: time.Now().Add(time.Minute).Unix()})
		if err != nil {
			t.Fatal(err)
		}
		if size := len(stateCookieName(state)) + 1 + len(sealed); size > maxStateCookieBytes {
			t.Errorf("%.20q…: a %d-byte cookie", c.raw, size)
		}
		st, err := openState(cfg, state, sealed, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if got := st.Redirect == c.raw; got != c.wantKept {
			t.Errorf("%.20q…: redirect kept %v, want %v (got %.20q)", c.raw, got, c.wantKept, st.Redirect)
		}
		if !c.wantKept && st.Redirect != "/" {
			t.Errorf("a redirect too large returns to %q, want /", st.Redirect)
		}
	}
}
