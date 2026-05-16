// channel_status.go: tri-state enable/disable for comm_channel cards.
//
// Every comm_channel carries a `channel_status` text attribute with one
// of three values:
//
//   - "enabled"         — normal operation (the default; missing/empty
//                          attribute reads as enabled so legacy channels
//                          keep working without a migration).
//   - "disabled-admin"  — an admin has explicitly paused the channel.
//   - "disabled-fault"  — the channel's own runtime tripped a fault
//                          condition (e.g. IMAP auth failure or
//                          sustained backoff). The admin re-enables
//                          after acknowledging the underlying issue.
//
// The status is generic across every channel type — email today,
// internal/agent comms tomorrow. Each runtime's poll/send loop calls
// ReadChannelStatus before doing any work and skips the cycle when the
// channel is disabled. When a per-type runtime detects a fault it calls
// MarkChannelFault, which writes both the status and a free-form
// channel_fault_reason for the admin UI to surface.
package comm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// Channel status values. Keep these strings stable — they appear in
// seed.hcsv defaults, the admin client, and any saved filters.
const (
	ChannelStatusEnabled        = "enabled"
	ChannelStatusDisabledAdmin  = "disabled-admin"
	ChannelStatusDisabledFault  = "disabled-fault"
)

// ValidChannelStatus reports whether s is one of the three accepted
// status values. Used by validateChannelSet to reject typos before
// they land in attribute_value.
func ValidChannelStatus(s string) bool {
	switch s {
	case ChannelStatusEnabled, ChannelStatusDisabledAdmin, ChannelStatusDisabledFault:
		return true
	}
	return false
}

// ReadChannelStatus returns the channel's current channel_status. An
// absent or unrecognised value is reported as "enabled" so a channel
// created before this feature shipped keeps working. The fault reason
// is returned alongside the status so callers can log it without a
// second round-trip; it is empty when the channel is not faulted.
//
// Reads use a plain Query — no transaction is opened — so the
// pre-tick gate in a poller can call this from the loop without
// holding a write tx. Pass any pgx-compatible querier (a *pgxpool.Pool
// or a *pgx.Conn) via [PoolQuerier].
func ReadChannelStatus(ctx context.Context, q PoolQuerier, channelID int64) (string, string, error) {
	var statusRaw, reasonRaw []byte
	err := q.QueryRow(ctx, `
		SELECT
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_status'),
			(SELECT value FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id
			   WHERE av.card_id = $1 AND ad.name = 'channel_fault_reason')
	`, channelID).Scan(&statusRaw, &reasonRaw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ChannelStatusEnabled, "", nil
		}
		return "", "", fmt.Errorf("comm: read channel_status for %d: %w", channelID, err)
	}
	status := unwrapJSONString(statusRaw)
	if !ValidChannelStatus(status) {
		// Tolerate legacy / clobbered values; the runtime should not
		// silently stop polling because someone hand-edited the DB.
		status = ChannelStatusEnabled
	}
	reason := unwrapJSONString(reasonRaw)
	return status, reason, nil
}

// PoolQuerier is the slice of pgxpool.Pool / pgx.Tx we need to read the
// channel status. Declared so test code can wrap a stub without pulling
// pgxpool in.
type PoolQuerier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// MarkChannelFault flips the channel into disabled-fault and writes the
// supplied reason into channel_fault_reason. Idempotent: when the
// channel is already in disabled-fault we still overwrite the reason
// so the admin sees the most recent failure. Best-effort: errors are
// returned but the caller is expected to log + continue (a transient
// DB hiccup must not crash the poll loop).
//
// Writes go through writeAttributeValue so the activity stream sees
// the change in the same shape as a manual admin edit — operators can
// audit when a channel went into fault by reading the activity feed.
func MarkChannelFault(ctx context.Context, pool *store.Pool, channelID int64, reason string) error {
	return updateChannelStatus(ctx, pool, channelID, ChannelStatusDisabledFault, reason)
}

// MarkChannelEnabled clears the fault and brings the channel back into
// the polling rotation. The fault reason is cleared as well — the new
// state means "operator has acknowledged the prior failure."
func MarkChannelEnabled(ctx context.Context, pool *store.Pool, channelID int64) error {
	return updateChannelStatus(ctx, pool, channelID, ChannelStatusEnabled, "")
}

// updateChannelStatus is the common write path. Opens a short tx, looks
// up the two attribute_def ids, writes both rows, commits. Each value
// is upserted independently so an existing channel with no fault
// reason gets the row created on demand.
func updateChannelStatus(ctx context.Context, pool *store.Pool, channelID int64, status, reason string) error {
	if pool == nil || pool.P == nil {
		return fmt.Errorf("comm: nil pool for channel %d status update", channelID)
	}
	// Detach from the caller's deadline. The IMAP poller's tick context
	// is sized for the whole poll cycle and a long-blocking dial can
	// leave us with milliseconds when we get here — not enough to begin
	// a transaction and write two attributes. We still honour
	// cancellation (the parent's auth values propagate via context
	// values, but the deadline is fresh).
	ctx = auth.WithSystemUser(context.WithoutCancel(ctx))
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	actorID := auth.ActorOrSystem(ctx)

	tx, err := pool.P.Begin(ctx)
	if err != nil {
		return fmt.Errorf("comm: begin tx for channel %d: %w", channelID, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	statusAD, err := lookupAttrDefID(ctx, tx, "channel_status")
	if err != nil {
		return err
	}
	reasonAD, err := lookupAttrDefID(ctx, tx, "channel_fault_reason")
	if err != nil {
		return err
	}

	statusJSON, err := json.Marshal(status)
	if err != nil {
		return fmt.Errorf("comm: marshal status: %w", err)
	}
	if err := writeAttributeValue(ctx, tx, channelID, statusAD, statusJSON, actorID); err != nil {
		return err
	}
	reasonJSON, err := json.Marshal(reason)
	if err != nil {
		return fmt.Errorf("comm: marshal reason: %w", err)
	}
	if err := writeAttributeValue(ctx, tx, channelID, reasonAD, reasonJSON, actorID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("comm: commit channel %d status: %w", channelID, err)
	}
	pool.NoteWrite()
	return nil
}

func lookupAttrDefID(ctx context.Context, tx pgx.Tx, name string) (int64, error) {
	var id int64
	if err := tx.QueryRow(ctx,
		`SELECT id FROM attribute_def WHERE name = $1`, name,
	).Scan(&id); err != nil {
		return 0, fmt.Errorf("comm: lookup attribute_def %q: %w", name, err)
	}
	return id, nil
}

// unwrapJSONString decodes a jsonb value that is expected to be a
// string. Returns "" for NULL, non-string, or invalid JSON — none of
// which should crash the caller (the channel may simply not have the
// attribute set yet).
func unwrapJSONString(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}
