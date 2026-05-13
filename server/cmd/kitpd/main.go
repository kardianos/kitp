// Command kitpd is the kitp server. By default it runs the HTTP API
// server on LISTEN_ADDR; the "mcp" subcommand runs the MCP JSON-RPC
// server over stdin/stdout (Phase 19).
//
// Configuration is environment-driven:
//   DATABASE_URL              — pgx connection string (required)
//   LISTEN_ADDR               — listen address, default ":8080"
//   AUTH_MODE                 — "off" (System User) or "oidc"; default "off"
//   ENV                       — "dev" or "production"; default "dev"
//   KITP_DEMO_DATA            — when set, apply the demo seed section on startup (dev default: on)
//   KITP_SKIP_SCHEMA          — when set, skip the declarative-schema apply at startup
//   LOG_LEVEL                 — debug|info|warn|error; default info (Phase 21)
//   PG_TRACE                  — non-empty enables pgx query tracing (dev) (Phase 21)
//   CORS                      — on|off override; default on in dev, off in production (Phase 22)
//   ATTACHMENT_MAX_MB         — whole-file upload cap in megabytes; default 250
//   ATTACHMENT_CHUNK_MAX_MB   — per-chunk cap on /api/v1/cas/chunk; default 8
//   CAS_REAPER_INTERVAL_SEC   — reaper sweep cadence in seconds; default 3600
//   CAS_REAPER_GRACE_SEC      — orphan grace period in seconds; default 3600
//   KITP_COMM_SMTP_TICK_SEC   — SMTP sender poll cadence in seconds; default 10
//   KITP_COMM_SMTP_DRY_RUN    — when "1", SMTP senders log instead of sending
//   KITP_COMM_IMAP_TICK_SEC   — IMAP poller cadence in seconds; default 60
//   KITP_COMM_IMAP_DRY_RUN    — when "1", IMAP pollers log instead of polling
//   KITP_COMM_IMAP_INSECURE   — when "1", allow plaintext IMAP (no TLS); dev only
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
	"strconv"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/auth/token"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/agent"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/attributedef"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
	domconfig "github.com/kitp/kitp/server/internal/dom/config"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/dom/process"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
	"github.com/kitp/kitp/server/internal/dom/projectstamp"
	domrole "github.com/kitp/kitp/server/internal/dom/role"
	"github.com/kitp/kitp/server/internal/dom/rolemapping"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/dom/proc"
	domuser "github.com/kitp/kitp/server/internal/dom/user"
	"github.com/kitp/kitp/server/internal/dom/usercardagent"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/dom/userrole"
	"github.com/kitp/kitp/server/internal/dom/usertoken"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/obs"
	"github.com/kitp/kitp/server/internal/schema/hcsv"
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
//
// `storage` may be nil for entrypoints that don't carry a CAS backend
// (e.g. the MCP CLI subcommand). Handlers that need it (project.import
// is the only one today) are skipped when nil.
func registerHandlers(pool *store.Pool, storage *cas.Storage) {
	echo.Register()
	cardtype.Register()
	card.Register(pool)
	attribute.Register(pool)
	attributedef.Register(pool)
	activity.Register(pool)
	attachment.Register(pool)
	domcas.Register(pool)
	comm.Register(pool)
	comment.Register(pool)
	domconfig.Register()
	file.Register(pool)
	flow.Register(pool)
	projectstamp.Register(pool)
	tag.Register(pool)
	process.Register(pool)
	proc.Register(pool)
	domuser.Register()
	usercardsort.Register(pool)
	usercardagent.Register(pool)
	domrole.Register()
	userrole.Register(pool)
	agent.Register(pool)
	usertoken.Register(pool)
	rolemapping.Register(pool)
	if storage != nil {
		projectimport.Register(projectimport.ImportConfig{Pool: pool, Storage: storage})
	}
}

// buildPgxPool constructs a pgxpool.Pool from dsn, optionally installing
// the obs.QueryTracer when LOG_LEVEL=debug or PG_TRACE=1. Every new
// connection is bound to the resolved KITP_COMM_SECRET_KEY so the
// comm package's sym_encrypt/sym_decrypt SQL references via
// current_setting('app.comm_secret_key') resolve correctly.
func buildPgxPool(ctx context.Context, dsn string, logger *slog.Logger) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if obs.PGTraceEnabled() {
		cfg.ConnConfig.Tracer = &obs.QueryTracer{Logger: logger}
	}
	key := store.CommSecretKey()
	cfg.AfterConnect = func(ctx context.Context, c *pgx.Conn) error {
		_, err := c.Exec(ctx, "SELECT set_config('app.comm_secret_key', $1, false)", key)
		return err
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

	if os.Getenv("KITP_SKIP_SCHEMA") == "" {
		demo := os.Getenv("KITP_DEMO_DATA") != "" || env == "dev"
		if err := store.ApplySchema(ctx, pgPool, hcsv.GenerateOptions{Demo: demo}); err != nil {
			return fmt.Errorf("apply schema: %w", err)
		}
	}

	if os.Getenv("MIGRATE_ONLY") != "" {
		log.Printf("MIGRATE_ONLY set; schema applied, exiting")
		return nil
	}

	user, err := auth.NewSystemUser(ctx, pgPool, env, mode)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	pool := store.NewPool(pgPool)

	// CAS storage is built before handler registration so the
	// project.import handlers (which read CSV bytes from CAS) wire
	// straight to the same backend chain the upload + download routes
	// use further down.
	maxAttachMB := envInt("ATTACHMENT_MAX_MB", 250)
	maxAttachBytes := int64(maxAttachMB) * 1024 * 1024
	chunkMaxMB := envInt("ATTACHMENT_CHUNK_MAX_MB", 8)
	chunkMaxBytes := int64(chunkMaxMB) * 1024 * 1024
	storage := cas.New(cas.NewPgBackend(pgPool))

	registerHandlers(pool, storage)

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

	// Session manager — owns the BFF cookie + batched sliding-touch.
	// IdleTTL: how long a cookie can sit unused before re-auth. Default
	// 7d; tune via KITP_SESSION_IDLE_HOURS. AbsoluteCap: hard re-auth
	// cap measured from the original login. Default 45d; tune via
	// KITP_SESSION_ABSOLUTE_DAYS. TouchInterval: how often we flush
	// last_seen_at; smaller = fresher idle gate at higher DB churn.
	sessionMgr := session.New(pgPool, session.Config{
		IdleTTL:       time.Duration(envInt("KITP_SESSION_IDLE_HOURS", 24*7)) * time.Hour,
		AbsoluteCap:   time.Duration(envInt("KITP_SESSION_ABSOLUTE_DAYS", 45)) * 24 * time.Hour,
		TouchInterval: time.Duration(envInt("KITP_SESSION_TOUCH_SECONDS", 180)) * time.Second,
	})
	sessionMgr.Start(ctx)
	// Cookie security: default Secure on; flip with KITP_INSECURE_COOKIE=1
	// for plain-http dev (Chrome refuses Secure cookies on http).
	insecureCookie := os.Getenv("KITP_INSECURE_COOKIE") == "1"

	// Mount the auth surface BEFORE srv.Mount so the dispatcher's
	// "POST /api/v1/batch" registration coexists; the AuthRequired
	// wrapper below gates that batch route.
	session.RegisterHTTP(mux, session.HTTPConfig{
		Manager:         sessionMgr,
		Pool:            pgPool,
		SystemUserID:    auth.SystemUserID,
		DevLoginEnabled: mode == auth.ModeOff,
		InsecureCookie:  insecureCookie,
	})

	srv.Mount(mux, webDir)

	// Remote MCP transport (Streamable HTTP). Same dispatcher as the
	// JSON batch endpoint — tools/call routes a one-element batch
	// through srv so per-handler authz hooks fire just like an HTTP
	// caller. Authentication is via Authorization: Bearer <user_token>;
	// the session.GateAPI exempt list (below) skips the cookie gate so
	// the bearer-only path is reachable.
	tokenMgr := token.New(pgPool, token.Config{})
	tokenMgr.Start(ctx)
	mcpHTTPSrv := mcp.NewServer(srv, nil, nil)
	mcp.RegisterHTTP(mux, mcp.HTTPConfig{
		Server: mcpHTTPSrv,
		Tokens: tokenMgr,
		Logger: logger,
	})

	// CAS chunked-upload + attachment download routes.
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
	// Project export (phases 3 + 4 of PROJECT_PORTABILITY_PLAN.md) —
	// streams text/csv or application/zip via dedicated HTTP routes.
	// Authz is checked inline against the dispatcher's role /
	// role_grant tables. The full-zip endpoint reads attachment bytes
	// from CAS when the include_attachments toggle is on.
	projectexport.RegisterHTTP(mux, projectexport.Config{
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

	// SMTP senders. One goroutine per configured comm_channel card;
	// each polls for pending reply_body rows and ships them via SMTP.
	// Adding a new channel currently requires a kitpd restart — auto-
	// detect is a follow-up gate (email_comm_spec.md §"SMTP sender").
	// In dev / test environments without comm channels this returns
	// an empty slice; the call is a no-op.
	smtpTick := time.Duration(envInt("KITP_COMM_SMTP_TICK_SEC", 10)) * time.Second
	smtpSenders, err := comm.StartSMTPSenderPool(ctx, pool, smtpTick, logger)
	if err != nil {
		return fmt.Errorf("smtp senders: %w", err)
	}
	if len(smtpSenders) > 0 {
		log.Printf("started %d SMTP sender(s) (tick=%s, dry_run=%s)",
			len(smtpSenders), smtpTick, envOr("KITP_COMM_SMTP_DRY_RUN", "0"))
	}

	// IMAP pollers. Mirror of the SMTP pool: one goroutine per
	// configured comm_channel card, fetching unseen messages on each
	// tick and routing via the three-tier threading lookup (header /
	// subject suffix / body trailer). Adding a new channel currently
	// requires a kitpd restart — auto-detect is a follow-up gate
	// (email_comm_spec.md §"IMAP poller").
	imapTick := time.Duration(envInt("KITP_COMM_IMAP_TICK_SEC", 60)) * time.Second
	imapPollers, err := comm.StartIMAPPollerPool(ctx, pool, imapTick, logger)
	if err != nil {
		return fmt.Errorf("imap pollers: %w", err)
	}
	if len(imapPollers) > 0 {
		log.Printf("started %d IMAP poller(s) (tick=%s, dry_run=%s, insecure=%s)",
			len(imapPollers), imapTick,
			envOr("KITP_COMM_IMAP_DRY_RUN", "0"),
			envOr("KITP_COMM_IMAP_INSECURE", "0"))
	}

	idem := obs.NewIdempotencyStore(pgPool, logger)
	idem.StartCleanup(ctx)

	// Wrap order from outermost in: CORS -> request id -> logging ->
	// idempotency -> auth (System User OR OIDC) -> dispatcher. CORS lives at
	// the outer layer so OPTIONS preflights short-circuit before doing any
	// real work; the rest of the chain still executes for POSTs.
	// BFF middleware chain:
	//   session.Middleware  → attach UserCtx if cookie is valid (no 401)
	//   session.GateAPI    → 401 for /api/* except the auth surface
	//
	// OIDC mode previously short-circuited to oidc.Middleware (bearer
	// header only); that path is gone now that the OIDC dance is
	// driven server-side and lands in a session cookie. The legacy
	// auth.Middleware (auto-System-User) is also gone — in BFF mode
	// nothing implicitly attaches a user, the only path in is the
	// session cookie.
	if mode == auth.ModeOIDC {
		oidcCfg := oidc.FromEnv(os.Getenv)
		if oidcCfg == nil {
			return errors.New("AUTH_MODE=oidc but OIDC_ISSUER is empty")
		}
		validator := oidc.NewValidator(oidcCfg, pgPool)
		if err := oidc.RegisterBFF(mux, oidc.BFFConfig{
			Validator:      validator,
			Pool:           pgPool,
			SessionManager: sessionMgr,
			InsecureCookie: insecureCookie,
		}); err != nil {
			return fmt.Errorf("oidc/bff: %w", err)
		}
		log.Printf("OIDC enabled (issuer=%s aud=%s redirect_uri=%s)",
			oidcCfg.Issuer, oidcCfg.Audience, oidcCfg.RedirectURI)
	}
	authMW := session.Middleware(sessionMgr)
	gateMW := session.GateAPI(session.GateConfig{
		Prefix: "/api/",
		Exempt: []string{
			"/api/v1/auth/dev-login",
			"/api/v1/auth/logout",
			"/api/v1/auth/oidc/start",
			"/api/v1/auth/oidc/callback",
			// Remote MCP uses bearer-token auth instead of the BFF
			// session cookie — skip the cookie gate so a token-bearing
			// MCP client reaches the handler.
			"/api/v1/mcp",
		},
	})
	var inner http.Handler = obs.RequestIDMiddleware(
		obs.LoggingMiddleware(logger,
			idem.Middleware(srv,
				authMW(gateMW(mux)),
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
	for _, sender := range smtpSenders {
		sender.Stop()
	}
	for _, poller := range imapPollers {
		poller.Stop()
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

	if os.Getenv("KITP_SKIP_SCHEMA") == "" {
		demo := os.Getenv("KITP_DEMO_DATA") != "" || env == "dev"
		if err := store.ApplySchema(ctx, pgPool, hcsv.GenerateOptions{Demo: demo}); err != nil {
			return fmt.Errorf("apply schema: %w", err)
		}
	}

	user, err := auth.NewSystemUser(ctx, pgPool, env, mode)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}

	pool := store.NewPool(pgPool)
	// MCP entrypoint runs handlers but has no CAS-backed routes, so
	// skip handlers that need storage (only project.import today).
	registerHandlers(pool, nil)

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

	// Resolve the acting user. By default the MCP entry runs as the
	// System User (back-compat: nothing changed for callers that don't
	// set KITP_TOKEN). When KITP_TOKEN is non-empty, look it up via
	// the user_token table and switch the actor to whatever user_account
	// the token names — typically one of the parent user's agents.
	// Bad / revoked / expired token fails fast so a misconfigured agent
	// doesn't accidentally run as System.
	actor := user
	if tok := os.Getenv("KITP_TOKEN"); tok != "" {
		mgr := token.New(pgPool, token.Config{})
		mgr.Start(ctx) // batched touch on token usage
		resolved, err := mgr.Lookup(ctx, tok)
		if err != nil {
			return fmt.Errorf("KITP_TOKEN: %w", err)
		}
		actor = &auth.UserCtx{ID: resolved.ID, DisplayName: resolved.DisplayName}
		log.Printf("MCP authenticated as user_account.id=%d (%q) via KITP_TOKEN", actor.ID, actor.DisplayName)
	}

	mcpCtx := auth.WithUser(ctx, actor)

	mcpSrv := mcp.NewServer(srv, os.Stdin, os.Stdout)
	return mcpSrv.Run(mcpCtx)
}
