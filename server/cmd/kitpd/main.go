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
//	KITP_COMM_DEDUPE_DAYS        — days a message stays deduped after its last copy arrived; default 14
//	KITP_COMM_LOG_PRUNE_HOURS — comm_log prune cadence in hours; default 24
//	KITP_COMM_INBOUND_MAX_BYTES — POST mail intake body cap; default 50 MB
//	KITP_TOKEN_MAX_DAYS — longest a new API token may last, and its default; 0 = no limit; default 365
//	KITP_COMM_INBOUND_MAX_CONCURRENT — POSTed messages read and filed at once; default 4 (more answer 503)
//	KITP_TRUSTED_PROXIES      — private CIDRs whose X-Forwarded-For / PROXY
//	                            header is believed; default any private or
//	                            loopback peer (a public CIDR is refused)
//	KITP_SMTP_ADDR            — receive-only SMTP listener address (e.g.
//	                            ":2525"); off when unset
//	KITP_SMTP_DOMAIN          — the domain of route addresses
//	                            (<token>@domain); required with ADDR
//	KITP_SMTP_HOSTNAME        — the SMTP greeting name; default the domain
//	KITP_SMTP_TLS_CERT / _KEY — PEM files for STARTTLS (re-read on change)
//	KITP_SMTP_MAX_BYTES       — message size cap; default 40 MB
//	KITP_SMTP_ALLOW           — install-wide source CIDR allowlist
//	KITP_PUBLIC_URL           — external base URL of the install (e.g.
//	                            "https://kitp.example.com", no trailing
//	                            slash needed). When set, outbound mail to a
//	                            kitp user (a person linked to a login)
//	                            carries a "<base>/task/<id>" deep link in
//	                            the footer, and notification digests link
//	                            each task + the account page. Unset
//	                            disables the links. Its origin is also
//	                            trusted by the cross-origin (CSRF) check.
//	KITP_TRUSTED_ORIGINS      — more origins (comma-separated
//	                            scheme://host[:port]) the cross-origin check
//	                            admits besides the request's own Host. The
//	                            check refuses cross-origin browser POSTs on
//	                            cookie and public routes, in every
//	                            AUTH_MODE, CORS on or not.
//	KITP_CSP_REPORT_ONLY      — when "1", flips CSP to soft-launch mode
//	                            (Content-Security-Policy-Report-Only)
//	KITP_CSP_REPORT_URI       — when set, emits a report-uri directive
//	                            pointing browsers at this URL for CSP
//	                            violation reports
//	KITP_OIDC_TRUST_UNVERIFIED_EMAIL — which OIDC email claims link a
//	                            sign-in to an account or person kitp
//	                            has: unset, any the IdP doesn't mark
//	                            unverified; "0", only verified ones
//	                            (self-service IdPs, multi-tenant
//	                            Entra ID); "1", every one
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
	"crypto/rand"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"net/http"
	"net/url"
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
	domapproval "github.com/kitp/kitp/server/internal/dom/approval"
	domarea "github.com/kitp/kitp/server/internal/dom/area"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/attributedef"
	dombundle "github.com/kitp/kitp/server/internal/dom/bundle"
	"github.com/kitp/kitp/server/internal/dom/calendar"
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
	domlink "github.com/kitp/kitp/server/internal/dom/link"
	"github.com/kitp/kitp/server/internal/dom/mailin"
	"github.com/kitp/kitp/server/internal/dom/myscreen"
	"github.com/kitp/kitp/server/internal/dom/personemail"
	domportal "github.com/kitp/kitp/server/internal/dom/portal"
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
	"github.com/kitp/kitp/server/internal/dom/watch"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/netx"
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

// wantDemo reports whether to apply the opt-in demo seed section on startup.
// Demo is implied in dev so a zero-config `make run` on a fresh DB is useful,
// but an explicit KITP_DEMO_DATA always wins — so KITP_DEMO_DATA=0 (or empty)
// keeps a `db-reset-clean` database clean even in dev, and `make run` can
// re-apply the schema on every start without re-injecting demo fixtures.
func wantDemo(env string) bool {
	v, ok := os.LookupEnv("KITP_DEMO_DATA")
	if !ok {
		return env == "dev"
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "0", "false", "no", "off":
		return false
	default:
		return true
	}
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
func registerHandlers(pool *store.Pool, storage *cas.Storage, mailStatus *mailin.Status) {
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
	domlink.Register(pool)
	domapproval.Register(pool)
	projectstamp.Register(pool)
	dombundle.Register(pool)
	domportal.Register(domportal.Config{Pool: pool, Storage: storage})
	// Mail intake routes (comm_route.*) and the Mail intake page
	// (mail_intake.status); docs/MAIL_INTAKE_AND_CALENDARS.md.
	mailin.Register(pool, mailStatus)
	// Calendar feeds (calendar.*, calendar_url.*); the .ics route is
	// mounted in runHTTP.
	calendar.Register(pool)
	watch.Register(pool)
	myscreen.Register(pool)
	domarea.Register(pool)
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
	usertoken.SetMaxDays(int64(envInt("KITP_TOKEN_MAX_DAYS", usertoken.DefaultMaxDays)))
	rolemapping.Register(pool)
	// A person's email addresses (person_email.*) and the mail account that
	// sends their codes (account_mail.*); docs/EMAIL_ADDRESSES.md.
	personemail.Register(pool)
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
	if err := usertoken.CheckMaxDays(int64(envInt("KITP_TOKEN_MAX_DAYS", usertoken.DefaultMaxDays))); err != nil {
		return fmt.Errorf("refusing to start: %w", err)
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
		demo := wantDemo(env)
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
	// The chunked upload path (cas chunks + file.create) takes the same
	// per-file limit as the one-shot upload route.
	file.SetMaxBytes(maxAttachBytes)
	chunkMaxMB := envInt("ATTACHMENT_CHUNK_MAX_MB", 8)
	chunkMaxBytes := int64(chunkMaxMB) * 1024 * 1024
	// Operator-set workspace name shown in the web header + browser title.
	// Settable via KITP_WORKSPACE_TITLE (directly or through an env file /
	// compose / systemd EnvironmentFile); defaults to the neutral "Workspace"
	// so the old "kitp" brand is never shown.
	workspaceTitle := envOr("KITP_WORKSPACE_TITLE", "Workspace")
	// Where the header comms-bell navigates. Empty (the default) keeps the
	// project-aware fallback the client used before this knob landed: the
	// active project's `comms` screen if present, else /activity. Operators
	// who route comms triage somewhere else (e.g. a saved Grid view or an
	// embedded URL) set KITP_COMMS_BELL_URL to that path.
	commsBellURL := envOr("KITP_COMMS_BELL_URL", "")
	storage := cas.New(cas.NewPgBackend(pgPool))

	// Which proxies to believe about a client's address (X-Forwarded-For on
	// the POST intake routes, a PROXY header on the SMTP listener): any
	// private or loopback peer by default; KITP_TRUSTED_PROXIES narrows it
	// to private CIDRs of your choosing. A public CIDR is refused.
	trustedProxies, err := netx.ParseTrusted(os.Getenv("KITP_TRUSTED_PROXIES"))
	if err != nil {
		return err
	}
	mailStatus := mailin.NewStatus(trustedProxies)
	registerHandlers(pool, storage, mailStatus)

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
	crossOrigin, err := newCrossOriginProtection(env, mode)
	if err != nil {
		return err
	}
	apiRouter := api.NewRouter(api.RouterConfig{
		SessionResolver: newSessionResolver(sessionMgr, insecureCookie),
		BearerResolver:  newBearerResolver(tokenMgr),
		Logger:          logger,
		CrossOrigin:     crossOrigin,
	})

	// OIDC validator, built early (before the auth surface mounts) so the
	// logout handler can offer an RP-initiated end-session redirect — the
	// unified logout. nil in AUTH_MODE=off, where dev-login is the only
	// login path. Reused by the OIDC redirect dance mounted further below.
	var oidcValidator *oidc.Validator
	var oidcCfg *oidc.Config
	if mode == auth.ModeOIDC {
		oidcCfg = oidc.FromEnv(os.LookupEnv)
		if oidcCfg == nil {
			return errors.New("AUTH_MODE=oidc but OIDC_ISSUER is empty")
		}
		if _, err := oidc.ParseEmailTrust(os.Getenv("KITP_OIDC_TRUST_UNVERIFIED_EMAIL")); err != nil {
			return err
		}
		if oidcCfg.KitpRoles {
			// OIDC_ROLE_CLAIM=none: kitp manages roles. The roles earlier
			// sign-ins brought from the IdP become kitp's, so the switch
			// takes nobody's access away.
			n, err := oidc.AdoptIdPRoles(ctx, pgPool)
			if err != nil {
				return err
			}
			if n > 0 {
				slog.Default().LogAttrs(ctx, slog.LevelInfo, "OIDC_ROLE_CLAIM=none: roles from the identity provider are now managed in kitp",
					slog.Int64("grants", n))
			}
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
		DevLoginHosts:   configuredHosts(),
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
	//     download which streams the chunks back in order, plus the
	//     signed /dl + /upload routes MCP agents use (links minted by
	//     attachment.download_url / attachment.upload_url).
	//   - file.create / attachment.create / attachment.list /
	//     attachment.delete go through the JSON batch dispatcher (see
	//     registerHandlers).
	cas.Mount(apiRouter, cas.HTTPConfig{
		Pool:     pool,
		Storage:  storage,
		MaxBytes: chunkMaxBytes,
	})
	attachment.Mount(apiRouter, attachment.Config{
		Pool:           pool,
		Storage:        storage,
		Dispatcher:     srv,
		MaxUploadBytes: maxAttachBytes,
	})
	// Forge link hook (Bearer): a code forge (integrations/gerrit) links
	// one change URL to the tasks it mentions — POST /api/v1/links —
	// re-dispatching link.set as the token's actor, so role + scope checks
	// match a browser caller and repeats stay idempotent.
	domlink.Mount(apiRouter, domlink.HTTPConfig{Dispatcher: srv})
	// Portals: the signed-in preview route lives on the app's router; the
	// public, host-routed listener is a separate http.Server below
	// (KITP_PORTAL_ADDR) so a published site shares nothing with the app.
	portalSrv := &domportal.Server{Pool: pgPool, Storage: storage, Logger: logger}
	portalSrv.Mount(apiRouter)
	// Mail intake by POST: providers (a Cloudflare Email Worker, Mailgun,
	// Postmark, SES via Lambda, scripts) push the raw message to
	// /api/v1/comm/inbound/<token>; the token is the credential and is kept
	// out of logs. docs/MAIL_INTAKE_AND_CALENDARS.md §6.
	// Calendar feeds: GET /api/v1/calendar/<token>.ics — a person's tasks
	// due in a window, built on every fetch; the token stays out of logs.
	calendar.Mount(apiRouter, calendar.FeedConfig{
		Pool: pool, PublicURL: strings.TrimSpace(os.Getenv("KITP_PUBLIC_URL")), Logger: logger,
	})
	mailIntake := &comm.Intake{Pool: pool, Logger: logger}
	mailin.MountPOST(apiRouter, mailin.POSTConfig{
		Pool: pool, Intake: mailIntake, Trusted: trustedProxies, Status: mailStatus,
		MaxBytes:      int64(envInt("KITP_COMM_INBOUND_MAX_BYTES", mailin.DefaultPOSTMaxBytes)),
		MaxConcurrent: envInt("KITP_COMM_INBOUND_MAX_CONCURRENT", mailin.DefaultPOSTConcurrent),
		Logger:        logger,
	})
	portalBuilder := &domportal.Builder{Pool: pgPool, Storage: storage, Logger: logger}
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
	// DI-1 in docs/DESIGN_INVARIANTS.md for the
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
		CommsBellURL:       commsBellURL,
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
	// External base URL for task deep links in outbound mail to kitp users
	// (e.g. https://kitp.example.com). Empty disables the footer link.
	publicURL := strings.TrimSpace(os.Getenv("KITP_PUBLIC_URL"))
	// Secret for signing attachment links (attachment.download_url → the
	// public /api/v1/attachment/{id}/dl route; attachment.upload_url → the
	// public /api/v1/attachment/upload route). A configured
	// KITP_LINK_SECRET lets every instance behind a load balancer verify
	// each other's links and survives restarts; absent one, fall back to
	// an ephemeral per-process key (fine for single-instance dev — links
	// just stop working on restart / across instances).
	linkSecret := []byte(strings.TrimSpace(os.Getenv("KITP_LINK_SECRET")))
	if len(linkSecret) == 0 {
		linkSecret = make([]byte, 32)
		if _, err := rand.Read(linkSecret); err != nil {
			return fmt.Errorf("generate ephemeral attachment-link secret: %w", err)
		}
		logger.Warn("KITP_LINK_SECRET unset; using an ephemeral per-process key for attachment download links (links break on restart and across instances)")
	}
	attachment.SetLinkDeps(publicURL, linkSecret)
	smtpPool := comm.NewSMTPPool(pool, smtpTick, logger, publicURL)
	imapPool := comm.NewIMAPPool(pool, imapTick, logger)
	activityPool := activitysink.NewPool(pool, activityTick, logger, publicURL)

	// comm_log retention prune. Deletes comm_log rows older than the
	// configured retention window (default 30d). The cadence is set
	// by the job.Scheduler registration below; retention here is just
	// the age cutoff the SQL applies.
	retentionDays := envInt("KITP_COMM_LOG_RETENTION_DAYS", 30)
	pruneHours := envInt("KITP_COMM_LOG_PRUNE_HOURS", 24)
	pruneInterval := time.Duration(pruneHours) * time.Hour
	pruner := comm.NewLogPruner(pool, time.Duration(retentionDays)*24*time.Hour)
	pruner.SetDedupeRetention(time.Duration(envInt("KITP_COMM_DEDUPE_DAYS", 14)) * 24 * time.Hour)
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
			Name:        "oidc.state_reap",
			Description: "Delete expired sign-in state rows (abandoned or unfollowed sign-ins).",
			Interval:    10 * time.Minute,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return oidc.ReapState(ctx, pgPool)
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
			Name:        "portal.build",
			Description: "Render every portal whose published pages or settings changed into a static build and switch it live.",
			OnStartup:   true,
			Interval:    time.Duration(envInt("KITP_PORTAL_BUILD_TICK_SEC", 5)) * time.Second,
			Run: func(ctx context.Context, _ *pgxpool.Pool, _ struct{}) error {
				return portalBuilder.RunOnce(ctx)
			},
		},
		{
			Name:        "activitysink.pump",
			Description: "Deliver matching activity to each enabled sink and personal notification subscription: Teams channel posts and rolled-up email digests.",
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
			Trusted:        trustedProxies,
			StateKey:       linkSecret,
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
		// Idle keep-alive connections close; no Read/WriteTimeout here,
		// since uploads, exports and imports run long.
		IdleTimeout: 2 * time.Minute,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("kitpd listening on %s (env=%s auth=%s user=%q)", addr, env, mode, user.DisplayName)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	// Public portal listener: published sites, routed by Host header. Its
	// own server and handler — no /api, no session, no app CSP — so a
	// public site is domain-separated from the app by construction. Off
	// unless KITP_PORTAL_ADDR is set (portals still preview in the app).
	var portalHTTP *http.Server
	if portalAddr := os.Getenv("KITP_PORTAL_ADDR"); portalAddr != "" {
		var ph http.Handler = portalSrv.PublicHandler()
		if requestLog {
			ph = obs.LoggingMiddleware(logger, ph)
		}
		// Anyone can reach this listener: bound every phase of a request,
		// so slow or idle clients can't hold connections (and, through
		// them, server resources) open (review A4). WriteTimeout allows a
		// large published file over a slow link.
		portalHTTP = &http.Server{
			Addr:              portalAddr,
			Handler:           obs.RequestIDMiddleware(ph),
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       30 * time.Second,
			WriteTimeout:      5 * time.Minute,
			IdleTimeout:       2 * time.Minute,
		}
		go func() {
			log.Printf("portal listener on %s", portalAddr)
			if err := portalHTTP.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.Fatalf("portal listen: %v", err)
			}
		}()
	}

	// Receive-only SMTP listener (docs/MAIL_INTAKE_AND_CALENDARS.md §7): mail
	// to <route token>@KITP_SMTP_DOMAIN is filed on the route's mail
	// account; any other address is refused, so kitp never relays. Off
	// unless KITP_SMTP_ADDR is set. Put port 25 in front of it.
	var smtpSrv *mailin.SMTPServer
	if smtpAddr := os.Getenv("KITP_SMTP_ADDR"); smtpAddr != "" {
		var allow []string
		for _, a := range strings.FieldsFunc(os.Getenv("KITP_SMTP_ALLOW"), func(r rune) bool { return r == ',' || r == ' ' }) {
			allow = append(allow, a)
		}
		smtpSrv, err = mailin.NewSMTPServer(mailin.SMTPConfig{
			Addr: smtpAddr, Domain: os.Getenv("KITP_SMTP_DOMAIN"), Hostname: os.Getenv("KITP_SMTP_HOSTNAME"),
			CertFile: os.Getenv("KITP_SMTP_TLS_CERT"), KeyFile: os.Getenv("KITP_SMTP_TLS_KEY"),
			MaxBytes: int64(envInt("KITP_SMTP_MAX_BYTES", mailin.DefaultSMTPMaxBytes)), Allow: allow,
			Pool: pool, Intake: mailIntake, Trusted: trustedProxies, Status: mailStatus, Logger: logger,
		})
		if err != nil {
			return err
		}
		go func() {
			log.Printf("smtp listener on %s", smtpAddr)
			if err := smtpSrv.ListenAndServe(); err != nil {
				log.Fatalf("smtp listen: %v", err)
			}
		}()
	}

	<-stop
	log.Printf("shutting down")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer shutdownCancel()
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
	if portalHTTP != nil {
		if err := portalHTTP.Shutdown(shutdownCtx); err != nil {
			log.Printf("portal shutdown: %v", err)
		}
	}
	if smtpSrv != nil {
		if err := smtpSrv.Shutdown(shutdownCtx); err != nil {
			log.Printf("smtp shutdown: %v", err)
		}
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
	if err := usertoken.CheckMaxDays(int64(envInt("KITP_TOKEN_MAX_DAYS", usertoken.DefaultMaxDays))); err != nil {
		return fmt.Errorf("refusing to start: %w", err)
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
		demo := wantDemo(env)
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
	registerHandlers(pool, nil, nil)
	// attachment.download_url / upload_url mint links kitpd serves: they
	// verify there only with the server's own KITP_LINK_SECRET, so this
	// process signs with it when it is set; unset, minting answers
	// link_secret_unset rather than an internal error (review 2026-11-03
	// round 5).
	if secret := strings.TrimSpace(os.Getenv("KITP_LINK_SECRET")); secret != "" {
		attachment.SetLinkDeps(strings.TrimSpace(os.Getenv("KITP_PUBLIC_URL")), []byte(secret))
	}

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
	//
	// Running as System is now opt-in (KITP_MCP_AS_SYSTEM=1): an MCP
	// client started without KITP_TOKEN — a typo, a missing secret — got
	// every workspace-wide right without anyone choosing that (review
	// 2026-11-03 round 4). The process still needs the database's
	// credentials either way.
	actor := user
	tok := os.Getenv("KITP_TOKEN")
	if tok == "" && os.Getenv("KITP_MCP_AS_SYSTEM") != "1" {
		return errors.New("kitpd mcp: set KITP_TOKEN to an agent's token (or KITP_MCP_AS_SYSTEM=1 to run as the System user)")
	}
	if tok == "" {
		log.Printf("MCP running as the System user (KITP_MCP_AS_SYSTEM=1)")
	}
	if tok != "" {
		mgr := token.New(pgPool, token.Config{})
		// MCP subprocess mode is short-lived enough that we skip the
		// periodic touch-flush goroutine; last_used_at gets stamped
		// at Create / Revoke time anyway. The job.Scheduler is for
		// the long-running BFF process.
		resolved, err := mgr.Lookup(ctx, tok)
		if err != nil {
			return fmt.Errorf("KITP_TOKEN: %w", err)
		}
		// A scoped token (e.g. a forge's links-only token) is valid only
		// on its own HTTP route, never as a general MCP credential.
		if resolved.Scope != auth.TokenScopeFull {
			return fmt.Errorf("KITP_TOKEN: token is limited to %q and cannot drive MCP", resolved.Scope)
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
		return &auth.UserCtx{ID: u.ID, DisplayName: u.DisplayName, TokenScope: u.Scope}, nil
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

// configuredHosts are the host names of KITP_PUBLIC_URL and
// KITP_TRUSTED_ORIGINS (dev-login's other hosts; session.HTTPConfig).
func configuredHosts() []string {
	var out []string
	raw := append(strings.Split(os.Getenv("KITP_TRUSTED_ORIGINS"), ","), os.Getenv("KITP_PUBLIC_URL"))
	for _, o := range raw {
		if u, err := url.Parse(strings.TrimSpace(o)); err == nil && u.Hostname() != "" {
			out = append(out, u.Hostname())
		}
	}
	return out
}

// newCrossOriginProtection builds the router's CSRF check (api.RouterConfig
// CrossOrigin). KITP_PUBLIC_URL's origin is trusted besides the request's own
// Host, for a proxy that rewrites Host; KITP_TRUSTED_ORIGINS adds more
// (comma-separated scheme://host[:port]). Always on: it used to be off
// whenever the dev CORS middleware was — the default with ENV unset, so a
// binary run with real logins and no ENV had no check (review 2026-11-03
// round 4) — and then with AUTH_MODE=off, where every request acts as the
// System user, so the check is all that keeps a page on another site from
// POSTing to a kitpd on localhost (round 5). A dev app served from another
// origin is admitted through KITP_TRUSTED_ORIGINS.
func newCrossOriginProtection(env string, mode auth.Mode) (*http.CrossOriginProtection, error) {
	if api.CORSEnabled(env) {
		log.Printf("CORS is on (env=%s, AUTH_MODE=%s): the cross-origin check stays on; list a dev app's origin in KITP_TRUSTED_ORIGINS", env, mode)
	}
	c := http.NewCrossOriginProtection()
	// An IdP's back-channel logout is a server-to-server POST authenticated
	// by its signed logout token, not by a cookie (oidc/logout.go).
	c.AddInsecureBypassPattern("POST /api/v1/auth/oidc/backchannel-logout")
	origins := strings.Split(os.Getenv("KITP_TRUSTED_ORIGINS"), ",")
	if pub := strings.TrimSpace(os.Getenv("KITP_PUBLIC_URL")); pub != "" {
		u, err := url.Parse(pub)
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("KITP_PUBLIC_URL %q: want scheme://host", pub)
		}
		origins = append(origins, u.Scheme+"://"+u.Host)
	}
	for _, o := range origins {
		if o = strings.TrimSpace(o); o == "" {
			continue
		}
		if err := c.AddTrustedOrigin(o); err != nil {
			return nil, fmt.Errorf("trusted origin %q: %w", o, err)
		}
	}
	return c, nil
}
