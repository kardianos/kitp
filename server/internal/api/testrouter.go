package api

import (
	"net/http"

	"github.com/kitp/kitp/server/internal/auth"
)

// NewTestRouter returns a Router whose SessionResolver + BearerResolver
// both resolve to the supplied user. Use it from package _test files
// that need to mount Authed/Bearer routes without standing up a real
// session.Manager or token.Manager.
//
// This is the analog of the old `auth.Middleware(user)(mux)` test
// pattern: every request looks signed-in as `user`. The router's
// per-handler authz checks (and the dispatcher's role gate behind
// MountBatch) still run normally — the test pool's seed data picks
// up the user's role grants from there.
func NewTestRouter(user *auth.UserCtx) *Router {
	resolve := func(_ *http.Request) (*auth.UserCtx, error) { return user, nil }
	return NewRouter(RouterConfig{
		SessionResolver: resolve,
		BearerResolver:  resolve,
	})
}
