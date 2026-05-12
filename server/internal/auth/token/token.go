// Package token validates the opaque bearer tokens stored in
// `user_token` and used by MCP (and future remote-MCP) clients to
// authenticate AS a specific user_account row.
//
// Same shape as session.id: 32 random bytes base64url-encoded. The
// validator does one indexed PK lookup, checks revoke / expiry, and
// returns the resolved (user_id, display_name). Touches are batched
// in process memory and flushed periodically — identical pattern to
// session.Manager so the wire profile of an active agent collapses
// to one `UPDATE user_token SET last_used_at = now() WHERE id =
// ANY(...)` per flush window.
package token

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

// Default knobs; override via Config when constructing.
const (
	DefaultTouchInterval = 3 * time.Minute
)

// Config controls Manager lifetime behaviour.
type Config struct {
	// TouchInterval is how often the in-memory batch flushes pending
	// last_used_at updates to the DB.
	TouchInterval time.Duration
}

// User is the lookup result. Mirrors session.User intentionally so
// the dispatcher / handlers don't have to fork on which credential
// kind authenticated the request.
type User struct {
	ID          int64
	DisplayName string
}

// ErrNotFound is returned when the token names no row.
var ErrNotFound = errors.New("token: not found")

// ErrExpired is returned when the row exists but is revoked or past
// expires_at.
var ErrExpired = errors.New("token: expired")

// Manager owns the user_token table + batched-touch state.
type Manager struct {
	pool *pgxpool.Pool
	cfg  Config

	mu          sync.Mutex
	pendingUse  map[string]time.Time
}

// New returns a Manager with defaults applied. Call Start(ctx) before
// serving requests so the batched flush goroutine runs.
func New(pool *pgxpool.Pool, cfg Config) *Manager {
	if cfg.TouchInterval <= 0 {
		cfg.TouchInterval = DefaultTouchInterval
	}
	return &Manager{
		pool:       pool,
		cfg:        cfg,
		pendingUse: make(map[string]time.Time),
	}
}

// Start launches the flush goroutine.
func (m *Manager) Start(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(m.cfg.TouchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = m.flush(context.Background())
				return
			case <-ticker.C:
				_ = m.flush(ctx)
			}
		}
	}()
}

// Create stages a new token bound to userID and returns the opaque
// value. The caller (typically the `agent.token.create` handler)
// MUST surface the returned string to the user exactly once — it
// cannot be recovered later. label / expiresAt may be empty / nil
// for "no description" / "no hard expiry".
func (m *Manager) Create(ctx context.Context, userID int64, label string, expiresAt *time.Time) (string, error) {
	id, err := newTokenID()
	if err != nil {
		return "", fmt.Errorf("token: generate id: %w", err)
	}
	if _, err := m.pool.Exec(ctx, `
		INSERT INTO user_token (id, user_id, label, expires_at)
		VALUES ($1, $2, NULLIF($3, ''), $4)
	`, id, userID, label, expiresAt); err != nil {
		return "", fmt.Errorf("token: insert: %w", err)
	}
	return id, nil
}

// Lookup resolves a token value to (user, error). Records a pending
// touch on success so the next flush bumps last_used_at.
func (m *Manager) Lookup(ctx context.Context, tok string) (*User, error) {
	if tok == "" {
		return nil, ErrNotFound
	}
	var (
		userID      int64
		displayName string
		revokedAt   *time.Time
		expiresAt   *time.Time
	)
	row := m.pool.QueryRow(ctx, `
		SELECT t.user_id, ua.display_name, t.revoked_at, t.expires_at
		FROM user_token t
		JOIN user_account ua ON ua.id = t.user_id
		WHERE t.id = $1
	`, tok)
	if err := row.Scan(&userID, &displayName, &revokedAt, &expiresAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("token: lookup: %w", err)
	}
	if revokedAt != nil {
		return nil, ErrExpired
	}
	now := time.Now()
	if expiresAt != nil && !now.Before(*expiresAt) {
		return nil, ErrExpired
	}
	m.mu.Lock()
	m.pendingUse[tok] = now
	m.mu.Unlock()
	return &User{ID: userID, DisplayName: displayName}, nil
}

// Revoke marks a token as revoked. Idempotent.
func (m *Manager) Revoke(ctx context.Context, tok string) error {
	if tok == "" {
		return nil
	}
	if _, err := m.pool.Exec(ctx, `
		UPDATE user_token SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
	`, tok); err != nil {
		return fmt.Errorf("token: revoke: %w", err)
	}
	m.mu.Lock()
	delete(m.pendingUse, tok)
	m.mu.Unlock()
	return nil
}

func (m *Manager) flush(ctx context.Context) error {
	m.mu.Lock()
	if len(m.pendingUse) == 0 {
		m.mu.Unlock()
		return nil
	}
	ids := make([]string, 0, len(m.pendingUse))
	for id := range m.pendingUse {
		ids = append(ids, id)
	}
	m.pendingUse = make(map[string]time.Time, len(ids))
	m.mu.Unlock()
	if _, err := m.pool.Exec(ctx, `
		UPDATE user_token SET last_used_at = now()
		WHERE id = ANY($1::text[])
	`, ids); err != nil {
		return fmt.Errorf("token: flush: %w", err)
	}
	return nil
}

// newTokenID returns 32 random bytes base64url-encoded. Same shape
// as session.id; nothing meaningful embedded.
func newTokenID() (string, error) {
	var buf [32]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf[:]), nil
}
