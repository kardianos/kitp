package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/reg"
)

type fakeController struct {
	descs   []job.JobDescriptor
	trigger func(ctx context.Context, name string) (job.RunResult, error)
}

func (f *fakeController) Describe() []job.JobDescriptor { return f.descs }
func (f *fakeController) Trigger(ctx context.Context, name string) (job.RunResult, error) {
	return f.trigger(ctx, name)
}

// install swaps the package controller for the duration of one test.
func install(t *testing.T, c Controller) {
	t.Helper()
	prev := current.Load()
	current.Store(&holder{c: c})
	t.Cleanup(func() { current.Store(prev) })
}

func TestRunList(t *testing.T) {
	ran := time.Date(2026, 5, 28, 12, 0, 0, 0, time.UTC)
	install(t, &fakeController{descs: []job.JobDescriptor{{
		Name:        "alpha",
		Description: "the alpha job",
		Interval:    10 * time.Minute,
		Timeout:     6 * time.Second,
		OnStartup:   true,
		Metrics: job.JobMetrics{
			Name: "alpha", Success: 3, Failure: 1,
			LastRunAt: ran, LastDuration: 2 * time.Millisecond, LastError: "oops",
		},
	}}})

	outs, err := runList(context.Background(), nil, []any{ListInput{}})
	if err != nil {
		t.Fatalf("runList: %v", err)
	}
	if len(outs) != 1 {
		t.Fatalf("got %d outputs, want 1", len(outs))
	}
	jobs := outs[0].(ListOutput).Jobs
	if len(jobs) != 1 {
		t.Fatalf("got %d jobs, want 1", len(jobs))
	}
	j := jobs[0]
	if j.Name != "alpha" || j.Description != "the alpha job" || j.Interval != "10m0s" || j.Timeout != "6s" {
		t.Errorf("static fields wrong: %+v", j)
	}
	if j.Success != 3 || j.Failure != 1 || j.LastError != "oops" {
		t.Errorf("metrics wrong: %+v", j)
	}
	if j.LastRunAt != "2026-05-28T12:00:00Z" || j.LastDuration != "2ms" {
		t.Errorf("last-run fields wrong: %+v", j)
	}
}

func TestRunTriggerSuccess(t *testing.T) {
	started := time.Date(2026, 5, 28, 9, 30, 0, 0, time.UTC)
	install(t, &fakeController{
		descs: []job.JobDescriptor{{Name: "alpha", Metrics: job.JobMetrics{Name: "alpha", Success: 1, LastRunAt: started}}},
		trigger: func(_ context.Context, name string) (job.RunResult, error) {
			return job.RunResult{Name: name, StartedAt: started, Duration: 5 * time.Millisecond}, nil
		},
	})

	outs, err := runTrigger(context.Background(), nil, []any{RunInput{Name: "alpha"}})
	if err != nil {
		t.Fatalf("runTrigger: %v", err)
	}
	out := outs[0].(RunOutput)
	if !out.Started || !out.OK || out.Error != "" || out.Message != "ran successfully" {
		t.Errorf("unexpected outcome: %+v", out)
	}
	if out.Duration != "5ms" || out.RanAt != "2026-05-28T09:30:00Z" {
		t.Errorf("timing fields wrong: %+v", out)
	}
	if out.Job.Name != "alpha" || out.Job.Success != 1 {
		t.Errorf("refreshed job row missing: %+v", out.Job)
	}
}

func TestRunTriggerJobError(t *testing.T) {
	install(t, &fakeController{
		descs: []job.JobDescriptor{{Name: "alpha"}},
		trigger: func(_ context.Context, _ string) (job.RunResult, error) {
			return job.RunResult{Name: "alpha", Err: errors.New("boom")}, nil
		},
	})

	outs, err := runTrigger(context.Background(), nil, []any{RunInput{Name: "alpha"}})
	if err != nil {
		t.Fatalf("runTrigger returned a control error: %v", err)
	}
	out := outs[0].(RunOutput)
	if !out.Started || out.OK || out.Error != "boom" || out.Message != "run failed" {
		t.Errorf("expected a failed-run outcome: %+v", out)
	}
}

func TestRunTriggerNotFound(t *testing.T) {
	install(t, &fakeController{
		trigger: func(_ context.Context, _ string) (job.RunResult, error) { return job.RunResult{}, job.ErrJobNotFound },
	})

	_, err := runTrigger(context.Background(), nil, []any{RunInput{Name: "ghost"}})
	var he *reg.HandlerError
	if !errors.As(err, &he) || he.Code != "not_found" {
		t.Errorf("err = %v, want *reg.HandlerError{Code:not_found}", err)
	}
}

func TestRunTriggerAlreadyRunning(t *testing.T) {
	install(t, &fakeController{
		descs:   []job.JobDescriptor{{Name: "alpha"}},
		trigger: func(_ context.Context, _ string) (job.RunResult, error) { return job.RunResult{}, job.ErrJobRunning },
	})

	outs, err := runTrigger(context.Background(), nil, []any{RunInput{Name: "alpha"}})
	if err != nil {
		t.Fatalf("runTrigger: %v", err)
	}
	out := outs[0].(RunOutput)
	if out.Started || out.OK || out.Message == "" {
		t.Errorf("expected a not-started outcome with a message: %+v", out)
	}
}

func TestRunNoController(t *testing.T) {
	install(t, nil) // holder{c: nil} → loadController returns nil
	if _, err := runList(context.Background(), nil, []any{ListInput{}}); !errors.Is(err, errNoScheduler) {
		t.Errorf("runList err = %v, want errNoScheduler", err)
	}
	if _, err := runTrigger(context.Background(), nil, []any{RunInput{Name: "x"}}); !errors.Is(err, errNoScheduler) {
		t.Errorf("runTrigger err = %v, want errNoScheduler", err)
	}
}
