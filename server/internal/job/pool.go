package job

import (
	"context"
	"errors"
	"sync"
)

// WorkerPool keeps a set of per-key workers in sync with a live key set
// and runs each worker once per [WorkerPool.Sweep]. It's the bridge that
// lets a SINGLE scheduler [Job] drive N per-row workers — IMAP pollers,
// SMTP senders, activity-sink pumpers — instead of one goroutine per row.
//
// The owning Job's closure lists the live keys (e.g. the current
// comm_channel ids) and calls Sweep; the pool adds workers for new keys,
// drops workers for vanished keys, and runs each surviving worker. The
// workers themselves hold no OS resources between sweeps (each run dials
// and closes), so a dropped worker needs no teardown.
//
// K is the worker's identity (a channel id, or a {sink,project} pair);
// W is the worker value (typically a pointer). Not safe to share one
// pool across multiple concurrent Sweep callers — a scheduler Job runs
// its body single-threaded, which is the intended use.
type WorkerPool[K comparable, W any] struct {
	mu      sync.Mutex
	workers map[K]W
	// build constructs the worker for a newly-seen key.
	build func(K) W
	// run executes one worker's unit of work. Per-worker errors are the
	// worker's own concern (it logs / backs off); Sweep still joins and
	// returns them so a caller MAY treat them as a Job failure if it
	// wants. The comm wirings return nil here to keep their Job green.
	run func(context.Context, W) error
}

// NewWorkerPool builds a pool. build is called once per newly-seen key;
// run is called once per surviving worker on every Sweep.
func NewWorkerPool[K comparable, W any](build func(K) W, run func(context.Context, W) error) *WorkerPool[K, W] {
	return &WorkerPool[K, W]{
		workers: make(map[K]W),
		build:   build,
		run:     run,
	}
}

// Sweep reconciles the worker set to keys, then runs every surviving
// worker once. Reconciliation (add/drop) holds the lock; the run phase
// does not, so a slow worker doesn't block membership reads. Returns the
// joined per-worker errors (nil when every run returned nil). Stops early
// if ctx is cancelled mid-sweep.
func (p *WorkerPool[K, W]) Sweep(ctx context.Context, keys []K) error {
	p.mu.Lock()
	live := make(map[K]struct{}, len(keys))
	for _, k := range keys {
		live[k] = struct{}{}
		if _, ok := p.workers[k]; !ok {
			p.workers[k] = p.build(k)
		}
	}
	for k := range p.workers {
		if _, ok := live[k]; !ok {
			delete(p.workers, k)
		}
	}
	snapshot := make([]W, 0, len(p.workers))
	for _, w := range p.workers {
		snapshot = append(snapshot, w)
	}
	p.mu.Unlock()

	var errs []error
	for _, w := range snapshot {
		if ctx.Err() != nil {
			errs = append(errs, ctx.Err())
			break
		}
		if err := p.run(ctx, w); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Len reports the number of live workers. Useful for startup / sweep
// logging.
func (p *WorkerPool[K, W]) Len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.workers)
}
