// Command kitpd is the kitp server. By default it runs the HTTP API
// server on LISTEN_ADDR; the "mcp" subcommand runs the MCP JSON-RPC
// server over stdin/stdout (Phase 19).
//
// Configuration is environment-driven:
//   DATABASE_URL              — pgx connection string (required)
//   LISTEN_ADDR               — listen address, default ":8080"
//   AUTH_MODE                 — "off" (System User) or "oidc"; default "off"
//   ENV                       — "dev" or "production"; default "dev"
//   MIGRATIONS_DIR            — path to db/migrations, default "./db/migrations"
//   LOG_LEVEL                 — debug|info|warn|error; default info (Phase 21)
//   PG_TRACE                  — non-empty enables pgx query tracing (dev) (Phase 21)
//   CORS                      — on|off override; default on in dev, off in production (Phase 22)
//   ATTACHMENT_MAX_MB         — whole-file upload cap in megabytes; default 250
//   ATTACHMENT_CHUNK_MAX_MB   — per-chunk cap on /api/v1/cas/chunk; default 8
//   CAS_REAPER_INTERVAL_SEC   — reaper sweep cadence in seconds; default 3600
//   CAS_REAPER_GRACE_SEC      — orphan grace period in seconds; default 3600
//
// In production the server refuses to start if AUTH_MODE=off (N-SEC-5).
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/attributedef"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	domconfig "github.com/kitp/kitp/server/internal/dom/config"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/dom/gate"
	"github.com/kitp/kitp/server/internal/dom/inbox"
	"github.com/kitp/kitp/server/internal/dom/process"
	"github.com/kitp/kitp/server/internal/dom/projecttype"
	domrole "github.com/kitp/kitp/server/internal/dom/role"
	"github.com/kitp/kitp/server/internal/dom/rolemapping"
	"github.com/kitp/kitp/server/internal/dom/workflowdef"
	"github.com/kitp/kitp/server/internal/dom/workflowtransition"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/dom/proc"
	domuser "github.com/kitp/kitp/server/internal/dom/user"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/dom/userrole"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/store"
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// envInt reads an integer-valued env var. Returns fallback when the var is
// unset, empty, or fails to parse — invalid values log a warning and fall
// through (silent fall-through hides typos).
func envInt(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		log.Printf("warning: %s=%q is not a valid integer; using default %d", key, v, fallback)
		return fallback
	}
	return n
}

// registerHandlers installs every domain handler into the registry.
// Called by both the HTTP and MCP entrypoints — must only fire once
// per process (reg.Register panics on duplicates).
func registerHandlers(pool *store.Pool) {
	echo.Register()
	cardtype.Register()
	card.Register(pool)
	attribute.Register(pool)
	attributedef.Register(pool)
	activity.Register(pool)
	attachment.Register(pool)
	domcas.Register(pool)
	comment.Register(pool)
	domconfig.Register()
	file.Register(pool)
	tag.Register(pool)
	process.Register(pool)
	proc.Register(pool)
	projecttype.Register(pool)
	workflowtransition.Register(pool)
	workflowdef.Register(pool)
	gate.Register(pool)
	domuser.Register()
	usercardsort.Register(pool)
	inbox.Register(pool)
	domrole.Register()
	userrole.Register(pool)
	rolemapping.Register(pool)
}

// buildPgxPool constructs a pgxpool.Pool from dsn, optionally installing
// the obs.QueryTracer when LOG_LEVEL=debug or PG_TRACE=1.
func buildPgxPool(ctx context.Context, dsn string, logger *slog.Logger) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if obs.PGTraceEnabled() {
		cfg.ConnConfig.Tracer = &obs.QueryTracer{Logger: logger}
	}
	return pgxpool.NewWithConfig(ctx, cfg)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		if err := runMCP(); err != nil {
			fmt.Fprintln(os.Stderr, "mcp:", err)
			os.Exit(1)
		}
		return
	}
	if err := runHTTP(); err != nil {
		log.Fatalf("kitpd: %v", err)
	}
}

func runHTTP() error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	addr := envOr("LISTEN_ADDR", ":8080")
	mode := auth.Mode(envOr("AUTH_MODE", string(auth.ModeOff)))
	env := envOr("ENV", "dev")
	migrationsDir := envOr("MIGRATIONS_DIR", filepath.Join("db", "migrations"))
	webDir := os.Getenv("WEB_DIR") // optional; if set, kitpd serves the Flutter bundle

	if env == "production" && mode == auth.ModeOff {
		return errors.New("refusing to start: ENV=production with AUTH_MODE=off (see N-SEC-5)")
	}
	if env == "production" && mode == auth.ModeOIDC && os.Getenv("OIDC_ISSUER") == "" {
		return errors.New("refusing to start: ENV=production with AUTH_MODE=oidc but OIDC_ISSUER is empty")
	}

	logger := obs.NewLogger(envOr("LOG_LEVEL", "info"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pgPool, err := buildPgxPool(ctx, dsn, logger)
	if err != nil {
		return fmt.Errorf("pgxpool.New: %w", err)
	}
	defer pgPool.Close()

	if err := store.Migrate(ctx, pgPool, migrationsDir); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	if os.Getenv("MIGRATE_ONLY") != "" {
		log.Printf("MIGRATE_ONLY set; migrations applied, exiting")
		return nil
	}

	user, err := auth.NewSystemUser(ctx, pgPool, env, mode)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	pool := store.NewPool(pgPool)
	registerHandlers(pool)

	srv := api.NewServer(pool)
	srv.Logger = logger

	mux := http.NewServeMux()
	if webDir != "" {
		if st, err := os.Stat(webDir); err == nil && st.IsDir() {
			log.Printf("serving Flutter web bundle from %s at GET /", webDir)
		} else {
			log.Printf("WEB_DIR=%q not found; serving JSON root only", webDir)
			webDir = ""
		}
	}
	srv.Mount(mux, webDir)

	// CAS storage + chunked-upload + attachment download routes.
	//
	//   - The pg backend is the only configured backend in v1; future
	//     S3 / GCS backends prepend onto the chain.
	//   - cas.RegisterHTTP mounts POST /api/v1/cas/chunk for the per-
	//     chunk multipart upload (cap = ATTACHMENT_CHUNK_MAX_MB).
	//   - attachment.RegisterHTTP mounts GET /api/v1/attachment/{id}/
	//     download which streams the chunks back in order.
	//   - file.create / attachment.create / attachment.list /
	//     attachment.delete go through the JSON batch dispatcher (see
	//     registerHandlers).
	maxAttachMB := envInt("ATTACHMENT_MAX_MB", 250)
	maxAttachBytes := int64(maxAttachMB) * 1024 * 1024
	chunkMaxMB := envInt("ATTACHMENT_CHUNK_MAX_MB", 8)
	chunkMaxBytes := int64(chunkMaxMB) * 1024 * 1024
	storage := cas.New(cas.NewPgBackend(pgPool))
	cas.RegisterHTTP(mux, cas.HTTPConfig{
		Pool:     pool,
		Storage:  storage,
		MaxBytes: chunkMaxBytes,
		Logger:   logger,
	})
	attachment.RegisterHTTP(mux, attachment.Config{
		Pool:    pool,
		Storage: storage,
		Logger:  logger,
	})
	// Hand the dispatcher's attachment.create handler the CAS storage so
	// it can build a thumbnail server-side for image attachments. Wiring
	// is optional — leaving thumbDeps unset (e.g. in tests) just skips
	// thumb generation; the upload still completes.
	attachment.SetThumbDeps(storage, logger)
	// Publish the live caps so the client can read them via config.get.
	// AttachmentMaxBytes is the whole-file cap the UI enforces before
	// chunking; ChunkMaxBytes is what the server's chunk route accepts.
	domconfig.SetSnapshot(domconfig.Snapshot{
		AttachmentMaxBytes: maxAttachBytes,
		ChunkMaxBytes:      chunkMaxBytes,
	})

	// CAS reaper. Sweeps at the configured cadence, dropping cas_blob
	// (and bytes via every backend) for orphans older than the grace
	// period. Stops when ctx is cancelled.
	reaper := &cas.Reaper{
		Pool:        pgPool,
		Storage:     storage,
		Interval:    time.Duration(envInt("CAS_REAPER_INTERVAL_SEC", 3600)) * time.Second,
		GracePeriod: time.Duration(envInt("CAS_REAPER_GRACE_SEC", 3600)) * time.Second,
		Logger:      logger,
	}
	reaper.Start(ctx)

	idem := obs.NewIdempotencyStore(pgPool, logger)
	idem.StartCleanup(ctx)

	// Wrap order from outermost in: CORS -> request id -> logging ->
	// idempotency -> auth (System User OR OIDC) -> dispatcher. CORS lives at
	// the outer layer so OPTIONS preflights short-circuit before doing any
	// real work; the rest of the chain still executes for POSTs.
	authMW := auth.Middleware(user) // dev-mode default
	if mode == auth.ModeOIDC {
		oidcCfg := oidc.FromEnv(os.Getenv)
		if oidcCfg == nil {
			return errors.New("AUTH_MODE=oidc but OIDC_ISSUER is empty")
		}
		validator := oidc.NewValidator(oidcCfg, pgPool)
		authMW = oidc.Middleware(validator)
		log.Printf("OIDC enabled (issuer=%s aud=%s)", oidcCfg.Issuer, oidcCfg.Audience)
	}
	var inner http.Handler = obs.RequestIDMiddleware(
		obs.LoggingMiddleware(logger,
			idem.Middleware(srv,
				authMW(mux),
			),
		),
	)
	httpHandler := inner
	if api.CORSEnabled(env) {
		httpHandler = api.CORSMiddleware(inner)
		log.Printf("CORS enabled (env=%s)", env)
	}

	httpSrv := &http.Server{
		Addr:              addr,
		Handler:           httpHandler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("kitpd listening on %s (env=%s auth=%s user=%q)", addr, env, mode, user.DisplayName)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-stop
	log.Printf("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	return nil
}

// runMCP boots the MCP JSON-RPC stdio server. Logs go to stderr so they
// never pollute the JSON-RPC stream on stdout.
func runMCP() error {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		return errors.New("DATABASE_URL is required")
	}
	mode := auth.Mode(envOr("AUTH_MODE", string(auth.ModeOff)))
	env := envOr("ENV", "dev")
	migrationsDir := envOr("MIGRATIONS_DIR", filepath.Join("db", "migrations"))

	if env == "production" && mode == auth.ModeOff {
		return errors.New("refusing to start: ENV=production with AUTH_MODE=off")
	}

	log.SetOutput(os.Stderr)
	logger := obs.NewLoggerTo(envOr("LOG_LEVEL", "warn"), os.Stderr)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	pgPool, err := buildPgxPool(ctx, dsn, logger)
	if err != nil {
		return fmt.Errorf("pgxpool.New: %w", err)
	}
	defer pgPool.Close()

	if err := store.Migrate(ctx, pgPool, migrationsDir); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}

	user, err := auth.NewSystemUser(ctx, pgPool, env, mode)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	pool := store.NewPool(pgPool)
	registerHandlers(pool)

	srv := api.NewServer(pool)
	srv.Logger = logger

	// Pick the MCP tool surface. `minimal` (default) lists only
	// proc.search so clients with tight per-conversation tool budgets
	// can discover + call other handlers on demand. `full` surfaces
	// every registered handler — set MCP_TOOLSET=full when the client
	// has no per-tool cap and wants the auto-completion ergonomic of
	// every endpoint visible up front.
	switch envOr("MCP_TOOLSET", "minimal") {
	case "full":
		mcp.SetToolset(mcp.ToolsetFull)
	default:
		mcp.SetToolset(mcp.ToolsetMinimal)
	}

	// Inject the System User into ctx so dispatcher Run calls run as them.
	mcpCtx := auth.WithUser(ctx, user)

	mcpSrv := mcp.NewServer(srv, os.Stdin, os.Stdout)
	return mcpSrv.Run(mcpCtx)
}
