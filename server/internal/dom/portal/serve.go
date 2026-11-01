package portal

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/named"
)

// publicCSP locks a published page down to its own stylesheet and images:
// the builder emits no script, so none may run, and nothing may frame it.
const publicCSP = "default-src 'none'; style-src 'self'; img-src 'self' https: data:; " +
	"base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

// previewCSP adds `sandbox` for the signed-in preview, which is served
// from the APP's origin: the sandbox gives the page an opaque origin, so
// even a page that somehow carried script could not read the session
// cookie or call /api on the user's behalf.
const previewCSP = "sandbox; " + publicCSP

// Server serves portal builds: the public, host-routed listener
// (KITP_PORTAL_ADDR) and the signed-in preview route on the app.
type Server struct {
	Pool    *pgxpool.Pool
	Storage *cas.Storage
	Logger  *slog.Logger
}

func (s *Server) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// PublicHandler serves every public portal on its own host name. It is
// meant for a SEPARATE listener (KITP_PORTAL_ADDR) — it mounts no /api,
// reads no session cookie, and answers only for hosts a public portal
// claims (portal_host, portal_public=true); any other host is a 404. A
// portal that isn't public is never served here, whatever its host:
// that's how a QA portal stays internal (preview only).
func (s *Server) PublicHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		host := strings.ToLower(r.Host)
		if h, _, err := net.SplitHostPort(host); err == nil {
			host = h
		}
		build, err := s.publicBuild(r.Context(), host)
		if err != nil {
			s.logger().Warn("portal: resolve host", "host", host, "err", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		if build == 0 {
			http.NotFound(w, r)
			return
		}
		s.serve(w, r, build, strings.TrimPrefix(r.URL.Path, "/"), "/", publicCSP)
	})
}

// Mount registers the preview route on the app's router:
//
//	GET /api/v1/portal/{id}/preview/{path...}
//
// It serves the portal's active build to a signed-in user who can see the
// portal's root page (any portal, public or not — this is how QA is
// reviewed), under a sandboxing CSP. Links in a build are relative, so the
// site works unchanged below the prefix.
func (s *Server) Mount(rt *api.Router) {
	rt.Authed("GET /api/v1/portal/{id}/preview", func(_ context.Context, w http.ResponseWriter, r *http.Request, _ *auth.UserCtx) error {
		http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
		return nil
	})
	rt.Authed("GET /api/v1/portal/{id}/preview/{path...}", func(ctx context.Context, w http.ResponseWriter, r *http.Request, user *auth.UserCtx) error {
		id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
		if err != nil || id <= 0 {
			return api.NotFound("portal not found")
		}
		build, err := s.previewBuild(ctx, id, user.ID)
		if err != nil {
			return api.Internal(fmt.Errorf("portal preview %d: %w", id, err))
		}
		if build == 0 {
			return api.NotFound("portal not found or not built yet")
		}
		prefix := "/api/v1/portal/" + strconv.FormatInt(id, 10) + "/preview/"
		s.serve(w, r, build, r.PathValue("path"), prefix, previewCSP)
		return nil
	})
}

// publicBuild resolves a host to its public portal's active build (0 when
// no public portal claims the host, or it has never been built).
func (s *Server) publicBuild(ctx context.Context, host string) (int64, error) {
	if host == "" {
		return 0, nil
	}
	q := named.New()
	q.Set("host", host)
	sql, args, err := q.Compile(`
		SELECT COALESCE(ps.active_build_id, 0)
		FROM card p
		JOIN card_type ct ON ct.id = p.card_type_id AND ct.name = 'portal'
		JOIN attribute_value hv ON hv.card_id = p.id
		JOIN attribute_def hd ON hd.id = hv.attribute_def_id AND hd.name = 'portal_host'
		JOIN attribute_value pv ON pv.card_id = p.id
		JOIN attribute_def pd ON pd.id = pv.attribute_def_id AND pd.name = 'portal_public'
		JOIN portal_state ps ON ps.portal_id = p.id
		WHERE p.deleted_at IS NULL
		  AND hv.value = to_jsonb(:host::text)
		  AND pv.value = to_jsonb(true)
		LIMIT 1`)
	if err != nil {
		return 0, fmt.Errorf("compile: %w", err)
	}
	var build int64
	if err := s.Pool.QueryRow(ctx, sql, args...).Scan(&build); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return build, nil
}

// previewBuild resolves a portal id to its active build for a user who may
// preview it: a global-role user, or one who can see the root page.
func (s *Server) previewBuild(ctx context.Context, portalID, userID int64) (int64, error) {
	q := named.New()
	q.Set("portal", portalID)
	q.Set("user", userID)
	sql, args, err := q.Compile(`
		SELECT COALESCE(ps.active_build_id, 0)
		FROM card p
		JOIN card_type ct ON ct.id = p.card_type_id AND ct.name = 'portal'
		JOIN portal_state ps ON ps.portal_id = p.id
		LEFT JOIN LATERAL (
			SELECT CASE
			         WHEN jsonb_typeof(av.value) = 'number' THEN (av.value)::text::bigint
			         WHEN (av.value #>> '{}') ~ '^\d+$' THEN (av.value #>> '{}')::bigint
			       END AS root
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'portal_root'
			WHERE av.card_id = p.id
		) r ON true
		WHERE p.id = :portal AND p.deleted_at IS NULL
		  AND (card_visible_to(:user, COALESCE(r.root, 0))
		       OR EXISTS (
		         SELECT 1 FROM user_account caller
		         JOIN user_role ur
		           ON ur.user_id = caller.id
		           OR (caller.parent_user_id IS NOT NULL AND ur.user_id = caller.parent_user_id)
		         WHERE caller.id = :user AND ur.scope_card_id IS NULL))`)
	if err != nil {
		return 0, fmt.Errorf("compile: %w", err)
	}
	var build int64
	if err := s.Pool.QueryRow(ctx, sql, args...).Scan(&build); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return build, nil
}

type buildFile struct {
	addr string
	mime string
	size int64
}

func (s *Server) lookup(ctx context.Context, build int64, p string) (buildFile, bool, error) {
	q := named.New()
	q.Set("build", build)
	q.Set("path", p)
	sql, args, err := q.Compile(`
		SELECT cas_address, mime_type, size_bytes
		FROM portal_build_file WHERE build_id = :build AND path = :path`)
	if err != nil {
		return buildFile{}, false, fmt.Errorf("compile: %w", err)
	}
	var f buildFile
	if err := s.Pool.QueryRow(ctx, sql, args...).Scan(&f.addr, &f.mime, &f.size); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return buildFile{}, false, nil
		}
		return buildFile{}, false, err
	}
	return f, true, nil
}

// serve answers one request against a build. rel is the request path
// below the site root (no leading slash); prefix is the site root's URL
// path ("/" publicly, the preview prefix in the app).
//
//   - "" or ".../" serves that directory's index.html;
//   - an exact file path serves the file;
//   - a page path without its trailing slash redirects to it, so the
//     page's relative links resolve against the right directory;
//   - anything else is the build's 404 page, status 404.
func (s *Server) serve(w http.ResponseWriter, r *http.Request, build int64, rel, prefix, csp string) {
	ctx := r.Context()
	clean := strings.TrimPrefix(path.Clean("/"+rel), "/")
	if clean == "." {
		clean = ""
	}
	dir := rel == "" || strings.HasSuffix(rel, "/")
	want := clean
	if dir {
		if clean == "" {
			want = "index.html"
		} else {
			want = clean + "/index.html"
		}
	}
	f, ok, err := s.lookup(ctx, build, want)
	if err != nil {
		s.fail(w, err)
		return
	}
	if !ok && !dir && clean != "" {
		if _, isPage, err := s.lookup(ctx, build, clean+"/index.html"); err != nil {
			s.fail(w, err)
			return
		} else if isPage {
			target := prefix + clean + "/"
			if r.URL.RawQuery != "" {
				target += "?" + r.URL.RawQuery
			}
			http.Redirect(w, r, target, http.StatusMovedPermanently)
			return
		}
	}
	h := w.Header()
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
	if !ok {
		s.serve404(w, r, build, clean, prefix)
		return
	}
	etag := `"` + f.addr + `"`
	h.Set("ETag", etag)
	if strings.HasPrefix(f.mime, "text/html") {
		// Revalidate pages every time: a publish flips the build, and the
		// ETag (the content hash) makes an unchanged page a cheap 304.
		h.Set("Cache-Control", "no-cache")
	} else {
		h.Set("Cache-Control", "public, max-age=300")
	}
	if match := r.Header.Get("If-None-Match"); match != "" && match == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Type", f.mime)
	h.Set("Content-Length", strconv.FormatInt(f.size, 10))
	if r.Method == http.MethodHead {
		return
	}
	if err := s.Storage.GetAll(ctx, []string{f.addr}, w); err != nil {
		// Headers are out; all we can do is log.
		s.logger().Warn("portal: stream file", "build", build, "path", want, "err", err)
	}
}

// serve404 serves the build's 404 page with its site-root links pointed at
// prefix (a 404 can be at any depth, so they can't be relative).
func (s *Server) serve404(w http.ResponseWriter, r *http.Request, build int64, clean, prefix string) {
	ctx := r.Context()
	w.Header().Set("Cache-Control", "no-cache")
	f, ok, err := s.lookup(ctx, build, "404.html")
	if err != nil || !ok {
		if err != nil {
			s.logger().Warn("portal: 404 page", "build", build, "err", err)
		}
		http.NotFound(w, r)
		return
	}
	var buf bytes.Buffer
	if err := s.Storage.GetAll(ctx, []string{f.addr}, &buf); err != nil {
		s.logger().Warn("portal: 404 page", "build", build, "err", err)
		http.NotFound(w, r)
		return
	}
	body := bytes.ReplaceAll(buf.Bytes(), []byte(NotFoundBase), []byte(prefix))
	w.Header().Set("Content-Type", f.mime)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(http.StatusNotFound)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(body); err != nil {
		s.logger().Debug("portal: write 404", "path", clean, "err", err)
	}
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	s.logger().Warn("portal: serve", "err", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}
