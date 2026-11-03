package job

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
)

// Protect runs f and turns a panic into an error, so one bad unit of work
// (a malformed message, a nil map in one row) fails that run instead of
// taking kitpd down with it (review B9). The panic's stack goes to the
// log; the returned error carries only the panic value. A nil logger
// logs to slog.Default().
//
// The scheduler wraps every tick and manual trigger in it, and
// WorkerPool every worker's run; anything else that starts its own
// goroutine should too.
func Protect(ctx context.Context, logger *slog.Logger, what string, f func() error) (err error) {
	defer func() {
		p := recover()
		if p == nil {
			return
		}
		if logger == nil {
			logger = slog.Default()
		}
		logger.LogAttrs(ctx, slog.LevelError, "panic recovered",
			slog.String("in", what),
			slog.String("panic", fmt.Sprint(p)),
			slog.String("stack", string(debug.Stack())))
		err = fmt.Errorf("%s: panic: %v", what, p)
	}()
	return f()
}
