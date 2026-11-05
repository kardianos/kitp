package job

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/named"
)

// Exclusive runs fn while this process holds the Postgres session
// advisory lock named key, so one unit of per-row work (an IMAP poll, a
// digest) runs on one replica at a time: a replica that finds the lock
// taken skips the run (ran is false) and the holder does it. Two replicas
// each sent every digest, and counted each other's IMAP reads as crashes
// (review 2026-11-03 round 5). The lock lives on a connection held for
// fn's run (fn queries through the pool as usual), so it goes if kitpd
// dies mid-run; it is released on the way out either way.
func Exclusive(ctx context.Context, pool *pgxpool.Pool, key string, fn func(context.Context) error) (ran bool, err error) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return false, fmt.Errorf("exclusive %s: acquire: %w", key, err)
	}
	defer conn.Release()
	b := named.New()
	b.Set("key", key)
	lock, args, err := b.Compile(`SELECT pg_try_advisory_lock(hashtextextended(:key, 0))`)
	if err != nil {
		return false, fmt.Errorf("exclusive %s: compile: %w", key, err)
	}
	var got bool
	if err := conn.QueryRow(ctx, lock, args...).Scan(&got); err != nil {
		return false, fmt.Errorf("exclusive %s: lock: %w", key, err)
	}
	if !got {
		return false, nil
	}
	defer func() {
		ub := named.New()
		ub.Set("key", key)
		unlock, uargs, cerr := ub.Compile(`SELECT pg_advisory_unlock(hashtextextended(:key, 0))`)
		if cerr == nil {
			// The run's ctx may be done; the unlock still goes out.
			uctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			_, cerr = conn.Exec(uctx, unlock, uargs...)
		}
		if cerr != nil {
			// The lock would outlive the run on a pooled connection: close
			// it, which releases the lock with the session.
			if cerr2 := conn.Conn().Close(context.Background()); cerr2 != nil && err == nil {
				err = fmt.Errorf("exclusive %s: unlock: %w (close: %v)", key, cerr, cerr2)
			} else if err == nil {
				err = fmt.Errorf("exclusive %s: unlock: %w", key, cerr)
			}
		}
	}()
	return true, fn(ctx)
}
