package store

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema/hcsv"
)

// TestPool creates a fresh schema for the test package, applies the
// declarative schema (including the demo seed section so tests see
// the populated dev fixtures), and returns a pool whose search_path
// is set to that schema. The schema is dropped at test cleanup time.
//
// schemaName must be a short identifier — typically derived from the
// test package name. Example: "kitp_test_api".
func TestPool(t testing.TB, schemaName string) *pgxpool.Pool {
	t.Helper()
	if !validIdent(schemaName) {
		t.Fatalf("invalid schema name %q", schemaName)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable"
	}

	ctx := context.Background()

	// First open a tiny pool with the default search path so we can drop /
	// recreate the test schema.
	bootstrap, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("bootstrap pgxpool: %v", err)
	}
	defer bootstrap.Close()

	if _, err := bootstrap.Exec(ctx, fmt.Sprintf(`DROP SCHEMA IF EXISTS %s CASCADE`, schemaName)); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := bootstrap.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %s`, schemaName)); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	// Build a config that binds search_path for every new connection.
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		if _, err := c.Exec(ctx, fmt.Sprintf(`SET search_path = %s, public`, schemaName)); err != nil {
			return err
		}
		return setCommSecretKey(ctx, c)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("scoped pgxpool: %v", err)
	}

	if err := ApplySchema(ctx, pool, hcsv.GenerateOptions{Demo: true}); err != nil {
		pool.Close()
		t.Fatalf("apply schema: %v", err)
	}

	registerCleanup(t, pool, dsn, schemaName)
	return pool
}

// TestPoolBare is TestPool minus ApplySchema. Use this when a test
// wants to control exactly which seed / demo combination is loaded
// (e.g., migrate-test row-count assertions against test_demo.hcsv,
// or seed-only smoke tests).
func TestPoolBare(t *testing.T, schemaName string) *pgxpool.Pool {
	t.Helper()
	if !validIdent(schemaName) {
		t.Fatalf("invalid schema name %q", schemaName)
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://kitp:kitp@127.0.0.1:5544/kitp?sslmode=disable"
	}
	ctx := context.Background()

	bootstrap, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("bootstrap pgxpool: %v", err)
	}
	defer bootstrap.Close()
	if _, err := bootstrap.Exec(ctx, fmt.Sprintf(`DROP SCHEMA IF EXISTS %s CASCADE`, schemaName)); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := bootstrap.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA %s`, schemaName)); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatalf("parse pool config: %v", err)
	}
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		if _, err := c.Exec(ctx, fmt.Sprintf(`SET search_path = %s, public`, schemaName)); err != nil {
			return err
		}
		return setCommSecretKey(ctx, c)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("scoped pgxpool: %v", err)
	}
	registerCleanup(t, pool, dsn, schemaName)
	return pool
}

// TemplateStatusID returns the status card titled title that projectID
// inherited from the standard template when card.insert stamped it: the
// task flow's New idea / Todo / Doing / Review / Done / Cancelled, or the
// comm flow's Open / In progress / Resolved. Fixtures that create tasks
// under a stamped project must start them on one of these — card.insert
// only accepts a status that is a state of the project's flow, so an
// ad-hoc status card is rejected with 'flow_invalid_state'.
func TemplateStatusID(t testing.TB, pool *pgxpool.Pool, projectID int64, title string) int64 {
	t.Helper()
	b := named.New()
	b.Set("project_id", projectID)
	b.Set("title", title)
	sql, args, err := b.Compile(`
		SELECT c.id
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'status'
		JOIN attribute_value av ON av.card_id = c.id
		JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		WHERE c.parent_card_id = :project_id
		  AND c.deleted_at IS NULL
		  AND av.value = to_jsonb(:title::text)
	`)
	if err != nil {
		t.Fatalf("template status: compile: %v", err)
	}
	var id int64
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&id); err != nil {
		t.Fatalf("template status %q under project %d: %v", title, projectID, err)
	}
	return id
}

func registerCleanup(t testing.TB, pool *pgxpool.Pool, dsn, schemaName string) {
	t.Cleanup(func() {
		pool.Close()
		// Use a fresh bootstrap pool to drop, since the scoped pool is closed.
		drop, err := pgxpool.New(context.Background(), dsn)
		if err != nil {
			return
		}
		defer drop.Close()
		_, _ = drop.Exec(context.Background(), fmt.Sprintf(`DROP SCHEMA IF EXISTS %s CASCADE`, schemaName))
	})
}

func validIdent(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return !strings.ContainsAny(s, ";\"'")
}
