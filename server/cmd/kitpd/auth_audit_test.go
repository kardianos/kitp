// File cmd/kitpd/auth_audit_test.go: produces a CSV inventory of the
// authenticated surface for review.
//
// Two declarative sources feed the audit:
//
//   1. The apiRouter — every HTTP route registered through Public /
//      Authed / Bearer is captured in Router.Routes(). We mount every
//      package's HTTP routes against a stub-resolver router, then
//      enumerate.
//
//   2. The dispatcher registry — reg.All() returns every handler the
//      domain packages have registered, including each one's
//      AllowedRoles list (the declarative role gate).
//
// The combined inventory is rendered to a deterministic CSV and
// compared to testdata/auth_audit.csv. Drift fails the test so any
// new route / new handler / role change requires regenerating the
// golden:
//
//   KITP_UPDATE_GOLDEN=1 go test ./cmd/kitpd/ -run TestAuthAudit
//
// The CSV is committed as the canonical inventory. Reviewers diff it
// on every PR that touches the auth surface.
package main

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/auth/oidc"
	"github.com/kitp/kitp/server/internal/auth/session"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/attachment"
	"github.com/kitp/kitp/server/internal/dom/projectexport"
	"github.com/kitp/kitp/server/internal/mcp"
	"github.com/kitp/kitp/server/internal/reg"
)

// TestAuthAudit emits the CSV inventory and compares it to the
// committed golden. Update with KITP_UPDATE_GOLDEN=1 when the diff
// reflects an intentional change.
func TestAuthAudit(t *testing.T) {
	// Reset the dispatcher registry — every domain package's
	// init() will re-populate it via registerHandlers below. Without
	// the reset a previous test in the same binary could leave
	// stale entries (the registry is process-global by design).
	reg.Reset()
	registerHandlers(nil, nil)

	// Stub resolvers. The audit only enumerates registrations; it
	// never dispatches a real request, so resolver bodies don't
	// matter beyond satisfying Authed/Bearer's "resolver non-nil"
	// startup guard.
	stub := func(_ *http.Request) (*auth.UserCtx, error) { return nil, nil }
	rt := api.NewRouter(api.RouterConfig{
		SessionResolver: stub,
		BearerResolver:  stub,
	})

	// Mount everything that lives under /api/. Order doesn't matter
	// for the audit — Routes() returns in registration order, then
	// we sort below.
	session.Mount(rt, session.HTTPConfig{
		DevLoginEnabled: true, // include dev-login + dev-impersonate in the audit
	})
	// OIDC routes are registered via the same Mount path production
	// uses. cfg.Validate() (the field-required check) is intentionally
	// not called here — Mount is pure-registration, and the audit
	// doesn't care whether the OIDC OP is reachable.
	oidc.Mount(rt, oidc.BFFConfig{})
	mcp.Mount(rt, mcp.HTTPConfig{})
	cas.Mount(rt, cas.HTTPConfig{})
	attachment.Mount(rt, attachment.Config{})
	projectexport.Mount(rt, projectexport.Config{})
	srv := api.NewServer(nil)
	srv.MountBatch(rt)

	got := renderAuditCSV(rt.Routes(), reg.All())

	goldenPath := filepath.Join("testdata", "auth_audit.csv")
	if os.Getenv("KITP_UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatalf("mkdir testdata: %v", err)
		}
		if err := os.WriteFile(goldenPath, []byte(got), 0o644); err != nil {
			t.Fatalf("write golden: %v", err)
		}
		t.Logf("wrote %s", goldenPath)
		return
	}

	want, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatalf(
			"read golden %s: %v\n\nRun KITP_UPDATE_GOLDEN=1 go test ./cmd/kitpd/ -run TestAuthAudit to generate.",
			goldenPath, err,
		)
	}
	if got != string(want) {
		t.Errorf(
			"auth audit drift — re-run with KITP_UPDATE_GOLDEN=1 to accept.\n\n--- want (golden) ---\n%s\n--- got (current) ---\n%s",
			string(want), got,
		)
	}
}

// renderAuditCSV deterministically formats both halves of the audit
// into one CSV. Two row kinds:
//
//   kind=http_route   columns: kind, tier, pattern, ,
//   kind=dispatcher   columns: kind, , endpoint.action, roles, doc
//
// `roles` is the AllowedRoles list joined with `;` so the CSV cell
// stays one column. The leading `kind` column lets a reviewer filter
// the file by row type (e.g. `awk -F, '$1=="dispatcher"' …`).
func renderAuditCSV(routes []api.RouteSpec, handlers []reg.Handler) string {
	type row struct {
		Kind     string // "http_route" | "dispatcher"
		Tier     string // http_route only
		Pattern  string // http_route only
		EndAct   string // dispatcher: "endpoint.action"
		Roles    string // dispatcher: semicolon-joined AllowedRoles
		Doc      string // dispatcher: handler.Doc
	}

	rows := make([]row, 0, len(routes)+len(handlers))
	for _, r := range routes {
		rows = append(rows, row{Kind: "http_route", Tier: r.Tier, Pattern: r.Pattern})
	}
	for _, h := range handlers {
		// AllowedRoles already sorted-stable inside the registration
		// (handlers declare them in a specific order). Sort here too
		// so the rendered cell is canonical even if a future handler
		// declares them out of order.
		roles := append([]string(nil), h.AllowedRoles...)
		sort.Strings(roles)
		rows = append(rows, row{
			Kind:   "dispatcher",
			EndAct: h.Endpoint + "." + h.Action,
			Roles:  strings.Join(roles, ";"),
			Doc:    flattenDoc(h.Doc),
		})
	}

	// Sort by (kind, tier|endpoint+action, pattern) so the CSV diff
	// is line-stable across re-runs.
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.Kind != b.Kind {
			return a.Kind < b.Kind
		}
		if a.Kind == "http_route" {
			if a.Tier != b.Tier {
				return a.Tier < b.Tier
			}
			return a.Pattern < b.Pattern
		}
		return a.EndAct < b.EndAct
	})

	var buf bytes.Buffer
	w := csv.NewWriter(&buf)
	_ = w.Write([]string{"kind", "tier", "pattern", "endpoint_action", "roles", "doc"})
	for _, r := range rows {
		_ = w.Write([]string{r.Kind, r.Tier, r.Pattern, r.EndAct, r.Roles, r.Doc})
	}
	w.Flush()
	return buf.String()
}

// flattenDoc collapses a multi-line handler doc into a single line so
// the CSV cell doesn't span rows. Whitespace runs collapse to one
// space — readable enough for a one-glance audit, and the canonical
// source is the handler's Doc field anyway.
func flattenDoc(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
