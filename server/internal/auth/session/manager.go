// Package session owns the kitp server-side session store.
//
// The session id is an opaque 256-bit random string the kitp_session
// cookie carries; it never embeds a user id, a JWT, or any other
// content. Validation is a single indexed DB lookup gated by a
// configurable sliding window (idle TTL) and an absolute cap (idle
// TTL governs "must be touched at least this recently"; absolute cap
// governs "must have been issued at most this long ago"). Either gate
// expiring counts as "session over" and triggers a 401.
//
// Sliding touch is batched in process memory: every successful Lookup
// records the session id in `pendingTouch`; a background flush
// goroutine drains the map every `TouchInterval` (default 3 minutes)
// and issues a single bulk UPDATE. That keeps DB churn proportional
// to the active-session count rather than the request count, and the
// snapshot-isolation footprint is one short transaction per flush
// rather than one per request.
package session

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Default knobs. Override via Config when constructing a Manager.
const (
	DefaultIdleTTL       = 7 * 24 * time.Hour  // 7 days
	DefaultAbsoluteCap   = 45 * 24 * time.Hour // 45 days
	DefaultTouchInterval = 3 * time.Minute
)

// Config controls Manager lifetime behaviour. Zero values fall back
// to the Default* constants — the recommended path for callers that
// only want to tune one knob.
type Config struct {
	// IdleTTL is how long a session may go without a successful Lookup
	// before the DB gate rejects it. Set lower for stricter "stale
	// session" semantics, higher for "stay logged in".
	IdleTTL time.Duration
	// AbsoluteCap is the hard ceiling on a session's lifetime measured
	// from `created_at`. Re-auth required after this regardless of
	// activity. Use cases: compliance ("must re-confirm identity at
	// least monthly"), drift defence against compromised cookies.
	AbsoluteCap time.Duration
	// TouchInterval is how often the in-memory batch flushes pending
	// last_seen_at updates to the DB. Smaller = tighter sliding
	// freshness at the cost of more DB churn; larger = cheaper at the
	// cost of "stale by up to TouchInterval" on the DB last_seen_at.
	TouchInterval time.Duration
}

// User is the lookup result. The middleware copies these fields into
// the auth.UserCtx attached to the request context.
type User struct {
	ID          int64
	DisplayName string
}

// Manager owns the session table + in-memory touch batch.
type Manager struct {
	pool *pgxpool.Pool
	cfg  Config

	mu           sync.Mutex
	pendingTouch map[string]time.Time
}

// New returns a Manager with defaults applied for any zero-valued
// Config field. Call Start(ctx) before serving requests so the
// batched flush goroutine runs.
func New(pool *pgxpool.Pool, cfg Config) *Manager {
	if cfg.IdleTTL <= 0 {
		cfg.IdleTTL = DefaultIdleTTL
	}
	if cfg.AbsoluteCap <= 0 {
		cfg.AbsoluteCap = DefaultAbsoluteCap
	}
	if cfg.TouchInterval <= 0 {
		cfg.TouchInterval = DefaultTouchInterval
	}
	return &Manager{
		pool:         pool,
		cfg:          cfg,
		pendingTouch: make(map[string]time.Time),
	}
}

// Config returns the active configuration (defaults filled in). Useful
// for wiring the cookie Max-Age to the absolute cap.
func (m *Manager) Config() Config {
	return m.cfg
}

// RunTouch flushes any buffered last_active_at touches to the DB.
// Designed for the [job.Scheduler]: register it as a periodic job
// in main with `Interval: cfg.TouchInterval`. The scheduler owns
// the ticker; the caller is responsible for invoking [Manager.Flush]
// after the scheduler stops so in-flight touches aren't lost.
func (m *Manager) RunTouch(ctx context.Context) error {
	return m.flush(ctx)
}

// Flush forces an immediate flush of buffered touches. Call once
// during shutdown (after [job.Scheduler.Wait] returns) so the final
// batch of touches lands in the DB.
func (m *Manager) Flush(ctx context.Context) error {
	return m.flush(ctx)
}

// ErrNotFound is returned by Lookup when the cookie value names no
// session row (deleted, never existed, or typo).
var ErrNotFound = errors.New("session: not found")

// ErrExpired is returned by Lookup when the row exists but failed the
// idle / absolute / revoked gates. Distinct from ErrNotFound so the
// middleware can log a different metric.
var ErrExpired = errors.New("session: expired")

// Create stages a new session for userID and returns the opaque id
// the caller writes to the cookie. The id is 32 random bytes encoded
// as base64url (≈43 chars). oidcSub may be empty for dev-mode
// sessions; in OIDC mode it should be the verified `sub` claim so the
// session is traceable back to the OP subject.
func (m *Manager) Create(ctx context.Context, userID int64, oidcSub string) (string, error) {
	id, err := newSessionID()
	if err != nil {
		return "", fmt.Errorf("session: generate id: %w", err)
	}
	_, err = m.pool.Exec(ctx, `
		INSERT INTO session (id, user_id, oidc_sub)
		VALUES ($1, $2, NULLIF($3, ''))
	`, id, userID, oidcSub)
	if err != nil {
		return "", fmt.Errorf("session: insert: %w", err)
	}
	return id, nil
}

// Lookup resolves a cookie value to (user, error). On success it also
// records the session in the pending-touch batch so the next flush
// updates last_seen_at. Concurrent Lookups of the same id collapse
// into one DB write per flush window.
func (m *Manager) Lookup(ctx context.Context, id string) (*User, error) {
	if id == "" {
		return nil, ErrNotFound
	}
	var (
		userID      int64
		displayName string
		createdAt   time.Time
		lastSeenAt  time.Time
		revokedAt   *time.Time
	)
	row := m.pool.QueryRow(ctx, `
		SELECT s.user_id, ua.display_name, s.created_at, s.last_seen_at, s.revoked_at
		FROM session s
		JOIN user_account ua ON ua.id = s.user_id
		WHERE s.id = $1
	`, id)
	if err := row.Scan(&userID, &displayName, &createdAt, &lastSeenAt, &revokedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("session: lookup: %w", err)
	}
	if revokedAt != nil {
		return nil, ErrExpired
	}
	now := time.Now()
	if now.Sub(createdAt) > m.cfg.AbsoluteCap {
		return nil, ErrExpired
	}
	// The sliding gate compares against DB last_seen_at; any newer
	// in-memory touch is captured below for the next flush. This
	// effectively allows up to TouchInterval of stale-on-disk drift,
	// which is fine because IdleTTL is hours/days.
	if now.Sub(lastSeenAt) > m.cfg.IdleTTL {
		return nil, ErrExpired
	}
	m.mu.Lock()
	m.pendingTouch[id] = now
	m.mu.Unlock()
	return &User{ID: userID, DisplayName: displayName}, nil
}

// Revoke marks a session as revoked. Idempotent: revoking an unknown
// or already-revoked session returns nil so callers don't have to
// branch on "was it really there?" semantics.
func (m *Manager) Revoke(ctx context.Context, id string) error {
	if id == "" {
		return nil
	}
	_, err := m.pool.Exec(ctx, `
		UPDATE session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
	`, id)
	if err != nil {
		return fmt.Errorf("session: revoke: %w", err)
	}
	m.mu.Lock()
	delete(m.pendingTouch, id)
	m.mu.Unlock()
	return nil
}

// flush drains the pending-touch batch into a single UPDATE. Skipped
// when the batch is empty so an idle server doesn't poll the DB.
func (m *Manager) flush(ctx context.Context) error {
	m.mu.Lock()
	if len(m.pendingTouch) == 0 {
		m.mu.Unlock()
		return nil
	}
	ids := make([]string, 0, len(m.pendingTouch))
	// We collapse "most recent touch wins" by using now(): individual
	// touch timestamps are within a TouchInterval window of each other,
	// so one shared timestamp keeps the SQL simple without changing the
	// idle-gate accuracy.
	for id := range m.pendingTouch {
		ids = append(ids, id)
	}
	m.pendingTouch = make(map[string]time.Time, len(ids))
	m.mu.Unlock()

	_, err := m.pool.Exec(ctx, `
		UPDATE session SET last_seen_at = now()
		WHERE id = ANY($1::text[])
	`, ids)
	if err != nil {
		return fmt.Errorf("session: flush: %w", err)
	}
	return nil
}

// newSessionID returns 32 random bytes encoded as base64url (no
// padding). 256 bits of entropy; URL-safe so a future "share session
// link" feature wouldn't have to re-encode.
func newSessionID() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}
