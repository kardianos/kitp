package mailin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"regexp"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// tokenShape is a route token: 40 lowercase hex characters (card_access_mint).
var tokenShape = regexp.MustCompile(`^[0-9a-f]{40}$`)

// route is one inbound route, as filing needs it.
type route struct {
	ID         int64
	ChannelID  int64
	ProjectID  int64
	Purpose    string
	Provider   string
	Policy     Policy
	SigningKey string
}

// lookupRoute finds a live route by its token. ok is false for an unknown
// token, a deleted mail account, or a token of another purpose.
func lookupRoute(ctx context.Context, pool *store.Pool, token, purpose string) (route, bool, error) {
	var r route
	if !tokenShape.MatchString(token) {
		return r, false, nil
	}
	b := named.New()
	b.Set("hash", auth.HashSecret(token))
	b.Set("purpose", purpose)
	sql, args, err := b.Compile(`
		SELECT a.id, a.card_id, COALESCE(c.parent_card_id, 0), a.purpose, a.provider, a.policy,
		       COALESCE(CASE WHEN a.signing_key IS NOT NULL
		                     THEN pgp_sym_decrypt(a.signing_key, current_setting('app.comm_secret_key')) END, '')
		FROM card_access a
		JOIN card c ON c.id = a.card_id AND c.deleted_at IS NULL
		WHERE a.token_hash = :hash AND a.purpose = :purpose`)
	if err != nil {
		return r, false, fmt.Errorf("route lookup: compile: %w", err)
	}
	var policy []byte
	err = pool.P.QueryRow(ctx, sql, args...).Scan(&r.ID, &r.ChannelID, &r.ProjectID, &r.Purpose, &r.Provider, &policy, &r.SigningKey)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return r, false, fmt.Errorf("route lookup: %w", err)
	}
	if err := json.Unmarshal(policy, &r.Policy); err != nil {
		return r, false, fmt.Errorf("route %d policy: %w", r.ID, err)
	}
	return r, true, nil
}

// refuse records that a route's filter turned a message away: a Comm log
// row (inbound_refused, with the check and why) and the route's last_error,
// which the Comm Channels page shows.
func (r route) refuse(ctx context.Context, pool *store.Pool, transport, check, reason string, source netip.Addr) error {
	detail := map[string]any{"check": check, "reason": reason, "transport": transport, "route_id": r.ID}
	if source.IsValid() {
		detail["source"] = source.String()
	}
	if err := comm.LogRouteEvent(ctx, pool.P, r.ProjectID, r.ChannelID, r.ID, "inbound_refused", detail); err != nil {
		return err
	}
	return r.noteError(ctx, pool, check+": "+reason)
}

// noteError sets the route's last_error.
func (r route) noteError(ctx context.Context, pool *store.Pool, msg string) error {
	b := named.New()
	b.Set("id", r.ID)
	b.Set("msg", truncate(msg, 300))
	sql, args, err := b.Compile(`UPDATE card_access SET last_error = :msg, last_error_at = now() WHERE id = :id`)
	if err != nil {
		return fmt.Errorf("route error: compile: %w", err)
	}
	if _, err := pool.P.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("route error: %w", err)
	}
	return nil
}

// touch records a message that came through: last_used_at, last_client.
func (r route) touch(ctx context.Context, pool *store.Pool, client netip.Addr) error {
	b := named.New()
	b.Set("id", r.ID)
	c := ""
	if client.IsValid() {
		c = client.String()
	}
	b.Set("client", c)
	sql, args, err := b.Compile(`UPDATE card_access SET last_used_at = now(), last_client = :client WHERE id = :id`)
	if err != nil {
		return fmt.Errorf("route touch: compile: %w", err)
	}
	if _, err := pool.P.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("route touch: %w", err)
	}
	return nil
}

// logEvent writes a Comm log row for the route.
func (r route) logEvent(ctx context.Context, pool *store.Pool, transport, kind string, detail map[string]any) error {
	detail["transport"] = transport
	detail["route_id"] = r.ID
	return comm.LogRouteEvent(ctx, pool.P, r.ProjectID, r.ChannelID, r.ID, kind, detail)
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n] + "…"
}
