// Package activitysink: pumper.go runs the per-sink push loop.
//
// One MSGraphPumper goroutine per activity_sink card. On each tick
// (default 30s; tunable via KITP_ACTIVITY_SINK_TICK_SEC) the pumper:
//
//  1. Reads the sink's channel_status — disabled-admin / disabled-fault
//     skips the cycle (the pointer does NOT advance; admin re-enables
//     and the next tick resumes from where we left off).
//  2. Loads the sink's last_activity_id pointer from activity_sink_state
//     (defaults to 0 when no row exists yet — first run pushes the
//     entire backlog within the limit).
//  3. Materialises the project's card tree once, then selects activity
//     rows with a.id > pointer AND a.card_id in the tree, ordered by id
//     ascending, capped at batchLimit.
//  4. For each row: evaluate the stored Predicate; if it matches, POST
//     to MS Graph (channel message). Advances the pointer past every
//     scanned row (matched or not) so we never re-scan a row.
//  5. On any Graph error: MarkChannelFault with a short reason, write
//     last_error into the state row, and exit the tick early (the
//     pointer is advanced only past rows we successfully pushed; the
//     next tick resumes from the last good row).
//
// State table writes never insert into the activity stream (the state
// table is plain SQL, not an attribute_value upsert), so pointer
// advance does not loop back as a new activity row to push.
//
// KITP_ACTIVITY_SINK_DRY_RUN=1 short-circuits the Graph HTTP call — the
// pumper records the would-be message in the logger and advances the
// pointer as if the push succeeded. Useful for local smoke tests.
package activitysink

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// SinkKindMSGraphTeams is the only sink_kind supported in v1.
const SinkKindMSGraphTeams = "msgraph_teams"

// MSGraphPoster is the seam between the pump and the wire. Returns nil
// on a successful POST, *MSGraphPermanentError when MS Graph reports a
// non-retriable failure (auth, missing channel, …), and any other
// error for transient failure (network, 5xx, throttling).
//
// The default poster is realMSGraphPost; tests inject a recording stub
// via SetPoster.
type MSGraphPoster func(ctx context.Context, cfg MSGraphConfig, message string) error

// MSGraphConfig is the per-sink config the poster needs. Resolved once
// per RunOnce from the sink card's attributes + the decrypted secret.
type MSGraphConfig struct {
	TenantID     string
	ClientID     string
	ClientSecret string
	TeamID       string
	ChannelID    string
}

// MSGraphPermanentError signals a non-retriable failure. The pumper
// flips the sink to disabled-fault when it sees one.
type MSGraphPermanentError struct {
	Status int
	Body   string
}

func (e *MSGraphPermanentError) Error() string {
	return fmt.Sprintf("ms graph permanent error %d: %s", e.Status, truncate(e.Body, 200))
}

// MSGraphPumper owns the per-sink poll loop.
type MSGraphPumper struct {
	pool       *store.Pool
	sinkID     int64
	projectID  int64 // resolved at construction
	tick       time.Duration
	batchLimit int
	dryRun     bool
	logger     *slog.Logger
	poster     MSGraphPoster
}

// NewMSGraphPumperForTest builds a pumper so tests can drive RunOnce /
// TickOnce synchronously. Production builds them through an [MSGraphPool],
// which reconciles one pumper per sink and ticks them via the scheduler.
func NewMSGraphPumperForTest(pool *store.Pool, sinkID, projectID int64, tick time.Duration) *MSGraphPumper {
	return newPumper(pool, sinkID, projectID, tick)
}

func newPumper(pool *store.Pool, sinkID, projectID int64, tick time.Duration) *MSGraphPumper {
	if tick < time.Second {
		tick = time.Second
	}
	return &MSGraphPumper{
		pool:       pool,
		sinkID:     sinkID,
		projectID:  projectID,
		tick:       tick,
		batchLimit: 50,
		dryRun:     os.Getenv("KITP_ACTIVITY_SINK_DRY_RUN") == "1",
		logger:     slog.Default(),
		poster:     realMSGraphPost,
	}
}

// SetLogger overrides slog.Default().
func (p *MSGraphPumper) SetLogger(l *slog.Logger) {
	if l != nil {
		p.logger = l
	}
}

// SetPoster swaps the MS Graph poster — tests inject a recording stub.
func (p *MSGraphPumper) SetPoster(fn MSGraphPoster) {
	if fn != nil {
		p.poster = fn
	}
}

// SetBatchLimit overrides the per-tick cap on activity rows scanned.
// Production defaults to 50; tests use a generous value so a single
// RunOnce drains a small fixture.
func (p *MSGraphPumper) SetBatchLimit(n int) {
	if n > 0 {
		p.batchLimit = n
	}
}

// TickOnce pushes one sink's pending activity rows, under a 60s budget and
// the System actor. Logs and returns the RunOnce error; the [MSGraphPool]
// sweep discards it so one bad sink doesn't fail the pump job. There's no
// persistent connection between ticks.
func (p *MSGraphPumper) TickOnce(ctx context.Context) error {
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	runCtx = auth.WithSystemUser(runCtx)
	if err := p.RunOnce(runCtx); err != nil {
		p.logger.LogAttrs(runCtx, slog.LevelError, "activity_sink pumper RunOnce",
			slog.Int64("sink_id", p.sinkID),
			slog.String("err", err.Error()))
		return err
	}
	return nil
}

// RunOnce executes one scan + push cycle synchronously. Exported so
// tests can drive the loop without waiting on the ticker. Returns the
// first non-validation error encountered (Graph push failures are
// surfaced after the per-row state has been recorded).
func (p *MSGraphPumper) RunOnce(ctx context.Context) error {
	status, _, err := comm.ReadChannelStatus(ctx, p.pool.P, p.sinkID)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: read status: %w", err)
	}
	if status != comm.ChannelStatusEnabled {
		return nil
	}

	cfg, filter, pointer, err := p.loadRunConfig(ctx)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: load config: %w", err)
	}

	rows, err := p.loadActivityBatch(ctx, pointer)
	if err != nil {
		return fmt.Errorf("activity_sink pumper: load activity: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}

	var pushed int64
	var lastDelivered int64 = pointer
	for _, r := range rows {
		if filter.Eval(r) {
			msg := renderActivityMessage(r)
			if p.dryRun {
				p.logger.LogAttrs(ctx, slog.LevelInfo, "activity_sink dry-run",
					slog.Int64("sink_id", p.sinkID),
					slog.Int64("activity_id", r.ID),
					slog.String("kind", r.Kind),
					slog.String("body", msg))
			} else {
				if err := p.poster(ctx, cfg, msg); err != nil {
					// Record progress through the last row that landed,
					// then surface the failure. Pointer advance up to
					// lastDelivered means we won't re-push successful
					// rows on the next tick.
					if errors.As(err, new(*MSGraphPermanentError)) {
						_ = comm.MarkChannelFault(ctx, p.pool, p.sinkID, truncate(err.Error(), 200))
					}
					if writeErr := p.recordState(ctx, lastDelivered, pushed, err.Error()); writeErr != nil {
						p.logger.LogAttrs(ctx, slog.LevelError, "activity_sink state write failed",
							slog.Int64("sink_id", p.sinkID),
							slog.String("err", writeErr.Error()))
					}
					return err
				}
			}
			pushed++
		}
		lastDelivered = r.ID
	}

	if err := p.recordState(ctx, lastDelivered, pushed, ""); err != nil {
		return fmt.Errorf("activity_sink pumper: write state: %w", err)
	}
	return nil
}

// loadRunConfig pulls every per-tick datum the pumper needs in one
// transaction: the MS Graph config (with decrypted secret), the parsed
// filter predicate, and the last_activity_id pointer.
func (p *MSGraphPumper) loadRunConfig(ctx context.Context) (MSGraphConfig, Predicate, int64, error) {
	var cfg MSGraphConfig
	var filterRaw string
	err := p.pool.P.QueryRow(ctx, `
		SELECT
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='msgraph_tenant_id'),''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='msgraph_client_id'),''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='msgraph_team_id'),''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='msgraph_channel_id'),''),
			COALESCE((SELECT value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = $1 AND ad.name='activity_filter'),''),
			COALESCE((SELECT pgp_sym_decrypt(client_secret, current_setting('app.comm_secret_key')) FROM activity_sink_secret WHERE sink_card_id = $1),'')
	`, p.sinkID).Scan(
		&cfg.TenantID, &cfg.ClientID, &cfg.TeamID, &cfg.ChannelID, &filterRaw, &cfg.ClientSecret,
	)
	if err != nil {
		return MSGraphConfig{}, Predicate{}, 0, err
	}

	pred, err := ParsePredicate(filterRaw)
	if err != nil {
		// Bad filter is treated as a permanent fault: stop pushing so we
		// don't flood the channel with un-filtered rows; admin fixes
		// the JSON and re-enables.
		_ = comm.MarkChannelFault(ctx, p.pool, p.sinkID, fmt.Sprintf("activity_filter: invalid JSON: %v", err))
		return cfg, Predicate{}, 0, fmt.Errorf("activity_filter parse: %w", err)
	}

	var pointer int64
	if err := p.pool.P.QueryRow(ctx, `
		SELECT COALESCE(last_activity_id, 0) FROM activity_sink_state WHERE sink_card_id = $1
	`, p.sinkID).Scan(&pointer); err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return cfg, pred, 0, err
	}
	return cfg, pred, pointer, nil
}

// loadActivityBatch materialises the project's card tree and scans
// activity rows past the pointer. Returns up to batchLimit rows in
// id-ascending order.
//
// The recursive CTE caps depth at 15 (depth < 16) so a corrupted
// parent_card_id cycle can't pin the worker forever. 16 matches the
// dispatcher's `scopeWalkDepth` cap (see internal/api/authz.go) so
// the two walks share one rule. Real card hierarchies are 3-4 deep;
// 16 is generous headroom. Closes S9.
func (p *MSGraphPumper) loadActivityBatch(ctx context.Context, pointer int64) ([]ActivityRow, error) {
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
		)
		SELECT a.id, a.card_id, a.kind,
		       COALESCE(ad.name, '') AS attribute_name,
		       a.actor_id
		FROM activity a
		LEFT JOIN attribute_def ad ON ad.id = a.attribute_def_id
		WHERE a.id > :pointer
		  AND a.card_id IN (SELECT id FROM project_cards)
		ORDER BY a.id ASC
		LIMIT :limit
	`)
	if err != nil {
		return nil, fmt.Errorf("loadActivityBatch: compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ActivityRow
	for rows.Next() {
		var r ActivityRow
		if err := rows.Scan(&r.ID, &r.CardID, &r.Kind, &r.AttributeName, &r.ActorID); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// recordState upserts the pointer / counters / last_error on the sink's
// state row. last_pushed_at is updated whenever pushedThisTick>0 OR an
// error is recorded so admins see liveness even on quiet ticks.
func (p *MSGraphPumper) recordState(ctx context.Context, newPointer int64, pushedThisTick int64, lastError string) error {
	var lastErrArg any
	if lastError != "" {
		lastErrArg = lastError
	}
	_, err := p.pool.P.Exec(ctx, `
		INSERT INTO activity_sink_state (sink_card_id, last_activity_id, last_pushed_at, last_pushed_count, last_error, updated_at)
		VALUES ($1, $2, CASE WHEN $3 > 0 OR $4::text IS NOT NULL THEN now() ELSE NULL END, $3, $4, now())
		ON CONFLICT (sink_card_id) DO UPDATE SET
			last_activity_id  = GREATEST(activity_sink_state.last_activity_id, EXCLUDED.last_activity_id),
			last_pushed_at    = CASE WHEN $3 > 0 OR $4::text IS NOT NULL THEN now() ELSE activity_sink_state.last_pushed_at END,
			last_pushed_count = activity_sink_state.last_pushed_count + $3,
			last_error        = $4,
			updated_at        = now()
	`, p.sinkID, newPointer, pushedThisTick, lastErrArg)
	if err != nil {
		return err
	}
	if p.pool != nil {
		p.pool.NoteWrite()
	}
	return nil
}

// renderActivityMessage builds the HTML body for a Teams message. Kept
// deliberately compact — Teams renders simple HTML well; richer card
// rendering can come later (Adaptive Cards) once we know what operators
// actually want to see.
func renderActivityMessage(r ActivityRow) string {
	switch r.Kind {
	case "card_create":
		return fmt.Sprintf("Card <b>#%d</b> created", r.CardID)
	case "comment":
		return fmt.Sprintf("Comment posted on card <b>#%d</b>", r.CardID)
	case "attr_update":
		if r.AttributeName != "" {
			return fmt.Sprintf("Card <b>#%d</b> attribute <code>%s</code> updated",
				r.CardID, html.EscapeString(r.AttributeName))
		}
		return fmt.Sprintf("Card <b>#%d</b> updated", r.CardID)
	}
	return fmt.Sprintf("Card <b>#%d</b> activity: %s", r.CardID, html.EscapeString(r.Kind))
}

// ---- MS Graph HTTP client ----

// tokenCache is a single-tenant access token + expiry pair. The pumper
// keeps one per sink so successive ticks reuse the same token until it
// is close to expiring.
type tokenCache struct {
	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// One cache per (tenant, client_id). MS Graph permits the same app
// registration to be used across many sinks; sharing the cache keeps
// us from rate-limiting ourselves on the token endpoint.
var (
	tokenCachesMu sync.Mutex
	tokenCaches   = map[string]*tokenCache{}
)

func getTokenCache(tenant, client string) *tokenCache {
	tokenCachesMu.Lock()
	defer tokenCachesMu.Unlock()
	key := tenant + "|" + client
	if tc, ok := tokenCaches[key]; ok {
		return tc
	}
	tc := &tokenCache{}
	tokenCaches[key] = tc
	return tc
}

// realMSGraphPost is the production poster. Acquires (or reuses) a
// client_credentials access token, then POSTs the message to
// /teams/{team}/channels/{channel}/messages.
func realMSGraphPost(ctx context.Context, cfg MSGraphConfig, message string) error {
	if cfg.TenantID == "" || cfg.ClientID == "" || cfg.ClientSecret == "" {
		return &MSGraphPermanentError{Status: 0, Body: "missing MS Graph credentials"}
	}
	if cfg.TeamID == "" || cfg.ChannelID == "" {
		return &MSGraphPermanentError{Status: 0, Body: "missing MS Graph team/channel id"}
	}

	tc := getTokenCache(cfg.TenantID, cfg.ClientID)
	tc.mu.Lock()
	tok := tc.token
	exp := tc.expiresAt
	tc.mu.Unlock()
	if tok == "" || time.Until(exp) < 60*time.Second {
		newTok, newExp, err := fetchMSGraphToken(ctx, cfg)
		if err != nil {
			return err
		}
		tc.mu.Lock()
		tc.token, tc.expiresAt = newTok, newExp
		tc.mu.Unlock()
		tok = newTok
	}

	endpoint := fmt.Sprintf("https://graph.microsoft.com/v1.0/teams/%s/channels/%s/messages",
		url.PathEscape(cfg.TeamID), url.PathEscape(cfg.ChannelID))
	body := map[string]any{
		"body": map[string]any{
			"contentType": "html",
			"content":     message,
		},
	}
	bodyBytes, err := json.Marshal(body)
	if err != nil {
		return fmt.Errorf("marshal graph body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	respBody, _ := io.ReadAll(resp.Body)
	if isPermanentStatus(resp.StatusCode) {
		return &MSGraphPermanentError{Status: resp.StatusCode, Body: string(respBody)}
	}
	return fmt.Errorf("ms graph transient %d: %s", resp.StatusCode, truncate(string(respBody), 200))
}

func fetchMSGraphToken(ctx context.Context, cfg MSGraphConfig) (string, time.Time, error) {
	tokenURL := fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", url.PathEscape(cfg.TenantID))
	form := url.Values{}
	form.Set("client_id", cfg.ClientID)
	form.Set("client_secret", cfg.ClientSecret)
	form.Set("grant_type", "client_credentials")
	form.Set("scope", "https://graph.microsoft.com/.default")

	req, err := http.NewRequestWithContext(ctx, "POST", tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", time.Time{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", time.Time{}, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Token-endpoint failures with 4xx (bad creds, bad tenant) are
		// permanent; 5xx is transient.
		if isPermanentStatus(resp.StatusCode) {
			return "", time.Time{}, &MSGraphPermanentError{Status: resp.StatusCode, Body: string(respBody)}
		}
		return "", time.Time{}, fmt.Errorf("ms graph token transient %d: %s", resp.StatusCode, truncate(string(respBody), 200))
	}
	var tok struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
	}
	if err := json.Unmarshal(respBody, &tok); err != nil {
		return "", time.Time{}, fmt.Errorf("decode token: %w", err)
	}
	if tok.AccessToken == "" {
		return "", time.Time{}, &MSGraphPermanentError{Status: resp.StatusCode, Body: "missing access_token"}
	}
	exp := time.Now().Add(time.Duration(tok.ExpiresIn) * time.Second)
	if tok.ExpiresIn == 0 {
		exp = time.Now().Add(30 * time.Minute) // safe default
	}
	return tok.AccessToken, exp, nil
}

// isPermanentStatus returns true for status codes that should flip the
// sink into disabled-fault rather than just retrying next tick.
func isPermanentStatus(code int) bool {
	switch code {
	case 400, 401, 403, 404:
		return true
	}
	return false
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ---- pool start / discovery ----

// ListSinks returns every activity_sink card id paired with its parent
// project id. Called once at startup by StartMSGraphPumperPool; adding
// a new sink currently requires a kitpd restart (mirrors comm — auto-
// detect is a follow-up gate).
func ListSinks(ctx context.Context, pool *store.Pool) ([]struct{ SinkID, ProjectID int64 }, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT c.id, c.parent_card_id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name = 'activity_sink' AND c.deleted_at IS NULL
		ORDER BY c.id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []struct{ SinkID, ProjectID int64 }
	for rows.Next() {
		var id int64
		var parent *int64
		if err := rows.Scan(&id, &parent); err != nil {
			return nil, err
		}
		if parent == nil {
			continue // misconfigured sink without a parent project
		}
		out = append(out, struct{ SinkID, ProjectID int64 }{id, *parent})
	}
	return out, rows.Err()
}

// sinkKey identifies a pumper by sink id + its parent project (the
// project is resolved once at construction so the pumper needn't query
// for its scope each tick). Comparable so it can key the worker pool.
type sinkKey struct{ SinkID, ProjectID int64 }

// MSGraphPool drives every activity_sink's pumper from a single scheduler
// job. Each RunOnce reconciles one [MSGraphPumper] per live sink and ticks
// each one. Construct with [NewMSGraphPool] and call RunOnce from the
// `activitysink.pump` job (see cmd/kitpd/main.go).
type MSGraphPool struct {
	pool *store.Pool
	wp   *job.WorkerPool[sinkKey, *MSGraphPumper]
}

// NewMSGraphPool builds the pool. tick is the per-pumper cadence hint (the
// real cadence is the owning job's Interval); logger is threaded to each
// pumper.
func NewMSGraphPool(pool *store.Pool, tick time.Duration, logger *slog.Logger) *MSGraphPool {
	m := &MSGraphPool{pool: pool}
	m.wp = job.NewWorkerPool[sinkKey, *MSGraphPumper](
		func(k sinkKey) *MSGraphPumper {
			p := newPumper(pool, k.SinkID, k.ProjectID, tick)
			p.SetLogger(logger)
			return p
		},
		// Discard the per-sink error: TickOnce already logged it, and one
		// bad sink must not flip the whole pump job red.
		func(ctx context.Context, p *MSGraphPumper) error { _ = p.TickOnce(ctx); return nil },
	)
	return m
}

// RunOnce is the `activitysink.pump` job body: list every sink and sweep
// its pumper. Returns only a sink-enumeration error.
func (m *MSGraphPool) RunOnce(ctx context.Context) error {
	sinks, err := ListSinks(ctx, m.pool)
	if err != nil {
		return fmt.Errorf("activity_sink pump: list sinks: %w", err)
	}
	keys := make([]sinkKey, len(sinks))
	for i, s := range sinks {
		keys[i] = sinkKey{SinkID: s.SinkID, ProjectID: s.ProjectID}
	}
	return m.wp.Sweep(ctx, keys)
}
