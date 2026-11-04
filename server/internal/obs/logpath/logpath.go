// Package logpath keeps secrets that live in URL paths out of logs. Routes
// that carry one (calendar feeds, inbound mail routes) register their prefix
// with Mark; every log line that prints a request path passes it through Of,
// which shows the prefix and a placeholder instead. It imports nothing from
// kitp so both obs and api can use it. See docs/MAIL_INTAKE_AND_CALENDARS.md §2.
package logpath

import (
	pathpkg "path"
	"strings"
	"sync"
	"sync/atomic"
)

type sensitivePath struct {
	prefix string // e.g. "/api/v1/calendar/"
	shown  string // prefix + "…", built once at registration
}

var (
	sensitiveMu    sync.Mutex
	sensitivePaths atomic.Pointer[[]sensitivePath]
)

// Mark registers a path prefix whose remainder is a secret.
// Call it when the route is mounted. Registration copies the list, so
// Of reads it with one atomic load and no lock.
func Mark(prefix string) {
	sensitiveMu.Lock()
	defer sensitiveMu.Unlock()
	var next []sensitivePath
	if cur := sensitivePaths.Load(); cur != nil {
		for _, p := range *cur {
			if p.prefix == prefix {
				return
			}
		}
		next = append(next, *cur...)
	}
	next = append(next, sensitivePath{prefix: prefix, shown: prefix + "…"})
	sensitivePaths.Store(&next)
}

// Of returns the path to log for a request path: the registered prefix
// plus "…" when the path is under a sensitive prefix, else the path itself.
// A path is matched as the mux would route it — cleaned of doubled slashes
// and dot segments, which net/http redirects to the clean path after the
// request was logged as sent — and in any letter case, so a mistyped
// "/API/v1/calendar/<token>" isn't logged either (review 2026-11-03 round
// 4). A clean path returns a string that already exists, so it doesn't
// allocate; only an unclean one is cleaned (one allocation).
func Of(path string) string {
	cur := sensitivePaths.Load()
	if cur == nil {
		return path
	}
	if shown, ok := match(*cur, path); ok {
		return shown
	}
	if unclean(path) {
		if shown, ok := match(*cur, cleanPath(path)); ok {
			return shown
		}
	}
	return path
}

// match finds the sensitive prefix path starts with, in any case.
func match(list []sensitivePath, path string) (string, bool) {
	for i := range list {
		p := list[i].prefix
		if len(path) >= len(p) && strings.EqualFold(path[:len(p)], p) {
			return list[i].shown, true
		}
	}
	return "", false
}

// unclean reports whether net/http's mux would clean path before routing
// it: no leading slash, a doubled slash, or a "." / ".." segment.
func unclean(p string) bool {
	return !strings.HasPrefix(p, "/") || strings.Contains(p, "//") ||
		strings.Contains(p, "/./") || strings.Contains(p, "/../") ||
		strings.HasSuffix(p, "/.") || strings.HasSuffix(p, "/..")
}

// cleanPath is net/http's: path.Clean, rooted, keeping a trailing slash.
func cleanPath(p string) string {
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	np := pathpkg.Clean(p)
	if strings.HasSuffix(p, "/") && np != "/" {
		np += "/"
	}
	return np
}
