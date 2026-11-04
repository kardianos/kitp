package cas

import (
	"context"
	"fmt"

	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// NoteHolder records that userID sent the bytes at address
// (cas_blob_holder). file.create takes an address only from an account that
// holds it — sent it, or may read a file it is part of (cas_held_by) — so
// knowing a hash isn't having the file (review 2026-11-03 round 2 #21).
// Every route that stores bytes for a later file.create calls it after Put.
func NoteHolder(ctx context.Context, q store.Querier, address string, userID int64) error {
	b := named.New()
	b.Set("address", address)
	b.Set("user", userID)
	sql, args, err := b.Compile(`
		INSERT INTO cas_blob_holder (address, user_id) VALUES (:address, :user)
		ON CONFLICT (address, user_id) DO NOTHING
	`)
	if err != nil {
		return fmt.Errorf("cas: note holder: compile: %w", err)
	}
	if _, err := q.Exec(ctx, sql, args...); err != nil {
		return fmt.Errorf("cas: note holder: %w", err)
	}
	return nil
}
