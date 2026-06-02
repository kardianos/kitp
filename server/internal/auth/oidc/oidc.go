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
	"log/slog"
	"math/big"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/textnorm"
)

// Config holds the runtime knobs read from the environment at startup.
type Config struct {
	Issuer        string   // e.g. "http://localhost:5556/dex"
	Audience      string   // expected `aud` claim
	RoleClaim     string   // claim to read for role mapping; default "groups"
	DefaultRole   string   // role granted when no claim matches; default "worker"
	RequiredPairs [][2]string

	// BFF redirect knobs. ClientID is required for the
	// /api/v1/auth/oidc/start redirect; ClientSecret is required for
	// confidential clients (the token endpoint exchange in /callback).
	// RedirectURI must match what's registered with the OP; we default
	// to "<server>/api/v1/auth/oidc/callback" if main.go doesn't set it.
	ClientID     string
	ClientSecret string
	RedirectURI  string
	Scopes       string // space-separated; default "openid profile email"

	// PostLogoutRedirectURI is where the OP sends the browser back after
	// RP-initiated logout (unified logout / Single Logout). Must be an
	// absolute URL registered with the OP. Defaults to the origin of
	// RedirectURI + "/" when unset.
	PostLogoutRedirectURI string

	// TrustUnverifiedEmail disables the `email_verified == true`
	// requirement on the pre-created-account email fallback (see
	// provisionUser). Default false — only flip when the OP is
	// known to verify emails out-of-band (corporate AAD, Google
	// Workspace, etc.). Leaving the gate ON for a self-service OP
	// blocks the bootstrap-by-email attack: an attacker who knows
	// the env-supplied admin email would otherwise sign in first,
	// claim the email without verification, and attach their sub
	// to the pre-created admin row.
	TrustUnverifiedEmail bool
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
	cfg.ClientID = env("OIDC_CLIENT_ID")
	cfg.ClientSecret = env("OIDC_CLIENT_SECRET")
	cfg.RedirectURI = env("OIDC_REDIRECT_URI")
	cfg.Scopes = env("OIDC_SCOPES")
	if cfg.Scopes == "" {
		cfg.Scopes = "openid profile email"
	}
	cfg.PostLogoutRedirectURI = env("OIDC_POST_LOGOUT_REDIRECT_URI")
	if cfg.PostLogoutRedirectURI == "" && cfg.RedirectURI != "" {
		if u, err := url.Parse(cfg.RedirectURI); err == nil && u.Scheme != "" && u.Host != "" {
			cfg.PostLogoutRedirectURI = u.Scheme + "://" + u.Host + "/"
		}
	}
	if req := env("OIDC_REQUIRED_CLAIMS"); req != "" {
		for _, kv := range strings.Split(req, ",") {
			pair := strings.SplitN(strings.TrimSpace(kv), "=", 2)
			if len(pair) == 2 {
				cfg.RequiredPairs = append(cfg.RequiredPairs, [2]string{pair[0], pair[1]})
			}
		}
	}
	cfg.TrustUnverifiedEmail = env("KITP_OIDC_TRUST_UNVERIFIED_EMAIL") == "1"
	return cfg
}

// discoveryDoc is the subset of openid-configuration we care about.
type discoveryDoc struct {
	Issuer                string `json:"issuer"`
	JWKSURL               string `json:"jwks_uri"`
	AuthorizationEndpoint string `json:"authorization_endpoint"`
	TokenEndpoint         string `json:"token_endpoint"`
	EndSessionEndpoint    string `json:"end_session_endpoint"`
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

// AuthorizationEndpoint returns the OP's authorize URL. May trigger a
// discovery fetch on first call. Used by the BFF /oidc/start handler.
func (v *Validator) AuthorizationEndpoint(ctx context.Context) (string, error) {
	if err := v.ensureDiscovery(ctx); err != nil {
		return "", err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.disco.AuthorizationEndpoint == "" {
		return "", fmt.Errorf("oidc: discovery missing authorization_endpoint")
	}
	return v.disco.AuthorizationEndpoint, nil
}

// TokenEndpoint returns the OP's token URL.
func (v *Validator) TokenEndpoint(ctx context.Context) (string, error) {
	if err := v.ensureDiscovery(ctx); err != nil {
		return "", err
	}
	v.mu.RLock()
	defer v.mu.RUnlock()
	if v.disco.TokenEndpoint == "" {
		return "", fmt.Errorf("oidc: discovery missing token_endpoint")
	}
	return v.disco.TokenEndpoint, nil
}

// EndSessionURL builds the OP's RP-initiated logout URL (the unified-logout
// redirect): the browser is sent here after the local session is cleared so
// the IdP session ends too. Returns ok=false when the OP advertises no
// `end_session_endpoint` in discovery — the caller then falls back to a
// local-only logout (clear cookie + return to the app root).
//
// We pass `client_id` + `post_logout_redirect_uri` (the client_id form of
// RP-Initiated Logout). We deliberately don't persist the user's id_token
// server-side, so `id_token_hint` is omitted; OPs that REQUIRE the hint for
// a post-logout redirect will still end the session but may show their own
// "you are logged out" page instead of bouncing back.
func (v *Validator) EndSessionURL(ctx context.Context, postLogoutRedirect string) (string, bool, error) {
	if err := v.ensureDiscovery(ctx); err != nil {
		return "", false, err
	}
	v.mu.RLock()
	endpoint := v.disco.EndSessionEndpoint
	v.mu.RUnlock()
	if endpoint == "" {
		return "", false, nil
	}
	q := url.Values{}
	if v.cfg.ClientID != "" {
		q.Set("client_id", v.cfg.ClientID)
	}
	if postLogoutRedirect != "" {
		q.Set("post_logout_redirect_uri", postLogoutRedirect)
	}
	if enc := q.Encode(); enc != "" {
		return endpoint + "?" + enc, true, nil
	}
	return endpoint, true, nil
}

func (v *Validator) ensureDiscovery(ctx context.Context) error {
	v.mu.RLock()
	loaded := v.disco != nil
	v.mu.RUnlock()
	if loaded {
		return nil
	}
	return v.refreshJWKS(ctx)
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
	// Normalize OIDC-claim strings at ingress so the same human gets
	// the same person card regardless of how their IdP serialises
	// combining marks / case. Same helpers used by person.create +
	// person.upsert_by_email so all three ingress paths converge.
	displayName = textnorm.Name(displayName)
	email = textnorm.Email(email)

	// All provisioning happens in one tx (S2): the sub lookup, the
	// email fallback / pre-created attach, the fresh-insert OR
	// update branch, role mapping, default role, and the init-mode
	// admin grant. A failure anywhere rolls back to a clean state;
	// the old shape had the post-insert role grants on the bare
	// pool and left users half-provisioned on failure mid-block.
	tx, err := v.pool.Begin(ctx)
	if err != nil {
		return 0, "", fmt.Errorf("oidc: provision begin: %w", err)
	}
	defer tx.Rollback(ctx)

	var userID int64
	row := tx.QueryRow(ctx, `SELECT id FROM user_account WHERE oidc_sub = $1`, sub)
	subErr := row.Scan(&userID)
	if subErr != nil && !errors.Is(subErr, pgx.ErrNoRows) {
		return 0, "", fmt.Errorf("oidc: sub lookup: %w", subErr)
	}
	// `attached` true when we resolved to an existing row (either via
	// sub or via the pre-created-by-email fallback) and therefore
	// SKIP the fresh-insert + person-card creation block below.
	attached := subErr == nil
	// Gate the email fallback on `email_verified == true` unless the
	// operator has explicitly opted into trusting an OP that doesn't
	// verify emails (KITP_OIDC_TRUST_UNVERIFIED_EMAIL=1).
	//
	// Without this gate, an attacker who knows a pre-created admin's
	// email could sign into an OP that lets users self-claim emails
	// (consumer Google, etc.) and the fallback would attach their
	// sub to the admin's user_account row. See
	// DI-4 in docs/DESIGN_INVARIANTS.md.
	emailVerified, _ := claims["email_verified"].(bool)
	emailTrusted := emailVerified || v.cfg.TrustUnverifiedEmail
	if subErr != nil && email != "" && emailTrusted {
		// Sub didn't match. Before we insert a fresh row, check
		// whether an admin pre-created a user_account by email (see
		// person.create with tier='user') — those rows carry the
		// expected email but a NULL oidc_sub. If we find one, attach
		// our sub to it. We deliberately match only rows with
		// oidc_sub IS NULL so we don't rebind a row owned by a
		// different OIDC subject that happens to share an email.
		var preID int64
		preErr := tx.QueryRow(ctx, `
			SELECT id FROM user_account
			WHERE lower(email) = $1 AND oidc_sub IS NULL
			ORDER BY id
			LIMIT 1
		`, email).Scan(&preID)
		if preErr != nil && !errors.Is(preErr, pgx.ErrNoRows) {
			return 0, "", fmt.Errorf("oidc: email-fallback lookup: %w", preErr)
		}
		if preErr == nil {
			if _, uErr := tx.Exec(ctx, `
				UPDATE user_account
				SET oidc_sub = $1,
				    display_name = CASE WHEN coalesce(display_name, '') = '' THEN $2 ELSE display_name END
				WHERE id = $3
			`, sub, displayName, preID); uErr != nil {
				return 0, "", fmt.Errorf("oidc: attach sub to pre-created: %w", uErr)
			}
			userID = preID
			attached = true
		}
	}
	if !attached {
		// No row matched by sub OR by pre-created email. Insert a
		// fresh user_account + matching person card +
		// user_account_person link. card_type and attribute_def
		// lookups go through the in-table names (cheap; these rows
		// are seed-stable).
		if err := tx.QueryRow(ctx, `
			INSERT INTO user_account (oidc_sub, display_name, email)
			VALUES ($1, $2, NULLIF($3, ''))
			RETURNING id
		`, sub, displayName, email).Scan(&userID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision insert: %w", err)
		}
		var personCardID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO card (card_type_id, parent_card_id)
			SELECT id, NULL FROM card_type WHERE name = 'person'
			RETURNING id
		`).Scan(&personCardID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision person card: %w", err)
		}
		// card_create + title + (optional) email activity rows mirror
		// the runtime path so the activity stream looks consistent.
		if _, err := tx.Exec(ctx,
			`INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)`,
			personCardID, userID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision person activity: %w", err)
		}
		var titleActID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
			SELECT $1, 'attr_update', ad.id, NULL, to_jsonb($2::text), $3
			FROM attribute_def ad WHERE ad.name = 'title'
			RETURNING id
		`, personCardID, displayName, userID).Scan(&titleActID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision title activity: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
			SELECT $1, ad.id, to_jsonb($2::text), $3
			FROM attribute_def ad WHERE ad.name = 'title'
		`, personCardID, displayName, titleActID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision title value: %w", err)
		}
		if email != "" {
			var emailActID int64
			if err := tx.QueryRow(ctx, `
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT $1, 'attr_update', ad.id, NULL, to_jsonb($2::text), $3
				FROM attribute_def ad WHERE ad.name = 'email'
				RETURNING id
			`, personCardID, email, userID).Scan(&emailActID); err != nil {
				return 0, "", fmt.Errorf("oidc: provision email activity: %w", err)
			}
			if _, err := tx.Exec(ctx, `
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT $1, ad.id, to_jsonb($2::text), $3
				FROM attribute_def ad WHERE ad.name = 'email'
			`, personCardID, email, emailActID); err != nil {
				return 0, "", fmt.Errorf("oidc: provision email value: %w", err)
			}
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_account_person (user_account_id, person_card_id)
			VALUES ($1, $2)
		`, userID, personCardID); err != nil {
			return 0, "", fmt.Errorf("oidc: provision link: %w", err)
		}
	} else {
		// Re-login of an existing user. Sync email if the claim carries one,
		// but DO NOT touch display_name: it's set once at first provision and
		// thereafter owned by the app (user.set_display_name). Re-stamping the
		// IdP claim here would clobber a name the user changed in-app on every
		// login. (displayName is still computed above — it feeds the
		// fresh-insert + pre-created-attach branches, just not this one.)
		if _, err := tx.Exec(ctx, `
			UPDATE user_account
			SET email = CASE WHEN $2 = '' THEN email ELSE $2 END
			WHERE id = $1
		`, userID, email); err != nil {
			return 0, "", fmt.Errorf("oidc: provision update: %w", err)
		}
	}

	// Apply role mapping. The set of roles a user holds VIA OIDC
	// (user_role.granted_via = 'oidc') is reconciled to exactly what the
	// current claims justify: claim values are mapped to roles and granted
	// here, and any OIDC-granted role the claims no longer justify is
	// revoked below. Manual/admin grants (granted_via = 'manual') and
	// project-scoped rows are never touched. Insert errors fall into three
	// buckets:
	//   - ErrNoRows on role_mapping lookup: that claim value just
	//     isn't mapped, fall through to the next value.
	//   - Real DB error on the lookup: propagate (rollback).
	//   - Insert error: propagate.
	values := claimValues(claims, v.cfg.RoleClaim)
	// desired = the role_ids the current claims justify; the reconcile
	// DELETE keeps exactly these among the user's 'oidc' global grants.
	desired := make([]int64, 0, len(values)+1)
	for _, val := range values {
		var roleID int64
		err := tx.QueryRow(ctx, `SELECT role_id FROM role_mapping WHERE claim_value = $1`, val).Scan(&roleID)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, "", fmt.Errorf("oidc: role_mapping lookup %q: %w", val, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO user_role (user_id, role_id, scope_card_id, granted_via)
			VALUES ($1, $2, NULL, 'oidc')
			ON CONFLICT DO NOTHING
		`, userID, roleID); err != nil {
			return 0, "", fmt.Errorf("oidc: apply role: %w", err)
		}
		desired = append(desired, roleID)
	}
	if len(desired) == 0 && v.cfg.DefaultRole != "" {
		var roleID int64
		err := tx.QueryRow(ctx, `SELECT id FROM role WHERE name = $1`, v.cfg.DefaultRole).Scan(&roleID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Configured default_role doesn't exist in the role table —
			// a misconfiguration, not a runtime failure. Log and move on
			// so the user still ends up provisioned (just without a
			// default role).
			slog.Default().LogAttrs(ctx, slog.LevelWarn, "oidc default role not found",
				slog.String("role", v.cfg.DefaultRole))
		case err != nil:
			return 0, "", fmt.Errorf("oidc: default role lookup: %w", err)
		default:
			if _, err := tx.Exec(ctx, `
				INSERT INTO user_role (user_id, role_id, scope_card_id, granted_via)
				VALUES ($1, $2, NULL, 'oidc') ON CONFLICT DO NOTHING
			`, userID, roleID); err != nil {
				return 0, "", fmt.Errorf("oidc: apply default role: %w", err)
			}
			desired = append(desired, roleID)
		}
	}
	// Authoritative revoke — ONLY when the OP actually sent the role claim
	// (claims are used to map roles this login). Without the claim present
	// the OP isn't asserting roles, so we leave existing grants untouched.
	// With it present, drop any OIDC-granted GLOBAL role the current claims
	// no longer justify (e.g. the user was removed from a group in the IdP).
	// `<> ALL($2)` with an empty array deletes every 'oidc' global row,
	// which is correct: claims present but nothing mapped (and no default)
	// means no OIDC roles are justified.
	if claimPresent(claims, v.cfg.RoleClaim) {
		if _, err := tx.Exec(ctx, `
			DELETE FROM user_role
			WHERE user_id = $1
			  AND granted_via = 'oidc'
			  AND scope_card_id IS NULL
			  AND role_id <> ALL($2::bigint[])
		`, userID, desired); err != nil {
			return 0, "", fmt.Errorf("oidc: reconcile roles: %w", err)
		}
	}

	// Init-mode bootstrap. If no non-system user holds the admin role
	// globally yet, the first OIDC sign-in is the one that elevates
	// themselves to admin. This is the "bring-your-own-key" path that
	// fires when KITP_INIT_ADMIN_EMAIL was NOT set at startup
	// (otherwise the bootstrap already created and granted an admin,
	// so this branch is a no-op for subsequent users).
	if err := grantAdminIfInitMode(ctx, tx, userID); err != nil {
		return 0, "", fmt.Errorf("oidc: init-mode grant: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, "", fmt.Errorf("oidc: provision commit: %w", err)
	}
	return userID, displayName, nil
}

// grantAdminIfInitMode grants [userID] the global admin role iff no
// other non-system user (id != 1) already holds it.
//
// Called from `provisionUser` inside the request's provisioning tx
// (S2), so the predicate evaluates under the same MVCC snapshot as
// the rest of the provisioning steps. The `NOT EXISTS` subquery +
// INSERT is one statement; two concurrent first-time sign-ins
// cannot both pass the gate and both self-elevate. Documented in
// DI-2 in docs/DESIGN_INVARIANTS.md.
//
// ON CONFLICT DO NOTHING covers the "already an admin" case for
// the same user (rerunning the function with the same userID).
func grantAdminIfInitMode(ctx context.Context, tx pgx.Tx, userID int64) error {
	const systemUserID = 1
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		SELECT $1, r.id, NULL
		FROM role r
		WHERE r.name = 'admin'
		  AND NOT EXISTS (
		    SELECT 1
		    FROM user_role ur
		    JOIN role r2 ON r2.id = ur.role_id
		    WHERE r2.name = 'admin' AND ur.user_id <> $2
		  )
		ON CONFLICT DO NOTHING
	`, userID, systemUserID); err != nil {
		return fmt.Errorf("init-admin grant: %w", err)
	}
	return nil
}

// claimPresent reports whether the named claim KEY exists in the token at
// all — distinct from "present but empty". The role reconcile treats the
// claim as authoritative (and may revoke OIDC roles) only when the OP
// actually sent it this login; an absent claim means "not asserting roles",
// so existing grants are left alone.
func claimPresent(c jwt.MapClaims, key string) bool {
	_, ok := c[key]
	return ok
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
