// Package logpath keeps secrets that live in URL paths out of logs. Routes
// that carry one (calendar feeds, inbound mail routes) register their prefix
// with Mark; every log line that prints a request path passes it through Of,
// which shows the prefix and a placeholder instead. It imports nothing from
// kitp so both obs and api can use it. See docs/MAIL_INTAKE_AND_CALENDARS.md §2.
package logpath

import (
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
// It returns a string that already exists either way, so it never
// allocates.
func Of(path string) string {
	cur := sensitivePaths.Load()
	if cur == nil {
		return path
	}
	for i := range *cur {
		if strings.HasPrefix(path, (*cur)[i].prefix) {
			return (*cur)[i].shown
		}
	}
	return path
}
