// Command kitpd is the kitp server. By default it runs the HTTP API
// server on LISTEN_ADDR; the "mcp" subcommand runs the MCP JSON-RPC
// server over stdin/stdout (Phase 19).
//
// Configuration is environment-driven:
//
//	DATABASE_URL              — pgx connection string (required)
//	LISTEN_ADDR               — listen address, default ":8080"
//	AUTH_MODE                 — "off" (System User) or "oidc"; default "off"
//	ENV                       — "dev" or "production"; default "dev"
//	KITP_DEMO_DATA            — when set, apply the demo seed section on startup (dev default: on)
//	KITP_SKIP_SCHEMA          — when set, skip the declarative-schema apply at startup
//	LOG_LEVEL                 — debug|info|warn|error; default info (Phase 21)
//	PG_TRACE                  — non-empty enables pgx query tracing (dev) (Phase 21)
//	CORS                      — on|off override; default on in dev, off in production (Phase 22)
//	ATTACHMENT_MAX_MB         — whole-file upload cap in megabytes; default 250
//	ATTACHMENT_CHUNK_MAX_MB   — per-chunk cap on /api/v1/cas/chunk; default 8
//	CAS_REAPER_INTERVAL_SEC   — reaper sweep cadence in seconds; default 3600
//	CAS_REAPER_GRACE_SEC      — orphan grace period in seconds; default 3600
//	KITP_COMM_SMTP_TICK_SEC   — SMTP sender poll cadence in seconds; default 10
//	KITP_COMM_SMTP_DRY_RUN    — when "1", SMTP senders log instead of sending
//	KITP_COMM_IMAP_TICK_SEC   — IMAP poller cadence in seconds; default 60
//	KITP_COMM_IMAP_DRY_RUN    — when "1", IMAP pollers log instead of polling
//	KITP_COMM_IMAP_INSECURE   — when "1", allow plaintext IMAP (no TLS); dev only
//	KITP_COMM_LOG_RETENTION_DAYS — days to keep comm_log rows; default 30
//	KITP_COMM_LOG_PRUNE_HOURS — comm_log prune cadence in hours; default 24
//	KITP_CSP_REPORT_ONLY      — when "1", flips CSP to soft-launch mode
//	                            (Content-Security-Policy-Report-Only)
//	KITP_CSP_REPORT_URI       — when set, emits a report-uri directive
//	                            pointing browsers at this URL for CSP
//	                            violation reports
//	KITP_OIDC_TRUST_UNVERIFIED_EMAIL — when "1", disables the
//	                            `email_verified` gate on the OIDC
//	                            pre-created-account email fallback.
//	                            Leave OFF for self-service OPs; flip
//	                            ON for trusted corporate OPs that
//	                            verify emails out-of-band.
//	KITP_INIT_ADMIN_EMAIL     — when set AND the DB is in init mode
//	                            (no non-System admin exists), create a
//	                            user_account + person card with this
//	                            email and grant the admin role. OIDC
//	                            sign-in attaches the sub to that row
//	                            on first login. When unset and init
//	                            mode applies, the first OIDC user to
//	                            sign in self-elevates to admin.
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
	"strings"
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
	"github.com/kitp/kitp/server/internal/dom/activitysink"
	"github.com/kitp/kitp/server/internal/dom/agent"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/attributedef"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	domcas "github.com/kitp/kitp/server/internal/dom/cas"
	"github.com/kitp/kitp/server/internal/dom/comm"
	"github.com/kitp/kitp/server/internal/dom/comment"
	domconfig "github.com/kitp/kitp/server/internal/dom/config"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/file"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/dom/help"
	"github.com/kitp/kitp/server/internal/dom/proc"
	"github.com/kitp/kitp/server/internal/dom/process"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/dom/projectimport"
	"github.com/kitp/kitp/server/internal/dom/projectstamp"
	domrole "github.com/kitp/kitp/server/internal/dom/role"
	"github.com/kitp/kitp/server/internal/dom/rolemapping"
	domscheduler "github.com/kitp/kitp/server/internal/dom/scheduler"
	"github.com/kitp/kitp/server/internal/dom/tag"
	domuser "github.com/kitp/kitp/server/internal/dom/user"
	"github.com/kitp/kitp/server/internal/dom/usercardagent"
	"github.com/kitp/kitp/server/internal/dom/usercardsort"
	"github.com/kitp/kitp/server/internal/dom/userrole"
	"github.com/kitp/kitp/server/internal/dom/usertoken"
	"github.com/kitp/kitp/server/internal/job"
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
	activitysink.Register(pool)
	attachment.Register(pool)
	domcas.Register(pool)
	comm.Register(pool)
	comment.Register(pool)
	domconfig.Register()
	file.Register(pool)
	flow.Register(pool)
	help.Register()
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
//
// Pool-wide timeouts (S1, per DT direction):
//   - statement_timeout=600s  — hard cap on any single statement.
//     A handler that needs longer overrides per-call via
//     SET LOCAL statement_timeout inside its tx.
//   - lock_timeout=5s — bail rather than hang on a contended row.
//   - idle_in_transaction_session_timeout=60s — abort tx that's
//     been idle (e.g. handler crashed mid-tx without rollback).
func buildPgxPool(ctx context.Context, dsn string, logger *slog.Logger) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, err
	}
	if cfg.ConnConfig.RuntimeParams == nil {
		cfg.ConnConfig.RuntimeParams = map[string]string{}
	}
	cfg.ConnConfig.RuntimeParams["statement_timeout"] = "600000"
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
	cfg.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "60000"
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
	// Comm-channel passwords are encrypted with KITP_COMM_SECRET_KEY; in
	// dev store.CommSecretKey falls back to a published default. Shipping
	// that default to production would encrypt real credentials under a
	// key anyone can read (SEC-8 / A7). Refuse to start, mirroring the
	// AUTH_MODE=off refusal above.
	if err := store.RefuseStartIfNoCommSecretKey(env); err != nil {
		return err
	}

	logger := obs.NewLogger(envOr("LOG_LEVEL", "info"))
	// Per-request logging is OFF by default: one stdout line per /api/v1/batch
	// (+ the http access line at debug, + the per-subrequest debug line) is
	// rarely what ops want by default. KITP_REQUEST_LOG=1 turns the whole
	// per-request surface back on. Errors, the query tracer, auth-rejected,
	// and other non-request slog calls are unaffected.
	requestLog := os.Getenv("KITP_REQUEST_LOG") == "1"

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

	// Bootstrap a named admin from KITP_INIT_ADMIN_EMAIL when set.
	// No-op once any non-System admin exists, so this is safe to
	// run unconditionally on every startup.
	if email := strings.TrimSpace(os.Getenv("KITP_INIT_ADMIN_EMAIL")); email != "" {
		if err := auth.BootstrapInitAdmin(ctx, pgPool, email); err != nil {
			return fmt.Errorf("init admin bootstrap: %w", err)
		}
		log.Printf("init admin: ensured user_account for %s (admin role granted if no admin existed)", email)
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
	// Operator-set workspace name shown in the web header + browser title.
	// Settable via KITP_WORKSPACE_TITLE (directly or through an env file /
	// compose / systemd EnvironmentFile); defaults to the neutral "Workspace"
	// so the old "kitp" brand is never shown.
	workspaceTitle := envOr("KITP_WORKSPACE_TITLE", "Workspace")
	storage := cas.New(cas.NewPgBackend(pgPool))

	registerHandlers(pool, storage)

	srv := api.NewServer(pool)
	srv.Logger = logger
	srv.RequestLog = requestLog

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
	// (Periodic touch flush is registered on the job.Scheduler below.)
	// Cookie security: default Secure on; flip with KITP_INSECURE_COOKIE=1
	// for plain-http dev (Chrome refuses Secure cookies on http).
	insecureCookie := os.Getenv("KITP_INSECURE_COOKIE") == "1"

	// Bearer-token manager for the remote MCP transport. Built early
	// so the apiRouter's BearerResolver can close over it below.
	tokenMgr := token.New(pgPool, token.Config{})
	// (Periodic touch flush is registered on the job.Scheduler below.)

	// apiRouter — the typed sub-router that owns every /api/* route.
	// Two resolvers: session cookies for the browser SPA, bearer
	// tokens for MCP. Registering an Authed route without a session
	// resolver, or a Bearer route without a bearer resolver, panics
	// at startup so the misconfiguration trips early.
	apiRouter := api.NewRouter(api.RouterConfig{
		SessionResolver: newSessionResolver(sessionMgr, insecureCookie),
		BearerResolver:  newBearerResolver(tokenMgr),
		Logger:          logger,
	})

	// OIDC validator, built early (before the auth surface mounts) so the
	// logout handler can offer an RP-initiated end-session redirect — the
	// unified logout. nil in AUTH_MODE=off, where dev-login is the only
	// login path. Reused by the OIDC redirect dance mounted further below.
	var oidcValidator *oidc.Validator
	var oidcCfg *oidc.Config
	if mode == auth.ModeOIDC {
		oidcCfg = oidc.FromEnv(os.Getenv)
		if oidcCfg == nil {
			return errors.New("AUTH_MODE=oidc but OIDC_ISSUER is empty")
		}
		oidcValidator = oidc.NewValidator(oidcCfg, pgPool)
	}
	// EndSession hook for /auth/logout: fires only in OIDC mode, and only
	// redirects to the OP when discovery advertises an end_session_endpoint
	// (otherwise the logout stays local). Captures the post-logout redirect.
	var endSession session.EndSessionFunc
	if oidcValidator != nil {
		postLogout := oidcCfg.PostLogoutRedirectURI
		endSession = func(ctx context.Context) (string, bool, error) {
			return oidcValidator.EndSessionURL(ctx, postLogout)
		}
	}

	// Auth surface (login + me + logout + optional dev-impersonate).
	session.Mount(apiRouter, session.HTTPConfig{
		Manager:         sessionMgr,
		Pool:            pgPool,
		SystemUserID:    auth.SystemUserID,
		DevLoginEnabled: mode == auth.ModeOff,
		InsecureCookie:  insecureCookie,
		EndSession:      endSession,
	})

	// Remote MCP transport (Streamable HTTP). Same dispatcher as the
	// JSON batch endpoint — tools/call routes a one-element batch
	// through srv so per-handler authz hooks fire just like an HTTP
	// caller. Bearer-token authentication is owned by the router's
	// BearerResolver; the handler itself just reads the body and
	// dispatches.
	mcpHTTPSrv := mcp.NewServer(srv, nil, nil)
	mcp.Mount(apiRouter, mcp.HTTPConfig{Server: mcpHTTPSrv})

	// CAS chunked-upload + attachment download routes (Authed).
	//
	//   - The pg backend is the only configured backend in v1; future
	//     S3 / GCS backends prepend onto the chain.
	//   - cas.Mount installs POST /api/v1/cas/chunk for the per-chunk
	//     upload (cap = ATTACHMENT_CHUNK_MAX_MB).
	//   - attachment.Mount installs GET /api/v1/attachment/{id}/
	//     download which streams the chunks back in order.
	//   - file.create / attachment.create / attachment.list /
	//     attachment.delete go through the JSON batch dispatcher (see
	//     registerHandlers).
	cas.Mount(apiRouter, cas.HTTPConfig{
		Pool:     pool,
		Storage:  storage,
		MaxBytes: chunkMaxBytes,
	})
	attachment.Mount(apiRouter, attachment.Config{
		Pool:    pool,
		Storage: storage,
	})
	// Project export (phases 3 + 4 of PROJECT_PORTABILITY_PLAN.md) —
	// streams text/csv, .xlsx, or application/zip via dedicated HTTP
	// routes. Per-resource authz (caller must hold card.update on
	// the project) lives inline in each handler; the router's session
	// gate runs before the handler.
	projectexport.Mount(apiRouter, projectexport.Config{
		Pool:    pool,
		Storage: storage,
	})

	// Idempotency cache. Mounted as a decorator on the batch route
	// (NOT as outer middleware) so the cache key is partitioned by
	// the user the apiRouter has just resolved — see
	// issues/backend/01-critical-idempotency-cross-user.md for the
	// bug this avoids. The cleanup goroutine runs for the lifetime
	// of the process.
	idem := obs.NewIdempotencyStore(pgPool, logger)
	// (Cleanup is registered on the job.Scheduler below.)

	// JSON batch dispatcher. The session resolver attaches the user
	// to the context before HandleBatch runs, so the per-handler
	// AllowedRoles + role_grant checks see the authenticated actor.
	// The idem decorator scopes idempotency to /api/v1/batch only —
	// the auth dance / MCP / CAS upload routes don't need it (and
	// the old "wrap-the-entire-mux" path was caching their
	// responses too).
	srv.MountBatch(apiRouter, idem.WrapAuthed)

	// SPA + /healthz live on the top-level mux, outside /api/*. In OIDC
	// mode the SPA *document* is gated behind the session: an
	// unauthenticated app-shell request 302s to the SSO start endpoint
	// carrying the deep link as `redirect`. The gate is OFF in
	// AUTH_MODE=off so dev-login keeps working with no SSO host to
	// bounce to. Real static assets are never gated either way.
	srv.MountSPAGated(mux, webDir, api.SPAGateConfig{
		SessionResolver: newSessionResolver(sessionMgr, insecureCookie),
		Enabled:         mode == auth.ModeOIDC,
		LoginStartPath:  "/api/v1/auth/oidc/start",
	})
	mux.Handle("/api/", apiRouter.Mux())
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
		WorkspaceTitle:     workspaceTitle,
	})

	// CAS reaper. Sweeps at the configured cadence, dropping cas_blob
	// (and bytes via every backend) for orphans older than the grace
	// period. Scheduling is owned by the job.Scheduler below.
	reaper := &cas.Reaper{
		Pool:        pgPool,
		Storage:     storage,
		Interval:    time.Duration(envInt("CAS_REAPER_INTERVAL_SEC", 3600)) * time.Second,
		GracePeriod: time.Duration(envInt("CAS_REAPER_GRACE_SEC", 3600)) * time.Second,
		Logger:      logger,
	}

	// Comm-channel + activity-sink workers. Each is a reconciling pool:
	// one per-row worker (SMTP sender / IMAP poller / MS Graph pumper)
	// kept in sync with the live channel/sink set. They are driven by the
	// scheduler jobs declared below (comm.smtp_send / comm.imap_poll /
	// activitysink.pump) — a single ticker per protocol that sweeps every
	// channel each tick, NOT one goroutine per channel. A newly-added
	// channel is picked up on the next sweep (no restart); a disabled /
	// faulted channel's worker self-skips. The *_TICK_SEC envs set the
	// owning job's Interval.
	smtpTick := time.Duration(envInt("KITP_COMM_SMTP_TICK_SEC", 10)) * time.Second
	imapTick := time.Duration(envInt("KITP_COMM_IMAP_TICK_SEC", 60)) * time.Second
	activityTick := time.Duration(envInt("KITP_ACTIVITY_SINK_TICK_SEC", 30)) * time.Second
	smtpPool := comm.NewSMTPPool(pool, smtpTick, logger)
	imapPool := comm.NewIMAPPool(pool, imapTick, logger)
	activityPool := activitysink.NewMSGraphPool(pool, activityTick, logger)

	// comm_log retention prune. Deletes comm_log rows older than the
	// configured retention window (default 30d). The cadence is set
	// by the job.Scheduler registration below; retention here is just
	// the age cutoff the SQL applies.
	retentionDays := envInt("KITP_COMM_LOG_RETENTION_DAYS", 30)
	pruneHours := envInt("KITP_COMM_LOG_PRUNE_HOURS", 24)
	pruneInterval := time.Duration(pruneHours) * time.Hour
	pruner := comm.NewLogPruner(pool, time.Duration(retentionDays)*24*time.Hour)
	pruner.SetLogger(logger)

	// ----- background job scheduler -----
	// All periodic ticker work is declared here so the cadence, timeout,
	// and metrics live in one table — including the comm/activity-sink
	// sweeps, which drive their per-channel worker pools (constructed
	// above) from one ticker per protocol rather than a goroutine per row.
	sched := job.New[struct{}](pgPool, struct{}{}, logger)
	for _, j := range []job.Job[struct{}]{
		{
			Name:        "idempotency.cleanup",
			Description: "Purge expired idempotency keys from the in-memory store.",
			Interval:    10 * time.Minute,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return idem.Cleanup(ctx)
			},
		},
		{
			Name:        "cas.reaper",
			Description: "Reap abandoned CAS upload sessions and orphaned chunks.",
			OnStartup:   true, // catch abandoned uploads from a previous boot
			Interval:    reaper.Interval,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return reaper.RunOnce(ctx)
			},
		},
		{
			Name:        "session.touch",
			Description: "Flush buffered session last-seen timestamps to the DB.",
			Interval:    time.Duration(envInt("KITP_SESSION_TOUCH_SECONDS", 180)) * time.Second,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return sessionMgr.RunTouch(ctx)
			},
		},
		{
			Name:        "token.touch",
			Description: "Flush buffered API-token last-used timestamps to the DB.",
			Interval:    3 * time.Minute, // mirrors token.Config default
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return tokenMgr.RunTouch(ctx)
			},
		},
		{
			Name:        "comm.log_prune",
			Description: "Delete comm_log rows older than the retention window.",
			Interval:    pruneInterval,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				_, err := pruner.RunOnce(ctx)
				return err
			},
		},
		{
			Name:        "comm.imap_poll",
			Description: "Poll every enabled email channel's IMAP inbox and ingest new messages.",
			OnStartup:   true, // check mail immediately on boot, don't wait a full interval
			Interval:    imapTick,
			Timeout:     job.MaxDefaultTimeout, // a full sweep may dial several channels
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return imapPool.RunOnce(ctx)
			},
		},
		{
			Name:        "comm.smtp_send",
			Description: "Send pending outbound replies via each enabled channel's SMTP server.",
			OnStartup:   true,
			Interval:    smtpTick,
			Timeout:     job.MaxDefaultTimeout,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return smtpPool.RunOnce(ctx)
			},
		},
		{
			Name:        "activitysink.pump",
			Description: "Push matching activity rows to each enabled sink's external destination.",
			OnStartup:   true,
			Interval:    activityTick,
			Timeout:     job.MaxDefaultTimeout,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return activityPool.RunOnce(ctx)
			},
		},
	} {
		if err := sched.Add(j); err != nil {
			return fmt.Errorf("scheduler: %w", err)
		}
	}
	sched.Start(ctx)
	// Expose the live scheduler to the admin scheduler.list / scheduler.run
	// handlers (the workspace Jobs screen). Registered here, not in
	// registerHandlers, so the MCP entrypoint (no scheduler) doesn't carry
	// dead handlers. Must precede the server accepting requests below.
	domscheduler.Register(pool, sched)
	log.Printf("started job scheduler with %d job(s) (comm_log retention=%dd, prune=%dh)",
		len(sched.Metrics()), retentionDays, pruneHours)

	// OIDC mode: register the redirect dance on the apiRouter as
	// Public routes (browsers are mid-redirect with no cookie yet).
	// In AUTH_MODE=off mode the routes are simply not registered —
	// dev-login on the session surface is the only login path. Reuses the
	// validator built above (which also backs the unified-logout hook).
	if mode == auth.ModeOIDC {
		bffCfg := oidc.BFFConfig{
			Validator:      oidcValidator,
			Pool:           pgPool,
			SessionManager: sessionMgr,
			InsecureCookie: insecureCookie,
		}
		if err := bffCfg.Validate(); err != nil {
			return fmt.Errorf("oidc/bff: %w", err)
		}
		oidc.Mount(apiRouter, bffCfg)
		log.Printf("OIDC enabled (issuer=%s aud=%s redirect_uri=%s)",
			oidcCfg.Issuer, oidcCfg.Audience, oidcCfg.RedirectURI)
	}

	// Outer middleware chain from outermost in:
	//   CORS → request id → logging → CSP → mux
	//
	// Auth no longer lives in the chain — the apiRouter resolves the
	// session cookie (or bearer token) per route and 401s when needed.
	// Idempotency is now a per-handler decorator on the batch route
	// (applied above via srv.MountBatch) rather than an outer
	// middleware, so the cache key is partitioned by the resolved
	// user. The previous "wrap-the-entire-mux" placement collapsed
	// every request to SystemUserID because the resolver hadn't run
	// yet.
	//
	// CSP is set unconditionally on every response (SPA HTML, static
	// assets, /api/ JSON, /healthz). Defence-in-depth — see
	// internal/api/csp.go for the policy. KITP_CSP_REPORT_ONLY=1
	// switches to a soft-launch posture; KITP_CSP_REPORT_URI=… emits
	// a report-uri directive.
	cspMW := api.CSP(api.CSPConfig{
		ReportOnly: os.Getenv("KITP_CSP_REPORT_ONLY") == "1",
		Reporter:   os.Getenv("KITP_CSP_REPORT_URI"),
	})
	// The per-request http access line lives in LoggingMiddleware; only mount
	// it when request logging is on, so the default chain is RequestID → CSP →
	// mux (RequestID is kept regardless so the X-Request-ID header still flows
	// — it's a header propagation step, not a log line).
	var chain http.Handler = cspMW(mux)
	if requestLog {
		chain = obs.LoggingMiddleware(logger, chain)
	}
	var inner http.Handler = obs.RequestIDMiddleware(chain)
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
	// Job scheduler: cancel the root ctx so every job goroutine sees
	// parent.Done() and exits — including the comm/activity-sink sweep
	// jobs, whose worker pools hold no connections between ticks, so
	// there's nothing else to drain. Without this Wait() blocks forever:
	// httpSrv.Shutdown only bounds its own draining, it doesn't propagate
	// cancellation back to the parent.
	cancel()
	sched.Wait()
	flushCtx, flushCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer flushCancel()
	if err := sessionMgr.Flush(flushCtx); err != nil {
		log.Printf("session flush: %v", err)
	}
	if err := tokenMgr.Flush(flushCtx); err != nil {
		log.Printf("token flush: %v", err)
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
	// MCP shares the same KITP_REQUEST_LOG=1 toggle as the HTTP server, so
	// `kitpd mcp` and `kitpd serve` agree on whether per-call lines emit.
	srv.RequestLog = os.Getenv("KITP_REQUEST_LOG") == "1"

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
		// MCP subprocess mode is short-lived enough that we skip the
		// periodic touch-flush goroutine; last_used_at gets stamped
		// at Create / Revoke time anyway. The job.Scheduler is for
		// the long-running BFF process.
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

// newSessionResolver returns the api.Router SessionResolver closure
// for browser SPA requests. Reads the kitp_session cookie via the
// session package's Read helper, looks the id up via the Manager,
// and clears a bad cookie so the browser stops sending the dead
// value on every request.
//
// Returning (nil, nil) means "no credential present" — the router
// renders that as a 401 with `unauthenticated`.
func newSessionResolver(mgr *session.Manager, insecureCookie bool) api.Resolver {
	return func(r *http.Request) (*auth.UserCtx, error) {
		id := session.Read(r)
		if id == "" {
			return nil, nil
		}
		u, err := mgr.Lookup(r.Context(), id)
		if err != nil {
			// Resolver runs before the handler so we can't clear
			// the bad cookie from here. The router logs the cause
			// and renders 401; the previous Middleware-based path
			// did clear the cookie, but reading-then-clearing on
			// every 401 wasn't actually catching anything user-
			// visible (the SPA's auth probe re-derives state
			// either way). If the dead-cookie storm becomes
			// noticeable, plumb a clearing hook through Router.
			_ = insecureCookie
			return nil, err
		}
		return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName}, nil
	}
}

// newBearerResolver returns the api.Router BearerResolver closure
// for MCP requests. Extracts the bearer credential from the
// Authorization header and resolves it via the token Manager.
//
// The MCP spec calls for a Bearer realm on 401 responses; the router
// emits a plain JSON 401 today (matching the rest of the API surface)
// and the MCP client treats either form as auth failure. If we want
// to add a WWW-Authenticate header, the router would need a hook —
// not worth the complexity for one route.
func newBearerResolver(mgr *token.Manager) api.Resolver {
	return func(r *http.Request) (*auth.UserCtx, error) {
		tok := extractBearer(r.Header.Get("Authorization"))
		if tok == "" {
			return nil, nil
		}
		u, err := mgr.Lookup(r.Context(), tok)
		if err != nil {
			return nil, err
		}
		return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName}, nil
	}
}

// extractBearer pulls the bearer credential out of an Authorization
// header. Returns "" when the scheme is missing, wrong, or the value
// is empty. Comparison is case-insensitive per RFC 7235.
func extractBearer(header string) string {
	if header == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(header) <= len(prefix) {
		return ""
	}
	if !strings.EqualFold(header[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(header[len(prefix):])
}
