// Package scheduler exposes scheduler.list / scheduler.run — admin
// handlers that introspect and manually trigger the process's hard-coded
// background jobs (the [job.Scheduler] declared in cmd/kitpd/main.go).
//
// These are Run-closure handlers (not SQLFunc): their data source is the
// in-memory scheduler, not the database — the same shape as echo.ping /
// config.get. The live scheduler is injected at startup via [Register];
// before that (or in the MCP entrypoint, which has no scheduler) the
// handlers report "scheduler unavailable".
//
// Authz: both handlers are admin-only via the dispatcher's role gate;
// scheduler.run additionally requires the actor to hold admin globally
// (it mutates — triggering a job runs cleanup / prune work), mirroring
// dom/rolemapping.
package scheduler

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// runTimeout caps one manual scheduler.run invocation. It sits below the
// pool's idle_in_transaction_session_timeout (60s): the request tx is
// open-but-idle while the job runs on a separate pool connection, so a
// run that outran 60s would get its request connection reaped and fail
// the surrounding commit. 45s leaves margin; the declared jobs all
// finish in milliseconds in practice.
const runTimeout = 45 * time.Second

// Controller is the read + trigger surface the handlers need from the
// live job scheduler. *job.Scheduler[Cfg] satisfies it for any Cfg.
type Controller interface {
	Describe() []job.JobDescriptor
	Trigger(ctx context.Context, name string) (job.RunResult, error)
}

// holder wraps the Controller so it can live in an atomic.Pointer (an
// interface value isn't directly storable). Written once at startup,
// read on every request.
type holder struct{ c Controller }

var current atomic.Pointer[holder]

func loadController() Controller {
	h := current.Load()
	if h == nil {
		return nil
	}
	return h.c
}

// JobInfo is the wire shape for one job: its static declaration plus a
// live metrics snapshot. Durations are pre-formatted strings so the UI
// renders them verbatim.
type JobInfo struct {
	Name         string `json:"name" mcp:"desc=unique job name"`
	Description  string `json:"description" mcp:"desc=human blurb of what the job does"`
	Interval     string `json:"interval" mcp:"desc=cadence between scheduled runs (e.g. 10m0s)"`
	Timeout      string `json:"timeout" mcp:"desc=effective per-run wall-clock cap"`
	OnStartup    bool   `json:"on_startup" mcp:"desc=true if the job runs once at process start"`
	Offset       string `json:"offset" mcp:"desc=initial delay before the first tick (empty when none)"`
	Disabled     bool   `json:"disabled" mcp:"desc=true if the scheduler skips this job"`
	Success      int64  `json:"success" mcp:"desc=count of successful runs since process start"`
	Failure      int64  `json:"failure" mcp:"desc=count of failed runs since process start"`
	LastRunAt    string `json:"last_run_at" mcp:"desc=RFC3339 timestamp of the last run (empty if never)"`
	LastDuration string `json:"last_duration" mcp:"desc=wall-clock duration of the last run (empty if never)"`
	LastError    string `json:"last_error" mcp:"desc=error from the last failure (empty if none)"`
}

func toJobInfo(d job.JobDescriptor) JobInfo {
	info := JobInfo{
		Name:        d.Name,
		Description: d.Description,
		Interval:    d.Interval.String(),
		Timeout:     d.Timeout.String(),
		OnStartup:   d.OnStartup,
		Disabled:    d.Disabled,
		Success:     d.Metrics.Success,
		Failure:     d.Metrics.Failure,
		LastError:   d.Metrics.LastError,
	}
	if d.Offset > 0 {
		info.Offset = d.Offset.String()
	}
	if !d.Metrics.LastRunAt.IsZero() {
		info.LastRunAt = d.Metrics.LastRunAt.UTC().Format(time.RFC3339)
		info.LastDuration = d.Metrics.LastDuration.String()
	}
	return info
}

// ListInput is empty.
type ListInput struct{}

// ListOutput wraps every job in a stable envelope.
type ListOutput struct {
	Jobs []JobInfo `json:"jobs" mcp:"desc=every hard-coded background job"`
}

// RunInput names the job to trigger.
type RunInput struct {
	Name string `json:"name" mcp:"required,desc=name of the job to run now"`
}

// RunOutput is the outcome of one manual run plus the job's refreshed
// metrics row (so the UI's last-run box updates from a single response).
type RunOutput struct {
	Name string `json:"name" mcp:"desc=the job that was triggered"`
	// Started is false when the job was already running (a scheduled
	// tick or another manual run held it); no new run was launched.
	Started bool `json:"started" mcp:"desc=true if a run was actually launched"`
	// OK is true when the run executed AND the job returned no error.
	OK       bool   `json:"ok" mcp:"desc=true if the run executed and succeeded"`
	Error    string `json:"error" mcp:"desc=the job's run error (empty on success)"`
	Duration string `json:"duration" mcp:"desc=wall-clock duration of this run (empty if not started)"`
	RanAt    string `json:"ran_at" mcp:"desc=RFC3339 timestamp of this run (empty if not started)"`
	// Message is a short human status for the UI (e.g. "already running").
	Message string  `json:"message" mcp:"desc=short human status line"`
	Job     JobInfo `json:"job" mcp:"desc=the job's refreshed metrics row after the run"`
}

// Register installs scheduler.list + scheduler.run and wires the live
// controller. Call once from the HTTP entrypoint after the scheduler is
// built; the MCP entrypoint does not register these (no scheduler).
func Register(pool *store.Pool, ctl Controller) {
	authzPool = pool
	current.Store(&holder{c: ctl})

	reg.Register(reg.Handler{
		Endpoint:     "scheduler",
		Action:       "list",
		Doc:          "Admin-only: list every hard-coded background job with its properties and last-run status.",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{"admin"},
		Run:          runList,
	})
	reg.Register(reg.Handler{
		Endpoint:     "scheduler",
		Action:       "run",
		Doc:          "Admin-only: run one background job now and return its result.",
		InputType:    reflect.TypeFor[RunInput](),
		OutputType:   reflect.TypeFor[RunOutput](),
		AllowedRoles: []string{"admin"},
		Authz:        authzAdmin,
		Timeout:      runTimeout,
		Run:          runTrigger,
	})
}

func runList(_ context.Context, _ pgx.Tx, ins []any) ([]any, error) {
	ctl := loadController()
	if ctl == nil {
		return nil, fmt.Errorf("scheduler.list: %w", errNoScheduler)
	}
	descs := ctl.Describe()
	jobs := make([]JobInfo, len(descs))
	for i, d := range descs {
		jobs[i] = toJobInfo(d)
	}
	outs := make([]any, len(ins))
	for i := range ins {
		outs[i] = ListOutput{Jobs: jobs}
	}
	return outs, nil
}

func runTrigger(ctx context.Context, _ pgx.Tx, ins []any) ([]any, error) {
	ctl := loadController()
	if ctl == nil {
		return nil, fmt.Errorf("scheduler.run: %w", errNoScheduler)
	}
	outs := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(RunInput)
		res, err := ctl.Trigger(ctx, in.Name)
		switch {
		case errors.Is(err, job.ErrJobNotFound):
			return nil, &reg.HandlerError{InputIndex: i, Code: "not_found", Message: fmt.Sprintf("no job named %q", in.Name)}
		case errors.Is(err, job.ErrJobRunning):
			// Not a failure: report the state and the current metrics so
			// the UI can show "already running" without a fault toast.
			outs[i] = withRefreshedJob(ctl, in.Name, RunOutput{
				Name:    in.Name,
				Started: false,
				Message: "job is already running; try again shortly",
			})
		case err != nil:
			// Unexpected controller error — redact via wrap (the router
			// logs the chain, the client gets a generic internal error).
			return nil, fmt.Errorf("scheduler.run %q: %w", in.Name, err)
		default:
			out := RunOutput{
				Name:     res.Name,
				Started:  true,
				OK:       res.Err == nil,
				Duration: res.Duration.String(),
				RanAt:    res.StartedAt.UTC().Format(time.RFC3339),
			}
			if res.Err != nil {
				out.Error = res.Err.Error()
				out.Message = "run failed"
			} else {
				out.Message = "ran successfully"
			}
			outs[i] = withRefreshedJob(ctl, res.Name, out)
		}
	}
	return outs, nil
}

// withRefreshedJob fills out.Job with the named job's current metrics
// snapshot so the response carries the post-run state.
func withRefreshedJob(ctl Controller, name string, out RunOutput) RunOutput {
	for _, d := range ctl.Describe() {
		if d.Name == name {
			out.Job = toJobInfo(d)
			break
		}
	}
	return out
}

var errNoScheduler = errors.New("scheduler not available in this process")

var authzPool *store.Pool

// authzAdmin gates scheduler.run: the actor must hold the admin or system
// role globally. Mirrors dom/rolemapping.authzAdmin.
func authzAdmin(ctx context.Context, _ any) error {
	if authzPool == nil {
		return nil
	}
	userID := auth.ActorOrSystem(ctx)
	var n int
	if err := authzPool.P.QueryRow(ctx, `
		SELECT count(*)
		FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, userID).Scan(&n); err != nil {
		return fmt.Errorf("scheduler.authz: %w", err)
	}
	if n == 0 {
		return fmt.Errorf("scheduler: actor %d is not a global admin", userID)
	}
	return nil
}
