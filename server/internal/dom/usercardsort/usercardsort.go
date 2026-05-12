// Package usercardsort holds user_card_sort.set — the canonical writer for
// the per-user inbox ordering. Each user keeps their own sort_order on
// every card they touch; this is intentionally distinct from the global
// `attributes.sort_order` the kanban uses (see migration 0008), which is
// shared across users.
//
// Authz: a user may only write their own row. The user_id used is
// `auth.ActorOrSystem(ctx)` — the caller never supplies it. (When OIDC
// lands in Phase 20, the actor id flows from the verified subject claim;
// in dev mode it falls back to the System User.)
//
// Coalescing: N user_card_sort.set sub-requests in one batch produce ONE
// SQL statement-group. The CTE ingests a JSON array of (card_id,
// sort_order) tuples and upserts every row in one pass.
package usercardsort

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is one row of user_card_sort.set. The user_id is implicit: it
// is always the calling actor (auth.ActorOrSystem). Callers pick the
// midpoint between neighbours when computing SortOrder; the server stores
// it verbatim.
type SetInput struct {
	CardID    int64   `json:"card_id,string" mcp:"required,desc=card to reorder"`
	SortOrder float64 `json:"sort_order" mcp:"required,desc=new sort order — caller picks midpoint between neighbours"`
}

// SetOutput is a tiny ack — the per-user ordering is opaque to clients
// beyond the inbox.select read.
type SetOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful upsert"`
}

// Register installs the handler.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "user_card_sort",
		Action:       "set",
		Doc:          "Upsert the calling user's personal sort_order for one card. Used by the inbox drag-drop reorder; per-user ordering is independent of the global sort_order attribute.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set",
		CardTypeID:   cardTypeFromInput,
		Run:          runSet(p),
	})
}

// cardTypeFromInput resolves the card_type_id of the targeted card so the
// dispatcher can authorize (card_type, process). Inbox writes always target
// task cards in practice; we look it up rather than hard-coding so a future
// "drag a milestone in your personal view" works without a code change.
func cardTypeFromInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetInput).CardID)
}

// jsonRow is the per-row payload fed into jsonb_to_recordset. We do not
// include user_id in the payload — the caller never supplies it; the
// handler stamps it from ctx, so a malicious client cannot fake it.
type jsonRow struct {
	CardID    int64   `json:"card_id,string"`
	SortOrder float64 `json:"sort_order"`
}

// runSet is an arrayPath writer. // arrayPath
func runSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)

		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_card_sort.set: card_id is required"}
			}
			payload[i] = jsonRow{CardID: in.CardID, SortOrder: in.SortOrder}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}

		// Single CTE: read N (card_id, sort_order) tuples from the JSON
		// array, upsert each into user_card_sort with the calling user's
		// id stamped from ctx. The PRIMARY KEY (user_id, card_id) ensures
		// re-setting the same card is a clean idempotent update.
		const q = `
			WITH input AS (
				SELECT * FROM jsonb_to_recordset($1::jsonb)
				AS x(card_id bigint, sort_order double precision)
			)
			INSERT INTO user_card_sort (user_id, card_id, sort_order, updated_at)
			SELECT $2::bigint, i.card_id, i.sort_order, now() FROM input i
			ON CONFLICT (user_id, card_id) DO UPDATE
				SET sort_order = EXCLUDED.sort_order,
				    updated_at = now()
		`
		if _, err := tx.Exec(ctx, q, buf, actorID); err != nil {
			return nil, fmt.Errorf("user_card_sort.set: %w", err)
		}
		if p != nil {
			p.NoteWrite()
		}

		outs := make([]any, len(ins))
		for i := range ins {
			outs[i] = SetOutput{OK: true}
		}
		return outs, nil
	}
}
