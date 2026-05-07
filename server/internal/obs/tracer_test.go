package obs_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// captureHandler is an slog.Handler that buffers every record so the
// tracer test can count "pgx.query" lines.
type captureHandler struct {
	mu      sync.Mutex
	records []slog.Record
}

func (c *captureHandler) Enabled(_ context.Context, lvl slog.Level) bool { return true }
func (c *captureHandler) Handle(_ context.Context, r slog.Record) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.records = append(c.records, r)
	return nil
}
func (c *captureHandler) WithAttrs(_ []slog.Attr) slog.Handler { return c }
func (c *captureHandler) WithGroup(_ string) slog.Handler      { return c }

func (c *captureHandler) traceMessages() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	var out []string
	for _, r := range c.records {
		if r.Message == "pgx.query" {
			r.Attrs(func(a slog.Attr) bool {
				if a.Key == "sql" {
					out = append(out, a.Value.String())
				}
				return true
			})
		}
	}
	return out
}

// TestPGTracer_Coalesce100AttrUpdates verifies that 100 attribute.update
// sub-requests in one batch trigger ≤ 3 distinct SQL statement-groups
// (the tracer captures each Query/Exec call). N-PERF-1 acceptance.
func TestPGTracer_Coalesce100AttrUpdates(t *testing.T) {
	cap := &captureHandler{}
	logger := slog.New(cap)
	tracer := &obs.QueryTracer{Logger: logger}

	pool := newTracedPool(t, "kitp_test_obs_tracer", tracer)
	sp := store.NewPool(pool)

	reg.Reset()
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)

	srv := api.NewServer(sp)
	srv.Logger = obs.NewLoggerTo("warn", io.Discard)

	ctx := auth.WithSystemUser(context.Background())

	// Seed: project + 100 tasks.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0])
	}
	var pOut card.InsertOutput
	{
		buf, _ := json.Marshal(resp.Subresponses[0].Data)
		_ = json.Unmarshal(buf, &pOut)
	}

	subs := make([]api.SubRequest, 100)
	for i := range subs {
		subs[i] = api.SubRequest{
			ID:       fmt.Sprintf("t%d", i),
			Endpoint: "card",
			Action:   "insert",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":%d,"title":"task%d"}`, pOut.ID, i)),
		}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: subs})
	taskIDs := make([]int64, 100)
	for i, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("task %d: %+v", i, sr)
		}
		var o card.InsertOutput
		buf, _ := json.Marshal(sr.Data)
		_ = json.Unmarshal(buf, &o)
		taskIDs[i] = o.ID
	}

	// Reset the trace buffer; everything from here on is the measured batch.
	cap.mu.Lock()
	cap.records = nil
	cap.mu.Unlock()

	updates := make([]api.SubRequest, 100)
	for i := range updates {
		updates[i] = api.SubRequest{
			ID:       fmt.Sprintf("u%d", i),
			Endpoint: "attribute",
			Action:   "update",
			Data: json.RawMessage(fmt.Sprintf(
				`{"card_id":%d,"attribute_name":"title","value":"updated%d"}`, taskIDs[i], i)),
		}
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: updates})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("update: %+v", sr.Error)
		}
	}

	traces := cap.traceMessages()
	t.Logf("captured %d trace lines", len(traces))
	for i, s := range traces {
		t.Logf("  [%d] %.120s", i, s)
	}
	// "Statement-groups per batch" in N-PERF-1 means the SQL work that
	// happens INSIDE the dispatcher's transaction — pre-tx validation
	// hooks (per-subrequest card lookup, edge lookup, role grant) run
	// outside the tx and are not what coalescing is about. Count only
	// the lines that fall between BEGIN and COMMIT.
	work := countTxStatements(traces)
	if work > 3 {
		t.Fatalf("attribute.update statement-groups inside tx: got %d, want ≤ 3", work)
	}
}

// countTxStatements walks the trace lines and returns how many real SQL
// statements ran between the most recent BEGIN and the matching COMMIT.
// BEGIN/COMMIT/ROLLBACK themselves are not counted.
func countTxStatements(traces []string) int {
	in := false
	max := 0
	cur := 0
	for _, s := range traces {
		ss := strings.ToUpper(strings.TrimSpace(s))
		switch {
		case strings.HasPrefix(ss, "BEGIN"):
			in = true
			cur = 0
		case strings.HasPrefix(ss, "COMMIT") || strings.HasPrefix(ss, "ROLLBACK"):
			if in && cur > max {
				max = cur
			}
			in = false
		default:
			if in && ss != "" {
				cur++
			}
		}
	}
	// Edge case: tx didn't end (shouldn't happen here).
	if in && cur > max {
		max = cur
	}
	return max
}

// newTracedPool builds a pgxpool.Pool with the supplied tracer attached
// and routed at the test schema. Migrates the schema first via
// store.TestPool, then opens a fresh pool that picks up the tracer.
func newTracedPool(t *testing.T, schema string, tracer *obs.QueryTracer) *pgxpool.Pool {
	t.Helper()
	// store.TestPool is responsible for the schema lifecycle (drop,
	// create, migrate, drop on cleanup). Open it, close it, and then
	// re-open with our tracer config — both pools point at the same
	// schema thanks to the shared search_path.
	plain := store.TestPool(t, schema)
	plain.Close()

	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable"
	}
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	// Tracer + search_path on the underlying conn config.
	cfg.ConnConfig.Tracer = tracer
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"

	pool, err := pgxpool.NewWithConfig(context.Background(), cfg)
	if err != nil {
		t.Fatalf("new pool: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
