package job_test

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/job"
	"github.com/kitp/kitp/server/internal/store"
)

// TestExclusiveRunsOnce (review 2026-11-03 round 5): while one run holds a
// key, another with the same key is skipped; a different key runs; after
// the first ends, the key is free again.
func TestExclusiveRunsOnce(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_r5_exclusive")
	ctx := context.Background()
	inside := make(chan struct{})
	release := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		_, err := job.Exclusive(ctx, pool, "unit:1", func(context.Context) error {
			close(inside)
			<-release
			return nil
		})
		done <- err
	}()
	<-inside
	ran, err := job.Exclusive(ctx, pool, "unit:1", func(context.Context) error { return nil })
	if err != nil || ran {
		t.Errorf("a second run while the first holds the key: ran=%v err=%v", ran, err)
	}
	ran, err = job.Exclusive(ctx, pool, "unit:2", func(context.Context) error { return nil })
	if err != nil || !ran {
		t.Errorf("another key: ran=%v err=%v", ran, err)
	}
	close(release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	ran, err = job.Exclusive(ctx, pool, "unit:1", func(context.Context) error { return nil })
	if err != nil || !ran {
		t.Errorf("after the first run: ran=%v err=%v", ran, err)
	}
}
