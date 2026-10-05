// Package activitysink: pumper.go runs the per-delivery-unit push loop.
//
// A DELIVERY UNIT is one stream of notifications with its own position,
// rollup clock and destination:
//
//   - a broadcast sink (sink_kind 'msgraph_teams'): the activity_sink card
//     itself; it posts into one Teams channel.
//   - a personal subscription: an activity_subscription card under an
//     email sink; it mails one person (the `subscriber`) through the
//     sink's comm_channel.
//
// One Pumper per unit; a [Pool] reconciles them from a single scheduler
// job (`activitysink.pump`). On each tick the pumper:
//
//  1. Gates on status: the sink (and, for a subscription, the
//     subscription and the comm channel) must be 'enabled'. A paused
//     unit holds its position — nothing is skipped, it resumes later.
//  2. Loads its activity_sink_state row: last_activity_id (position) and
//     pending_since (the rollup clock). While a clock is running and
//     pending_since + rollup_minutes is still in the future it does
//     nothing else.
//  3. Scans the project's activity rows past the position (id order,
//     capped at batchLimit).
//  4. Filters: the event filter (activity_filter — sink ceiling AND
//     subscription), then the card filter (`predicate` — the screen
//     filter tree compiled to SQL, sink ceiling AND subscription, '@me'
//     = the subscriber) evaluated against each row's subject card (its
//     nearest task ancestor-or-self). A subscription additionally
//     requires the subscriber to still see the project (DI-6).
//  5. Rollup: no match → advance past the scanned rows. First match
//     younger than rollup_minutes → park the position just before it,
//     start the clock (pending_since = its created_at). Otherwise →
//     render every match as one digest grouped by task (digest.go) and
//     deliver it; on success advance past the scanned rows and clear the
//     clock.
//  6. On a delivery error: keep the position, record last_error, and on
//     a permanent failure (Teams 4xx auth/missing channel, SMTP 5xx
//     bounce, no recipient address) flip the unit to disabled-fault.
//
// State writes never touch the activity stream (plain SQL on
// activity_sink_state), so the pointer advance can't feed back into the
// rows being read.
//
// KITP_ACTIVITY_SINK_DRY_RUN=1 short-circuits every output (Teams post
// and email); KITP_COMM_SMTP_DRY_RUN=1 also short-circuits email. The
// would-be message is logged and the delivery treated as a success.
package activitysink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SinkKindEmail is the personal-subscription sink kind: subscriptions
// under it are mailed through the sink's comm_channel.
const SinkKindEmail = "email"

// defaultBatchLimit caps the activity rows scanned per tick. A rollup
// digest can hold this many events; the remainder ships on the next
// tick (immediately, since its clock is already past due).
const defaultBatchLimit = 200

// Pumper owns one delivery unit's poll loop.
type Pumper struct {
	pool       *store.Pool
	unitID     int64 // the sink card (broadcast) or subscription card (personal)
	sinkID     int64
	projectID  int64 // resolved at construction
	tick       time.Duration
	batchLimit int
	dryRun     bool
	publicURL  string
	logger     *slog.Logger
	poster     MSGraphPoster
	mailer     comm.SMTPTransport
	now        func() time.Time
}

// NewMSGraphPumperForTest builds the pumper for a broadcast sink so tests
// can drive RunOnce / TickOnce synchronously. Production builds them
// through a [Pool], which reconciles one pumper per unit and ticks them
// via the scheduler.
func NewMSGraphPumperForTest(pool *store.Pool, sinkID, projectID int64, tick time.Duration) *Pumper {
	return newPumper(pool, unitKey{UnitID: sinkID, SinkID: sinkID, ProjectID: projectID}, tick)
}

// NewSubscriptionPumperForTest builds the pumper for one personal
// subscription under an email sink.
func NewSubscriptionPumperForTest(pool *store.Pool, subscriptionID, sinkID, projectID int64, tick time.Duration) *Pumper {
	return newPumper(pool, unitKey{UnitID: subscriptionID, SinkID: sinkID, ProjectID: projectID}, tick)
}

func newPumper(pool *store.Pool, k unitKey, tick time.Duration) *Pumper {
	if tick < time.Second {
		tick = time.Second
	}
	return &Pumper{
		pool:       pool,
		unitID:     k.UnitID,
		sinkID:     k.SinkID,
		projectID:  k.ProjectID,
		tick:       tick,
		batchLimit: defaultBatchLimit,
		dryRun:     os.Getenv("KITP_ACTIVITY_SINK_DRY_RUN") == "1",
		logger:     slog.Default(),
		poster:     realMSGraphPost,
		mailer:     comm.SendSMTP,
		now:        time.Now,
	}
}

// SetLogger overrides slog.Default().
func (p *Pumper) SetLogger(l *slog.Logger) {
	if l != nil {
		p.logger = l
	}
}

// SetPoster swaps the MS Graph poster — tests inject a recording stub.
func (p *Pumper) SetPoster(fn MSGraphPoster) {
	if fn != nil {
		p.poster = fn
	}
}

// SetMailer swaps the SMTP transport email units send through — tests
// inject a recording stub.
func (p *Pumper) SetMailer(fn comm.SMTPTransport) {
	if fn != nil {
		p.mailer = fn
	}
}

// SetPublicURL sets the install's external base URL (KITP_PUBLIC_URL),
// used for the per-task links in a digest and the "manage" footer link.
// Empty leaves links off.
func (p *Pumper) SetPublicURL(u string) {
	p.publicURL = strings.TrimRight(strings.TrimSpace(u), "/")
}

// SetNow swaps the clock the rollup window is measured against.
func (p *Pumper) SetNow(fn func() time.Time) {
	if fn != nil {
		p.now = fn
	}
}

// SetBatchLimit overrides the per-tick cap on activity rows scanned.
func (p *Pumper) SetBatchLimit(n int) {
	if n > 0 {
		p.batchLimit = n
	}
}

// personal reports whether this unit is a subscription (vs a broadcast sink).
func (p *Pumper) personal() bool { return p.unitID != p.sinkID }

// TickOnce runs one cycle under a 60s budget and the System actor. Logs
// and returns the RunOnce error; the [Pool] sweep discards it so one bad
// unit doesn't fail the pump job. No connection is held between ticks.
func (p *Pumper) TickOnce(ctx context.Context) error {
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	runCtx = auth.WithSystemUser(runCtx)
	if err := p.RunOnce(runCtx); err != nil {
		p.logger.LogAttrs(runCtx, slog.LevelError, "activity_sink pumper RunOnce",
			slog.Int64("unit_id", p.unitID),
			slog.Int64("sink_id", p.sinkID),
			slog.String("err", err.Error()))
		return err
	}
	return nil
}

// errPermanent marks a delivery failure that should fault the unit.
type errPermanent struct{ reason string }

func (e *errPermanent) Error() string { return e.reason }

// RunOnce executes one scan + deliver cycle synchronously (see the
// package doc for the pipeline). Exported so tests can drive the loop.
func (p *Pumper) RunOnce(ctx context.Context) error {
	cfg, err := p.loadUnitConfig(ctx)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil // unit deleted between the sweep and this tick
		}
		return fmt.Errorf("activity_sink pumper: load config: %w", err)
	}
	if !cfg.active() {
		return nil
	}

	eventFilters, err := cfg.eventFilters()
	if err != nil {
		// A bad filter is a permanent fault: stop delivering so an
		// unfiltered flood can't go out; the owner fixes it and re-enables.
		reason := fmt.Sprintf("activity_filter: invalid JSON: %v", err)
		p.markFault(ctx, reason)
		return fmt.Errorf("activity_filter parse: %w", err)
	}

	st, err := p.loadState(ctx)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: load state: %w", err)
	}
	now := p.now()
	rollup := time.Duration(cfg.rollupMinutes) * time.Minute
	if st.pendingSince != nil && now.Before(st.pendingSince.Add(rollup)) {
		return nil // rollup window still open
	}

	rows, err := p.loadActivityBatch(ctx, st.pointer)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: load activity: %w", err)
	}
	if len(rows) == 0 {
		if st.pendingSince != nil {
			return p.recordState(ctx, st.pointer, nil, 0, "")
		}
		return nil
	}
	lastScanned := rows[len(rows)-1].ID

	if p.personal() {
		visible, err := p.subscriberSeesProject(ctx, cfg.subscriberUserID)
		if err != nil {
			return fmt.Errorf("activity_sink pumper: visibility: %w", err)
		}
		if !visible {
			// Lost access: drop (don't accumulate) everything scanned.
			return p.recordState(ctx, lastScanned, nil, 0, "subscriber can no longer see this project")
		}
	}

	matched := rows[:0:0]
	for _, r := range rows {
		if eventFilters.eval(r.ActivityRow) {
			matched = append(matched, r)
		}
	}
	if len(matched) > 0 {
		matched, err = p.applyCardFilter(ctx, cfg, matched)
		if err != nil {
			var bad *errBadCardFilter
			if errors.As(err, &bad) {
				p.markFault(ctx, bad.Error())
			}
			return fmt.Errorf("activity_sink pumper: card filter: %w", err)
		}
	}
	if len(matched) == 0 {
		return p.recordState(ctx, lastScanned, nil, 0, "")
	}

	first := matched[0]
	if rollup > 0 && now.Before(first.CreatedAt.Add(rollup)) {
		// Start (or keep) the clock; park just before the first match so
		// the delivery tick rescans from it.
		since := first.CreatedAt
		return p.recordState(ctx, first.ID-1, &since, 0, "")
	}

	digest, err := p.buildDigest(ctx, cfg, matched)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: build digest: %w", err)
	}
	if err := p.deliver(ctx, cfg, digest); err != nil {
		since := first.CreatedAt
		var perm *errPermanent
		var graphPerm *MSGraphPermanentError
		switch {
		case errors.As(err, &perm):
			p.markFault(ctx, truncate(perm.reason, 200))
		case errors.As(err, &graphPerm):
			p.markFault(ctx, truncate(err.Error(), 200))
		}
		if writeErr := p.recordState(ctx, st.pointer, &since, 0, err.Error()); writeErr != nil {
			p.logger.LogAttrs(ctx, slog.LevelError, "activity_sink state write failed",
				slog.Int64("unit_id", p.unitID),
				slog.String("err", writeErr.Error()))
		}
		return err
	}
	return p.recordState(ctx, lastScanned, nil, int64(len(matched)), "")
}

// markFault flips the unit into disabled-fault. Best-effort: a failed
// write is logged, never returned (the caller is already reporting the
// fault's cause).
func (p *Pumper) markFault(ctx context.Context, reason string) {
	if err := comm.MarkChannelFault(ctx, p.pool, p.unitID, reason); err != nil {
		p.logger.LogAttrs(ctx, slog.LevelError, "activity_sink mark fault failed",
			slog.Int64("unit_id", p.unitID),
			slog.String("err", err.Error()))
	}
}

// ---- unit config ----

// unitConfig is everything one tick needs about the unit, its sink and
// (for a subscription) its subscriber. Loaded fresh every tick so edits
// apply without a restart.
type unitConfig struct {
	sinkKind      string
	sinkName      string
	sinkStatus    string
	unitName      string
	unitStatus    string // == sinkStatus for a broadcast sink
	projectName   string
	rollupMinutes int
	// Event + card filters: the sink's always apply (for an email sink
	// they're the admin ceiling); a subscription's are ANDed on top.
	sinkEventRaw string
	sinkCardRaw  string
	unitEventRaw string
	unitCardRaw  string
	// Email sinks.
	channelID     int64
	channelStatus string
	// Subscriptions.
	subscriberPersonID int64
	subscriberUserID   int64
	subscriberEmail    string
	// Teams sinks.
	msgraph MSGraphConfig
}

func (c unitConfig) active() bool {
	if c.sinkStatus != comm.ChannelStatusEnabled || c.unitStatus != comm.ChannelStatusEnabled {
		return false
	}
	if c.sinkKind == SinkKindEmail && c.channelStatus != comm.ChannelStatusEnabled {
		return false
	}
	return true
}

// eventFilterSet ANDs the sink's and the unit's event predicates.
type eventFilterSet []Predicate

func (s eventFilterSet) eval(r ActivityRow) bool {
	for _, p := range s {
		if !p.Eval(r) {
			return false
		}
	}
	return true
}

func (c unitConfig) eventFilters() (eventFilterSet, error) {
	var out eventFilterSet
	for _, raw := range []string{c.sinkEventRaw, c.unitEventRaw} {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		p, err := ParsePredicate(raw)
		if err != nil {
			return nil, err
		}
		out = append(out, p.WithMe(c.subscriberUserID))
	}
	return out, nil
}

// attrSQL renders a text-attribute lookup for one card. Only constant
// attribute names are spliced in — no caller data.
func attrSQL(cardExpr, name, fallback string) string {
	return fmt.Sprintf(`COALESCE((SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = %s AND ad.name = '%s'), '%s')`,
		cardExpr, name, fallback)
}

// refSQL renders a card_ref / number attribute lookup as bigint (0 when unset).
func refSQL(cardExpr, name string) string {
	return fmt.Sprintf(`COALESCE((SELECT (av.value)::text::numeric::bigint FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = %s AND ad.name = '%s' AND jsonb_typeof(av.value) = 'number'), 0)`,
		cardExpr, name)
}

func (p *Pumper) loadUnitConfig(ctx context.Context) (unitConfig, error) {
	b := named.New()
	b.Set("unit_id", p.unitID)
	b.Set("sink_id", p.sinkID)
	b.Set("project_id", p.projectID)
	sql, args, err := b.Compile(`
		SELECT
			` + attrSQL("s.id", "sink_kind", "") + `,
			` + attrSQL("s.id", "title", "") + `,
			` + attrSQL("s.id", "channel_status", "enabled") + `,
			` + attrSQL("u.id", "title", "") + `,
			` + attrSQL("u.id", "channel_status", "enabled") + `,
			` + attrSQL(":project_id", "title", "") + `,
			` + refSQL("u.id", "rollup_minutes") + `,
			` + attrSQL("s.id", "activity_filter", "") + `,
			` + attrSQL("s.id", "predicate", "") + `,
			CASE WHEN u.id = s.id THEN '' ELSE ` + attrSQL("u.id", "activity_filter", "") + ` END,
			CASE WHEN u.id = s.id THEN '' ELSE ` + attrSQL("u.id", "predicate", "") + ` END,
			` + refSQL("s.id", "channel_ref") + `,
			CASE WHEN u.id = s.id THEN 0 ELSE ` + refSQL("u.id", "subscriber") + ` END,
			` + attrSQL("s.id", "msgraph_tenant_id", "") + `,
			` + attrSQL("s.id", "msgraph_client_id", "") + `,
			` + attrSQL("s.id", "msgraph_team_id", "") + `,
			` + attrSQL("s.id", "msgraph_channel_id", "") + `,
			COALESCE((SELECT pgp_sym_decrypt(client_secret, current_setting('app.comm_secret_key'))
			            FROM activity_sink_secret WHERE sink_card_id = s.id AND client_secret IS NOT NULL), '')
		FROM card u
		JOIN card s ON s.id = :sink_id AND s.deleted_at IS NULL
		WHERE u.id = :unit_id AND u.deleted_at IS NULL
	`)
	if err != nil {
		return unitConfig{}, fmt.Errorf("loadUnitConfig: compile: %w", err)
	}
	var c unitConfig
	if err := p.pool.P.QueryRow(ctx, sql, args...).Scan(
		&c.sinkKind, &c.sinkName, &c.sinkStatus,
		&c.unitName, &c.unitStatus, &c.projectName, &c.rollupMinutes,
		&c.sinkEventRaw, &c.sinkCardRaw, &c.unitEventRaw, &c.unitCardRaw,
		&c.channelID, &c.subscriberPersonID,
		&c.msgraph.TenantID, &c.msgraph.ClientID, &c.msgraph.TeamID, &c.msgraph.ChannelID,
		&c.msgraph.ClientSecret,
	); err != nil {
		return unitConfig{}, err
	}
	c.sinkStatus = normaliseStatus(c.sinkStatus)
	c.unitStatus = normaliseStatus(c.unitStatus)
	if c.sinkKind == "" {
		c.sinkKind = SinkKindMSGraphTeams // pre-kind sinks were all Teams
	}
	// A subscription under a sink that stopped being an email sink has no
	// destination; treat it as paused.
	if p.personal() && c.sinkKind != SinkKindEmail {
		c.unitStatus = comm.ChannelStatusDisabledAdmin
	}
	if c.sinkKind == SinkKindEmail {
		c.channelStatus = comm.ChannelStatusDisabledAdmin // no channel → hold
		if c.channelID != 0 {
			st, _, err := comm.ReadChannelStatus(ctx, p.pool.P, c.channelID)
			if err != nil {
				return unitConfig{}, fmt.Errorf("loadUnitConfig: channel status: %w", err)
			}
			c.channelStatus = st
		}
	}
	if p.personal() && c.subscriberPersonID != 0 {
		if err := p.loadSubscriber(ctx, &c); err != nil {
			return unitConfig{}, err
		}
	}
	return c, nil
}

func normaliseStatus(s string) string {
	if comm.ValidChannelStatus(s) {
		return s
	}
	return comm.ChannelStatusEnabled
}

// loadSubscriber resolves the subscriber person → their login (for the
// visibility check) and delivery address (person email, else the
// login's email).
func (p *Pumper) loadSubscriber(ctx context.Context, c *unitConfig) error {
	b := named.New()
	b.Set("person_id", c.subscriberPersonID)
	sql, args, err := b.Compile(`
		SELECT
			COALESCE(ua.id, 0),
			COALESCE(NULLIF(btrim(` + attrSQL(":person_id", "email", "") + `), ''),
			         NULLIF(btrim(ua.email), ''), '')
		FROM (SELECT 1) one
		LEFT JOIN LATERAL (
			SELECT u.id, u.email
			FROM user_account_person uap
			JOIN user_account u ON u.id = uap.user_account_id
			WHERE uap.person_card_id = :person_id
			ORDER BY u.id
			LIMIT 1
		) ua ON true
	`)
	if err != nil {
		return fmt.Errorf("loadSubscriber: compile: %w", err)
	}
	if err := p.pool.P.QueryRow(ctx, sql, args...).Scan(&c.subscriberUserID, &c.subscriberEmail); err != nil {
		return fmt.Errorf("loadSubscriber: %w", err)
	}
	return nil
}

// subscriberSeesProject applies the DI-6 visibility predicate for the
// subscriber's login against the unit's project. Every card the pump
// scans sits under that project, so one check covers the whole batch.
func (p *Pumper) subscriberSeesProject(ctx context.Context, userID int64) (bool, error) {
	if userID == 0 {
		return false, nil
	}
	b := named.New()
	b.Set("project_id", p.projectID)
	b.Set("user_id", userID)
	sql, args, err := b.Compile(`SELECT ` + schema.VisibilityClause(":project_id", ":user_id"))
	if err != nil {
		return false, fmt.Errorf("subscriberSeesProject: compile: %w", err)
	}
	var ok bool
	if err := p.pool.P.QueryRow(ctx, sql, args...).Scan(&ok); err != nil {
		return false, err
	}
	return ok, nil
}

// ---- state ----

type unitState struct {
	pointer      int64
	pendingSince *time.Time
}

func (p *Pumper) loadState(ctx context.Context) (unitState, error) {
	b := named.New()
	b.Set("unit_id", p.unitID)
	sql, args, err := b.Compile(`
		SELECT COALESCE(last_activity_id, 0), pending_since
		FROM activity_sink_state WHERE sink_card_id = :unit_id
	`)
	if err != nil {
		return unitState{}, fmt.Errorf("loadState: compile: %w", err)
	}
	var st unitState
	if err := p.pool.P.QueryRow(ctx, sql, args...).Scan(&st.pointer, &st.pendingSince); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return unitState{}, nil
		}
		return unitState{}, err
	}
	return st, nil
}

// recordState upserts the unit's position / rollup clock / counters /
// last_error. The position only moves forward (GREATEST). last_pushed_at
// stamps successful deliveries only.
func (p *Pumper) recordState(ctx context.Context, newPointer int64, pendingSince *time.Time, pushed int64, lastError string) error {
	var lastErrArg any
	if lastError != "" {
		lastErrArg = lastError
	}
	var pendingArg any
	if pendingSince != nil {
		pendingArg = *pendingSince
	}
	b := named.New()
	b.Set("unit_id", p.unitID)
	b.Set("pointer", newPointer)
	b.Set("pushed", pushed)
	b.Set("last_error", lastErrArg)
	b.Set("pending_since", pendingArg)
	sql, args, err := b.Compile(`
		INSERT INTO activity_sink_state
			(sink_card_id, last_activity_id, last_pushed_at, last_pushed_count, last_error, pending_since, updated_at)
		VALUES (:unit_id, :pointer,
		        CASE WHEN CAST(:pushed AS bigint) > 0 THEN now() END,
		        CAST(:pushed AS bigint), CAST(:last_error AS text), CAST(:pending_since AS timestamptz), now())
		ON CONFLICT (sink_card_id) DO UPDATE SET
			last_activity_id  = GREATEST(activity_sink_state.last_activity_id, EXCLUDED.last_activity_id),
			last_pushed_at    = CASE WHEN CAST(:pushed AS bigint) > 0 THEN now() ELSE activity_sink_state.last_pushed_at END,
			last_pushed_count = activity_sink_state.last_pushed_count + CAST(:pushed AS bigint),
			last_error        = CAST(:last_error AS text),
			pending_since     = CAST(:pending_since AS timestamptz),
			updated_at        = now()
	`)
	if err != nil {
		return fmt.Errorf("recordState: compile: %w", err)
	}
	if _, err := p.pool.P.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("recordState: %w", err)
	}
	p.pool.NoteWrite()
	return nil
}

// ---- scan ----

// scannedRow is one activity row as the pump scanned it: the predicate's
// ActivityRow plus what the card filter and the digest need.
type scannedRow struct {
	ActivityRow
	ValueType string
	CreatedAt time.Time
	ValueOld  []byte
	ValueNew  []byte
	// SubjectID is the card the row is ABOUT for filtering + grouping:
	// its nearest task ancestor-or-self (a comm's activity groups under
	// its task), else the card itself.
	SubjectID int64
}

// loadActivityBatch materialises the project's card tree and scans
// activity rows past the position, id-ascending, up to batchLimit.
//
// The recursive CTE caps depth at 16 (CLAUDE.md "Recursive CTE depth
// cap", matching the dispatcher's scopeWalkDepth) so a corrupted
// parent_card_id cycle can't pin the worker.
func (p *Pumper) loadActivityBatch(ctx context.Context, pointer int64) ([]scannedRow, error) {
	b := named.New()
	b.Set("project_id", p.projectID)
	b.Set("pointer", pointer)
	b.Set("limit", p.batchLimit)
	sql, args, err := b.Compile(`
		WITH RECURSIVE project_cards(id, depth) AS (
			SELECT id, 0 FROM card WHERE id = :project_id
			UNION ALL
			SELECT c.id, pc.depth + 1
			FROM card c JOIN project_cards pc ON c.parent_card_id = pc.id
			WHERE pc.depth < 16
		),
		batch AS (
			SELECT a.id, a.card_id, a.kind, a.attribute_def_id, a.actor_id,
			       a.created_at, a.value_old, a.value_new
			FROM activity a
			WHERE a.id > :pointer
			  AND a.card_id IN (SELECT id FROM project_cards)
			ORDER BY a.id ASC
			LIMIT :limit
		)
		SELECT b.id, b.card_id, b.kind,
		       COALESCE(ad.name, ''), COALESCE(ad.value_type, ''),
		       b.actor_id, b.created_at, b.value_old, b.value_new,
		       COALESCE((
		           SELECT ca.id FROM card_ancestors(b.card_id) ca
		           JOIN card_type ct ON ct.id = ca.card_type_id
		           WHERE ct.name = 'task'
		           ORDER BY ca.depth
		           LIMIT 1
		       ), b.card_id) AS subject_id
		FROM batch b
		LEFT JOIN attribute_def ad ON ad.id = b.attribute_def_id
		ORDER BY b.id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("loadActivityBatch: compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []scannedRow
	for rows.Next() {
		var r scannedRow
		if err := rows.Scan(&r.ID, &r.CardID, &r.Kind, &r.AttributeName, &r.ValueType,
			&r.ActorID, &r.CreatedAt, &r.ValueOld, &r.ValueNew, &r.SubjectID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- card filter ----

// errBadCardFilter marks a stored card filter that doesn't parse or
// compile — a permanent fault, like an invalid activity_filter.
type errBadCardFilter struct{ err error }

func (e *errBadCardFilter) Error() string { return "card_filter: " + e.err.Error() }
func (e *errBadCardFilter) Unwrap() error { return e.err }

// applyCardFilter keeps the rows whose subject card satisfies the sink's
// and the unit's card filters (both, when set). The trees compile through
// card.CompileTree — the same compiler the screens use — after '@me'
// person values are rewritten to the subscriber's person card.
func (p *Pumper) applyCardFilter(ctx context.Context, cfg unitConfig, rows []scannedRow) ([]scannedRow, error) {
	var nodes []card.CardWhereTreeNode
	for _, raw := range []string{cfg.sinkCardRaw, cfg.unitCardRaw} {
		n, ok, err := parseCardFilter(raw, cfg.subscriberPersonID)
		if err != nil {
			return nil, &errBadCardFilter{err: err}
		}
		if ok {
			nodes = append(nodes, n)
		}
	}
	if len(nodes) == 0 {
		return rows, nil
	}

	subjects := make([]int64, 0, len(rows))
	seen := map[int64]bool{}
	for _, r := range rows {
		if !seen[r.SubjectID] {
			seen[r.SubjectID] = true
			subjects = append(subjects, r.SubjectID)
		}
	}

	tx, err := p.pool.P.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, fmt.Errorf("begin: %w", err)
	}
	// Read-only tx: rollback is the normal close; its error is moot.
	defer func() { _ = tx.Rollback(ctx) }()
	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("schema load: %w", err)
	}
	b := named.New()
	b.Set("ids", subjects)
	clause, err := card.CompileTree(ctx, tx, card.CardWhereGroup{Connective: "and", Children: nodes}, b.Bind, snap)
	if err != nil {
		return nil, &errBadCardFilter{err: err}
	}
	sql, args, err := b.Compile(`
		SELECT c.id FROM card c
		WHERE c.id = ANY(CAST(:ids AS bigint[])) AND (` + clause + `)
	`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	pass := map[int64]bool{}
	qr, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("query: %w", err)
	}
	for qr.Next() {
		var id int64
		if err := qr.Scan(&id); err != nil {
			qr.Close()
			return nil, err
		}
		pass[id] = true
	}
	qr.Close()
	if err := qr.Err(); err != nil {
		return nil, err
	}
	out := rows[:0:0]
	for _, r := range rows {
		if pass[r.SubjectID] {
			out = append(out, r)
		}
	}
	return out, nil
}

// meToken is the dynamic "current viewer" person value saved filters
// carry (see db/schema/functions/resolve_me_tokens.sql).
const meToken = "@me"

// parseCardFilter decodes one stored card filter. Empty / whitespace /
// `{}` means "no filter" (ok=false). A bare leaf is accepted as a
// one-child AND group. Every "@me" string becomes the subscriber's person
// id; without a subscriber (broadcast sink) it stays a string and so
// matches no card — the same rule the screens apply to a viewer with no
// person.
func parseCardFilter(raw string, personID int64) (card.CardWhereTreeNode, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return card.CardWhereTreeNode{}, false, nil
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	if personID != 0 {
		tree = replaceMe(tree, json.Number(strconv.FormatInt(personID, 10)))
	}
	buf, err := json.Marshal(tree)
	if err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	var n card.CardWhereTreeNode
	if err := json.Unmarshal(buf, &n); err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	if n.Connective == "" && n.Attr == "" {
		return card.CardWhereTreeNode{}, false, nil
	}
	return n, true, nil
}

func replaceMe(v any, me json.Number) any {
	switch t := v.(type) {
	case string:
		if t == meToken {
			return me
		}
		return t
	case []any:
		for i := range t {
			t[i] = replaceMe(t[i], me)
		}
		return t
	case map[string]any:
		for k := range t {
			t[k] = replaceMe(t[k], me)
		}
		return t
	}
	return v
}

// ---- pool ----

// unitKey identifies one delivery unit: UnitID == SinkID for a broadcast
// sink, else the subscription card id. ProjectID is resolved once at
// enumeration so the pumper needn't look up its scope each tick.
// Comparable so it can key the worker pool.
type unitKey struct{ UnitID, SinkID, ProjectID int64 }

// listUnits enumerates every live delivery unit: each non-email sink, and
// each subscription under a live email sink.
func listUnits(ctx context.Context, pool *store.Pool) ([]unitKey, error) {
	b := named.New()
	b.Set("email", SinkKindEmail)
	sql, args, err := b.Compile(`
		WITH sinks AS (
			SELECT s.id, s.parent_card_id AS project_id,
			       ` + attrSQL("s.id", "sink_kind", "") + ` AS kind
			FROM card s
			JOIN card_type ct ON ct.id = s.card_type_id AND ct.name = 'activity_sink'
			WHERE s.deleted_at IS NULL AND s.parent_card_id IS NOT NULL
		)
		SELECT s.id, s.id, s.project_id FROM sinks s WHERE s.kind <> :email
		UNION ALL
		SELECT sub.id, s.id, s.project_id
		FROM sinks s
		JOIN card sub ON sub.parent_card_id = s.id AND sub.deleted_at IS NULL
		JOIN card_type sct ON sct.id = sub.card_type_id AND sct.name = 'activity_subscription'
		WHERE s.kind = :email
		ORDER BY 1
	`)
	if err != nil {
		return nil, fmt.Errorf("listUnits: compile: %w", err)
	}
	rows, err := pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []unitKey
	for rows.Next() {
		var k unitKey
		if err := rows.Scan(&k.UnitID, &k.SinkID, &k.ProjectID); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Pool drives every delivery unit's pumper from a single scheduler job.
// Each RunOnce reconciles one [Pumper] per live unit (new sinks and
// subscriptions are picked up, deleted ones dropped — no restart) and
// ticks each one. Construct with [NewPool] and call RunOnce from the
// `activitysink.pump` job (see cmd/kitpd/main.go).
type Pool struct {
	pool *store.Pool
	wp   *job.WorkerPool[unitKey, *Pumper]
}

// NewPool builds the pool. tick is the per-pumper cadence hint (the real
// cadence is the owning job's Interval); logger and publicURL
// (KITP_PUBLIC_URL, for digest links) are threaded to each pumper.
func NewPool(pool *store.Pool, tick time.Duration, logger *slog.Logger, publicURL string) *Pool {
	m := &Pool{pool: pool}
	m.wp = job.NewWorkerPool[unitKey, *Pumper](
		func(k unitKey) *Pumper {
			p := newPumper(pool, k, tick)
			p.SetLogger(logger)
			p.SetPublicURL(publicURL)
			return p
		},
		// Discard the per-unit error: TickOnce already logged it, and one
		// bad unit must not flip the whole pump job red.
		func(ctx context.Context, p *Pumper) error { _ = p.TickOnce(ctx); return nil },
	)
	return m
}

// RunOnce is the `activitysink.pump` job body: list every unit and sweep
// its pumper. Returns only a unit-enumeration error.
func (m *Pool) RunOnce(ctx context.Context) error {
	units, err := listUnits(ctx, m.pool)
	if err != nil {
		return fmt.Errorf("activity_sink pump: list units: %w", err)
	}
	return m.wp.Sweep(ctx, units)
}
