// Package oidc implements server-side OIDC token validation + automatic
// user provisioning for kitp.
//
// The flow:
//   1. Discover the OP via `<issuer>/.well-known/openid-configuration`.
//   2. Validate `Authorization: Bearer <jwt>` headers using the OP's JWKS
//      (cached for 10 minutes; refresh on kid miss).
//   3. On first valid token for a `sub`, insert a user_account row and
//      apply role mappings from the role_mapping table.
//   4. Cache (sub -> user id, claims hash, expires_at) for 5 minutes;
//      reload when the claims hash changes (re-applies role mappings).
//
// Only the validation/provisioning logic lives here. The HTTP middleware
// in middleware.go consumes Validator and stamps the resolved actor on
// the request context.
package oidc

import (
	"context"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds the runtime knobs read from the environment at startup.
type Config struct {
	Issuer        string   // e.g. "http://localhost:5556/dex"
	Audience      string   // expected `aud` claim
	RoleClaim     string   // claim to read for role mapping; default "groups"
	DefaultRole   string   // role granted when no claim matches; default "worker"
	RequiredPairs [][2]string
}

// FromEnv builds a Config from the standard env vars. Returns nil when
// OIDC_ISSUER is empty so the caller can decide that AUTH_MODE=oidc is
// invalid (production refusal lives in main.go).
func FromEnv(env func(string) string) *Config {
	issuer := env("OIDC_ISSUER")
	if issuer == "" {
		return nil
	}
	cfg := &Config{
		Issuer:      issuer,
		Audience:    env("OIDC_AUDIENCE"),
		RoleClaim:   env("OIDC_ROLE_CLAIM"),
		DefaultRole: env("OIDC_DEFAULT_ROLE"),
	}
	if cfg.RoleClaim == "" {
		cfg.RoleClaim = "groups"
	}
	if cfg.DefaultRole == "" {
		cfg.DefaultRole = "worker"
	}
	if req := env("OIDC_REQUIRED_CLAIMS"); req != "" {
		for _, kv := range strings.Split(req, ",") {
			pair := strings.SplitN(strings.TrimSpace(kv), "=", 2)
			if len(pair) == 2 {
				cfg.RequiredPairs = append(cfg.RequiredPairs, [2]string{pair[0], pair[1]})
			}
		}
	}
	return cfg
}

// discoveryDoc is the subset of openid-configuration we care about.
type discoveryDoc struct {
	Issuer  string `json:"issuer"`
	JWKSURL string `json:"jwks_uri"`
}

// jwksDoc is the subset of JWKS we care about (RSA keys with kid).
type jwksDoc struct {
	Keys []jwksKey `json:"keys"`
}

type jwksKey struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// Validator owns the JWKS cache, claims cache, and DB pool. One per process.
type Validator struct {
	cfg    *Config
	pool   *pgxpool.Pool
	client *http.Client

	mu              sync.RWMutex
	disco           *discoveryDoc
	jwksKeys        map[string]*rsa.PublicKey
	jwksFetchedAt   time.Time
	subCache        map[string]*subRecord // sub -> cached resolution
	jwksTTL         time.Duration
	subTTL          time.Duration
}

// subRecord is the cached resolution for one subject.
type subRecord struct {
	UserID      int64
	DisplayName string
	ClaimsHash  string
	ExpiresAt   time.Time
}

// NewValidator builds a validator. cfg must be non-nil; pool must be open.
func NewValidator(cfg *Config, pool *pgxpool.Pool) *Validator {
	return &Validator{
		cfg:      cfg,
		pool:     pool,
		client:   &http.Client{Timeout: 5 * time.Second},
		jwksKeys: map[string]*rsa.PublicKey{},
		subCache: map[string]*subRecord{},
		jwksTTL:  10 * time.Minute,
		subTTL:   5 * time.Minute,
	}
}

// Resolve validates the bearer token and returns the corresponding internal
// user id + display name, provisioning a user_account row on first sight.
//
// `bearer` is the value of the Authorization header MINUS the "Bearer "
// prefix.
func (v *Validator) Resolve(ctx context.Context, bearer string) (int64, string, error) {
	if bearer == "" {
		return 0, "", errors.New("oidc: empty token")
	}

	tok, err := v.parseAndVerify(ctx, bearer)
	if err != nil {
		return 0, "", err
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return 0, "", errors.New("oidc: claims not a map")
	}

	sub, _ := claims["sub"].(string)
	if sub == "" {
		return 0, "", errors.New("oidc: token has empty sub")
	}

	// Required-claim guard.
	for _, pair := range v.cfg.RequiredPairs {
		val, ok := claims[pair[0]].(string)
		if !ok || val != pair[1] {
			return 0, "", fmt.Errorf("oidc: required claim %s=%s not present", pair[0], pair[1])
		}
	}

	hash := claimsHash(claims)
	now := time.Now()

	// Cache hit?
	v.mu.RLock()
	rec := v.subCache[sub]
	v.mu.RUnlock()
	if rec != nil && rec.ClaimsHash == hash && now.Before(rec.ExpiresAt) {
		return rec.UserID, rec.DisplayName, nil
	}

	// Provision (create on first sight) and apply role mappings.
	userID, name, err := v.provisionUser(ctx, sub, claims)
	if err != nil {
		return 0, "", err
	}
	v.mu.Lock()
	v.subCache[sub] = &subRecord{
		UserID:      userID,
		DisplayName: name,
		ClaimsHash:  hash,
		ExpiresAt:   now.Add(v.subTTL),
	}
	v.mu.Unlock()
	return userID, name, nil
}

// parseAndVerify decodes the JWT, fetches the public key by kid, verifies
// the signature, and validates the standard claims (iss, aud, exp, nbf).
func (v *Validator) parseAndVerify(ctx context.Context, raw string) (*jwt.Token, error) {
	keyFn := func(t *jwt.Token) (any, error) {
		// Only accept RSA-signed tokens; HS or none are rejected.
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("oidc: unexpected signing alg %v", t.Method.Alg())
		}
		kid, _ := t.Header["kid"].(string)
		key, err := v.lookupKey(ctx, kid)
		if err != nil {
			return nil, err
		}
		return key, nil
	}
	parser := jwt.NewParser(
		jwt.WithIssuer(v.cfg.Issuer),
		jwt.WithExpirationRequired(),
	)
	if v.cfg.Audience != "" {
		parser = jwt.NewParser(
			jwt.WithIssuer(v.cfg.Issuer),
			jwt.WithAudience(v.cfg.Audience),
			jwt.WithExpirationRequired(),
		)
	}
	tok, err := parser.Parse(raw, keyFn)
	if err != nil {
		return nil, fmt.Errorf("oidc: parse: %w", err)
	}
	if !tok.Valid {
		return nil, errors.New("oidc: invalid token")
	}
	return tok, nil
}

// lookupKey returns the RSA public key for kid, refreshing JWKS on miss.
func (v *Validator) lookupKey(ctx context.Context, kid string) (*rsa.PublicKey, error) {
	v.mu.RLock()
	if key, ok := v.jwksKeys[kid]; ok {
		expired := time.Since(v.jwksFetchedAt) >= v.jwksTTL
		v.mu.RUnlock()
		if !expired {
			return key, nil
		}
	} else {
		v.mu.RUnlock()
	}
	if err := v.refreshJWKS(ctx); err != nil {
		return nil, err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if key, ok := v.jwksKeys[kid]; ok {
		return key, nil
	}
	return nil, fmt.Errorf("oidc: no key for kid=%s", kid)
}

// refreshJWKS re-fetches discovery + JWKS. Called on first use, on TTL
// expiry, and on kid miss.
func (v *Validator) refreshJWKS(ctx context.Context) error {
	if v.disco == nil {
		req, err := http.NewRequestWithContext(ctx, "GET",
			strings.TrimRight(v.cfg.Issuer, "/")+"/.well-known/openid-configuration", nil)
		if err != nil {
			return err
		}
		resp, err := v.client.Do(req)
		if err != nil {
			return fmt.Errorf("oidc: discovery: %w", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return fmt.Errorf("oidc: discovery status %d", resp.StatusCode)
		}
		var doc discoveryDoc
		if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
			return fmt.Errorf("oidc: discovery decode: %w", err)
		}
		v.mu.Lock()
		v.disco = &doc
		v.mu.Unlock()
	}

	v.mu.RLock()
	jwksURL := v.disco.JWKSURL
	v.mu.RUnlock()

	req, err := http.NewRequestWithContext(ctx, "GET", jwksURL, nil)
	if err != nil {
		return err
	}
	resp, err := v.client.Do(req)
	if err != nil {
		return fmt.Errorf("oidc: jwks: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("oidc: jwks status %d", resp.StatusCode)
	}
	var doc jwksDoc
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return fmt.Errorf("oidc: jwks decode: %w", err)
	}
	keys := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		key, err := buildRSAKey(k.N, k.E)
		if err != nil {
			continue
		}
		keys[k.Kid] = key
	}
	v.mu.Lock()
	v.jwksKeys = keys
	v.jwksFetchedAt = time.Now()
	v.mu.Unlock()
	return nil
}

// buildRSAKey decodes the modulus / exponent (base64url) into an rsa.PublicKey.
func buildRSAKey(nB64, eB64 string) (*rsa.PublicKey, error) {
	nBytes, err := jwt.NewParser().DecodeSegment(nB64)
	if err != nil {
		return nil, err
	}
	eBytes, err := jwt.NewParser().DecodeSegment(eB64)
	if err != nil {
		return nil, err
	}
	n := new(big.Int).SetBytes(nBytes)
	// e is a small integer; pad to 8 bytes for binary.BigEndian.
	var eBuf [8]byte
	copy(eBuf[8-len(eBytes):], eBytes)
	e := int(binary.BigEndian.Uint64(eBuf[:]))
	return &rsa.PublicKey{N: n, E: e}, nil
}

// claimsHash is a fast non-cryptographic-collision-resistant hash of the
// claims relevant to role mapping. We hash sub + the role claim's value(s)
// + email so a token rotation that doesn't change roles doesn't blow the
// cache.
func claimsHash(c jwt.MapClaims) string {
	h := sha256.New()
	for _, k := range []string{"sub", "groups", "email", "name", "preferred_username"} {
		if v, ok := c[k]; ok {
			b, _ := json.Marshal(v)
			h.Write([]byte(k))
			h.Write([]byte("="))
			h.Write(b)
			h.Write([]byte("\n"))
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}

// provisionUser ensures a user_account row exists for sub and (re-)applies
// role grants from claims via the role_mapping table. Returns the user id
// and the display name we settled on.
func (v *Validator) provisionUser(ctx context.Context, sub string, claims jwt.MapClaims) (int64, string, error) {
	displayName, _ := claims["name"].(string)
	if displayName == "" {
		displayName, _ = claims["preferred_username"].(string)
	}
	if displayName == "" {
		displayName, _ = claims["email"].(string)
	}
	if displayName == "" {
		displayName = sub
	}
	email, _ := claims["email"].(string)

	var userID int64
	row := v.pool.QueryRow(ctx, `SELECT id FROM user_account WHERE oidc_sub = $1`, sub)
	err := row.Scan(&userID)
	if err != nil {
		// Not found: insert.
		row = v.pool.QueryRow(ctx, `
			INSERT INTO user_account (oidc_sub, display_name, email)
			VALUES ($1, $2, NULLIF($3, ''))
			RETURNING id
		`, sub, displayName, email)
		if err := row.Scan(&userID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision insert: %w", err)
		}
	} else {
		// Update display_name + email if they changed (cheap upsert-ish).
		_, err = v.pool.Exec(ctx, `
			UPDATE user_account
			SET display_name = $2,
			    email = CASE WHEN $3 = '' THEN email ELSE $3 END
			WHERE id = $1
		`, userID, displayName, email)
		if err != nil {
			return 0, "", fmt.Errorf("oidc: provision update: %w", err)
		}
	}

	// Apply role mapping.
	values := claimValues(claims, v.cfg.RoleClaim)
	matched := false
	if len(values) > 0 {
		for _, val := range values {
			var roleID int32
			row := v.pool.QueryRow(ctx, `SELECT role_id FROM role_mapping WHERE claim_value = $1`, val)
			if err := row.Scan(&roleID); err == nil {
				if _, err := v.pool.Exec(ctx, `
					INSERT INTO user_role (user_id, role_id, scope_card_id)
					VALUES ($1, $2, NULL)
					ON CONFLICT DO NOTHING
				`, userID, roleID); err != nil {
					return 0, "", fmt.Errorf("oidc: apply role: %w", err)
				}
				matched = true
			}
		}
	}
	if !matched && v.cfg.DefaultRole != "" {
		var roleID int32
		row := v.pool.QueryRow(ctx, `SELECT id FROM role WHERE name = $1`, v.cfg.DefaultRole)
		if err := row.Scan(&roleID); err == nil {
			_, _ = v.pool.Exec(ctx, `
				INSERT INTO user_role (user_id, role_id, scope_card_id)
				VALUES ($1, $2, NULL) ON CONFLICT DO NOTHING
			`, userID, roleID)
		}
	}
	return userID, displayName, nil
}

// claimValues returns every value of the named claim. Handles both single-
// string claims and array-of-string claims; non-string values are skipped.
func claimValues(c jwt.MapClaims, key string) []string {
	v, ok := c[key]
	if !ok {
		return nil
	}
	switch val := v.(type) {
	case string:
		return []string{val}
	case []any:
		out := []string{}
		for _, e := range val {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}
