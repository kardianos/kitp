// Package usercardagent exposes user_card_agent.{set, clear, list} —
// the per-(user, card) routing of a task to one of the user's own
// agents. Same shape as user_card_sort.set (PK (user_id, card_id))
// but the payload is a bigint agent_user_id instead of a float
// sort_order.
//
// Authz: a user may only manage their OWN row. user_id is stamped
// from ctx (auth.ActorOrSystem) — callers never supply it. Set also
// validates that agent_user_id names an agent owned by the actor
// (parent_user_id = actor AND is_agent = true), so the routing graph
// stays strictly within the parent's tree of agents.
//
// Coalescing: N sub-requests in one batch produce one statement-group
// per action. set ingests a JSON array and UPSERTs in one CTE; clear
// and list each scope to a single deletion / read statement.
package usercardagent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// SetInput is one row of user_card_agent.set. user_id is implicit —
// always the calling actor. agent_user_id must be one of the actor's
// own agents (parent_user_id = actor, is_agent = true).
type SetInput struct {
	CardID      int64 `json:"card_id,string" mcp:"required,desc=card to route"`
	AgentUserID int64 `json:"agent_user_id,string" mcp:"required,desc=user_account id of one of the calling user's own agents"`
}

// SetOutput is a tiny ack.
type SetOutput struct {
	OK bool `json:"ok" mcp:"desc=true on successful upsert"`
}

// ClearInput removes the routing for one card. user_id is implicit.
type ClearInput struct {
	CardID int64 `json:"card_id,string" mcp:"required,desc=card whose routing to clear"`
}

// ClearOutput reports whether a routing row was actually removed.
type ClearOutput struct {
	OK      bool `json:"ok" mcp:"desc=true if a routing row was deleted by this call"`
	Deleted int  `json:"deleted" mcp:"desc=number of rows deleted (0 or 1)"`
}

// ListInput selects every card the calling user has routed.
// Currently no filter args — the typical use is "all my routings"
// rendered in the parent's task UI. Optional ParentCardID lets the
// caller scope to one project.
type ListInput struct {
	ParentCardID *int64 `json:"parent_card_id,string,omitempty" mcp:"desc=optional project (or other parent) id; when set, only routings whose target card sits under this parent are returned"`
}

// ListRow is one routing record.
type ListRow struct {
	CardID      int64 `json:"card_id,string" mcp:"desc=routed card id"`
	AgentUserID int64 `json:"agent_user_id,string" mcp:"desc=user_account id of the agent the card is routed to"`
	CreatedAt   string `json:"created_at" mcp:"desc=RFC3339 timestamp when the routing was set"`
}

// ListOutput wraps the row list.
type ListOutput struct {
	Rows []ListRow `json:"rows" mcp:"desc=routings owned by the calling user, in created_at DESC order"`
}

// Register installs all three handlers.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "set",
		Doc:          "Route a card to one of the calling user's agents. Upsert keyed on (actor, card). The agent_user_id must be an agent owned by the calling user.",
		InputType:    reflect.TypeFor[SetInput](),
		OutputType:   reflect.TypeFor[SetOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set", // shares the routing/reorder process bucket
		CardTypeID:   cardTypeFromSet,
		Run:          runSet(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "clear",
		Doc:          "Remove the calling user's routing for one card. Idempotent.",
		InputType:    reflect.TypeFor[ClearInput](),
		OutputType:   reflect.TypeFor[ClearOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "user_card_sort.set",
		CardTypeID:   cardTypeFromClear,
		Run:          runClear(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "user_card_agent",
		Action:       "list",
		Doc:          "List the calling user's routings, optionally scoped to one parent (e.g. a project).",
		InputType:    reflect.TypeFor[ListInput](),
		OutputType:   reflect.TypeFor[ListOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runList(p),
	})
}

func cardTypeFromSet(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(SetInput).CardID)
}

func cardTypeFromClear(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(ClearInput).CardID)
}

// jsonSetRow is the per-row payload fed to jsonb_to_recordset. user_id
// is stamped from ctx, not the wire.
type jsonSetRow struct {
	CardID      int64 `json:"card_id,string"`
	AgentUserID int64 `json:"agent_user_id,string"`
}

// runSet upserts every (actor, card_id) → agent_user_id row in one
// CTE. Validates first that every named agent_user_id is owned by the
// actor; rejects the whole batch on the first mismatch so a single
// bad input doesn't half-write a multi-card route.
func runSet(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)

		payload := make([]jsonSetRow, len(ins))
		agentIDs := make([]int64, 0, len(ins))
		for i, raw := range ins {
			in := raw.(SetInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_card_agent.set: card_id is required"}
			}
			if in.AgentUserID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_card_agent.set: agent_user_id is required"}
			}
			payload[i] = jsonSetRow{CardID: in.CardID, AgentUserID: in.AgentUserID}
			agentIDs = append(agentIDs, in.AgentUserID)
		}

		// Validate ownership of every referenced agent in a single
		// roundtrip. The set of agent ids the actor owns must be a
		// superset of the agent ids the batch references.
		var ownedCount int
		if err := tx.QueryRow(ctx, `
			SELECT count(DISTINCT id)
			FROM user_account
			WHERE id = ANY($1) AND is_agent = TRUE AND parent_user_id = $2
		`, agentIDs, actorID).Scan(&ownedCount); err != nil {
			return nil, fmt.Errorf("user_card_agent.set: validate ownership: %w", err)
		}
		// uniqueAgents := distinct count of agentIDs.
		seen := map[int64]bool{}
		for _, id := range agentIDs {
			seen[id] = true
		}
		if ownedCount != len(seen) {
			return nil, &reg.HandlerError{Code: "forbidden",
				Message: fmt.Sprintf("user_card_agent.set: one or more agent_user_ids are not agents owned by actor %d", actorID)}
		}

		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT * FROM jsonb_to_recordset($1::jsonb)
				AS x(card_id bigint, agent_user_id bigint)
			)
			INSERT INTO user_card_agent (user_id, card_id, agent_user_id)
			SELECT $2::bigint, i.card_id, i.agent_user_id FROM input i
			ON CONFLICT (user_id, card_id) DO UPDATE
				SET agent_user_id = EXCLUDED.agent_user_id
		`
		if _, err := tx.Exec(ctx, q, buf, actorID); err != nil {
			return nil, fmt.Errorf("user_card_agent.set: %w", err)
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

// runClear deletes the (actor, card_id) row. Idempotent.
func runClear(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		cardIDs := make([]int64, len(ins))
		for i, raw := range ins {
			in := raw.(ClearInput)
			if in.CardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "user_card_agent.clear: card_id is required"}
			}
			cardIDs[i] = in.CardID
		}
		rows, err := tx.Query(ctx, `
			DELETE FROM user_card_agent
			WHERE user_id = $1 AND card_id = ANY($2)
			RETURNING card_id
		`, actorID, cardIDs)
		if err != nil {
			return nil, fmt.Errorf("user_card_agent.clear: %w", err)
		}
		deleted := map[int64]bool{}
		for rows.Next() {
			var c int64
			if err := rows.Scan(&c); err != nil {
				rows.Close()
				return nil, err
			}
			deleted[c] = true
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if p != nil {
			p.NoteWrite()
		}
		outs := make([]any, len(ins))
		for i, raw := range ins {
			n := 0
			if deleted[raw.(ClearInput).CardID] {
				n = 1
			}
			outs[i] = ClearOutput{OK: n > 0, Deleted: n}
		}
		return outs, nil
	}
}

// runList returns the calling user's routings. ParentCardID filters
// down to one parent (typically a project) via a JOIN on card.parent_card_id.
func runList(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ListInput)
			var rows pgx.Rows
			var err error
			if in.ParentCardID != nil {
				rows, err = tx.Query(ctx, `
					SELECT uca.card_id, uca.agent_user_id, uca.created_at
					FROM user_card_agent uca
					JOIN card c ON c.id = uca.card_id
					WHERE uca.user_id = $1 AND c.parent_card_id = $2
					ORDER BY uca.created_at DESC
				`, actorID, *in.ParentCardID)
			} else {
				rows, err = tx.Query(ctx, `
					SELECT card_id, agent_user_id, created_at
					FROM user_card_agent
					WHERE user_id = $1
					ORDER BY created_at DESC
				`, actorID)
			}
			if err != nil {
				return nil, fmt.Errorf("user_card_agent.list: %w", err)
			}
			var out ListOutput
			for rows.Next() {
				var r ListRow
				var createdAt time.Time
				if err := rows.Scan(&r.CardID, &r.AgentUserID, &createdAt); err != nil {
					rows.Close()
					return nil, err
				}
				r.CreatedAt = createdAt.Format(time.RFC3339)
				out.Rows = append(out.Rows, r)
			}
			rows.Close()
			if err := rows.Err(); err != nil {
				return nil, err
			}
			outs[i] = out
		}
		return outs, nil
	}
}
