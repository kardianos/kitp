// Package agent exposes the agent lifecycle handlers — agent.create and
// agent.delete. Agents are first-class user_account rows with
// parent_user_id pointing at their parent and is_agent=true; each agent
// also owns a 1:1 person card (so it can be assigned via the normal
// flow) linked through user_account_person.
//
// Authz model:
//   - agent.create: actor must NOT be an agent. The new agent's
//     parent_user_id is set to the actor's id — every user can create
//     agents under themselves. (The wider escalation guard sits in
//     user_role.set: admin is never grantable to agents.)
//   - agent.delete: actor must NOT be an agent. Actor must be the
//     target's parent_user_id OR a global admin. user_account ON DELETE
//     CASCADE wipes session, user_token, user_card_agent, user_card_sort,
//     and user_account_person rows automatically; we explicitly delete
//     the person card too because the cascade only goes the other way
//     (card → link, not user_account → card).
//
// Role-grant and token mint flows are NOT here. user_role.set already
// implements the parent-grants-subset-of-own-roles rule; user_token.*
// lives in its own package (#45).
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// CreateInput is one row of agent.create.
type CreateInput struct {
	DisplayName string `json:"display_name" mcp:"required,desc=display name shown in the UI and on activity rows"`
}

// CreateOutput identifies the freshly-minted agent + its person card.
type CreateOutput struct {
	UserID       int64 `json:"user_id,string" mcp:"desc=user_account id for the new agent"`
	PersonCardID int64 `json:"person_card_id,string" mcp:"desc=card id of the agent's person card; use this when writing card_ref attributes (assignee, …)"`
}

// DeleteInput is one row of agent.delete.
type DeleteInput struct {
	UserID int64 `json:"user_id,string" mcp:"required,desc=user_account id of the agent to remove"`
}

// DeleteOutput acknowledges; reports whether a row actually went away.
type DeleteOutput struct {
	OK      bool `json:"ok" mcp:"desc=true when the agent was deleted"`
	Deleted int  `json:"deleted" mcp:"desc=number of user_account rows removed (0 or 1)"`
}

// Register wires both handlers.
func Register(p *store.Pool) {
	authzPool = p
	reg.Register(reg.Handler{
		Endpoint:     "agent",
		Action:       "create",
		Doc:          "Create an agent owned by the calling user. Inserts user_account (is_agent=true, parent_user_id=actor) + a 1:1 person card + the user_account_person link in one tx. Rejects when the actor is itself an agent.",
		InputType:    reflect.TypeFor[CreateInput](),
		OutputType:   reflect.TypeFor[CreateOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzCreate,
		Run:          runCreate(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "agent",
		Action:       "delete",
		Doc:          "Delete an agent owned by the calling user (or by any admin). Cascades user_account_person, sessions, tokens, and user_card_agent rows. Rejects when the actor is itself an agent.",
		InputType:    reflect.TypeFor[DeleteInput](),
		OutputType:   reflect.TypeFor[DeleteOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Authz:        authzDelete,
		Run:          runDelete(p),
	})
}

// authzPool holds the pool the Authz hook closes over. Set by Register.
var authzPool any

// authzCreate: actor must not be an agent. No admin requirement —
// any signed-in user can spawn agents under themselves.
func authzCreate(ctx context.Context, _ any) error {
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil // tests
	}
	return rejectAgentActor(ctx, pool, auth.ActorOrSystem(ctx))
}

// authzDelete: actor must not be an agent AND must be either the
// target's parent_user_id or a global admin.
func authzDelete(ctx context.Context, in any) error {
	row, ok := in.(DeleteInput)
	if !ok {
		return nil
	}
	pool, _ := authzPool.(*store.Pool)
	if pool == nil {
		return nil
	}
	actor := auth.ActorOrSystem(ctx)
	if err := rejectAgentActor(ctx, pool, actor); err != nil {
		return err
	}
	var isAgent bool
	var parentID *int64
	err := pool.P.QueryRow(ctx,
		`SELECT is_agent, parent_user_id FROM user_account WHERE id = $1`,
		row.UserID,
	).Scan(&isAgent, &parentID)
	if err != nil {
		if err == pgx.ErrNoRows {
			return &reg.HandlerError{Code: "not_found",
				Message: fmt.Sprintf("agent.delete: user %d not found", row.UserID)}
		}
		return fmt.Errorf("agent.delete: lookup target: %w", err)
	}
	if !isAgent {
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("agent.delete: user %d is not an agent", row.UserID)}
	}
	if parentID != nil && *parentID == actor {
		return nil
	}
	// Fall back to global admin check.
	var n int
	row2 := pool.P.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur JOIN role r ON r.id = ur.role_id
		WHERE ur.user_id = $1 AND r.name IN ('admin','system') AND ur.scope_card_id IS NULL
	`, actor)
	if err := row2.Scan(&n); err != nil {
		return fmt.Errorf("agent.delete: admin check: %w", err)
	}
	if n == 0 {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("agent.delete: actor %d is not the parent of agent %d nor a global admin", actor, row.UserID)}
	}
	return nil
}

// rejectAgentActor returns a non-nil error when the actor itself is an
// agent. Agents cannot manage the agent lifecycle (mirrors the gate in
// userrole package).
func rejectAgentActor(ctx context.Context, pool *store.Pool, actor int64) error {
	var actorIsAgent bool
	err := pool.P.QueryRow(ctx,
		`SELECT is_agent FROM user_account WHERE id = $1`,
		actor,
	).Scan(&actorIsAgent)
	if err != nil {
		return fmt.Errorf("agent.authz: load actor: %w", err)
	}
	if actorIsAgent {
		return &reg.HandlerError{Code: "forbidden",
			Message: fmt.Sprintf("agent: agent actor %d cannot manage the agent lifecycle", actor)}
	}
	return nil
}

// runCreate inserts user_account + person card + title attribute_value
// + user_account_person link in a single CTE. Activity rows match what
// card.insert would emit so the agent's creation shows up in the stream
// with the right (card_create, attr_update) pair.
func runCreate(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		// One CTE per Run handles every input row. jsonb_to_recordset
		// keeps the per-row binding clean; ord aligns the returned ids
		// back to the input order.
		type jsonRow struct {
			Ord         int    `json:"ord"`
			DisplayName string `json:"display_name"`
		}
		payload := make([]jsonRow, len(ins))
		for i, raw := range ins {
			in := raw.(CreateInput)
			payload[i] = jsonRow{Ord: i, DisplayName: in.DisplayName}
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT ord, display_name FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, display_name text)
			),
			ins_user AS (
				INSERT INTO user_account (display_name, parent_user_id, is_agent)
				SELECT display_name, $2, TRUE FROM input ORDER BY ord
				RETURNING id, display_name
			),
			user_numbered AS (
				SELECT id, display_name, row_number() OVER (ORDER BY id) AS rn
				FROM ins_user
			),
			input_numbered AS (
				SELECT ord, row_number() OVER (ORDER BY ord) AS rn FROM input
			),
			zipped AS (
				SELECT i.ord, u.id AS user_id, u.display_name
				FROM input_numbered i JOIN user_numbered u ON u.rn = i.rn
			),
			ins_card AS (
				INSERT INTO card (card_type_id, parent_card_id)
				SELECT (SELECT id FROM card_type WHERE name='person'), NULL
				FROM zipped ORDER BY ord
				RETURNING id
			),
			card_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_card
			),
			ins_link AS (
				INSERT INTO user_account_person (user_account_id, person_card_id)
				SELECT z.user_id, c.id
				FROM zipped z JOIN card_numbered c ON c.rn = z.ord + 1
				RETURNING user_account_id, person_card_id
			),
			ins_create_act AS (
				INSERT INTO activity (card_id, kind, actor_id)
				SELECT c.id, 'card_create', $2
				FROM card_numbered c ORDER BY c.id
				RETURNING id, card_id
			),
			ins_title_act AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT c.id, 'attr_update',
				       (SELECT id FROM attribute_def WHERE name='title'),
				       NULL,
				       to_jsonb(z.display_name),
				       $2
				FROM card_numbered c
				JOIN zipped z ON z.ord + 1 = c.rn
				ORDER BY c.id
				RETURNING id, card_id, value_new
			),
			ins_title_val AS (
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT card_id, (SELECT id FROM attribute_def WHERE name='title'), value_new, id
				FROM ins_title_act
				RETURNING card_id
			)
			SELECT z.ord, z.user_id, c.id AS person_card_id
			FROM zipped z JOIN card_numbered c ON c.rn = z.ord + 1
			ORDER BY z.ord
		`
		rows, err := tx.Query(ctx, q, buf, actorID)
		if err != nil {
			return nil, fmt.Errorf("agent.create: %w", err)
		}
		defer rows.Close()
		outs := make([]any, len(ins))
		for rows.Next() {
			var ord int
			var userID, cardID int64
			if err := rows.Scan(&ord, &userID, &cardID); err != nil {
				return nil, err
			}
			if ord < 0 || ord >= len(ins) {
				return nil, fmt.Errorf("agent.create: ord %d out of range", ord)
			}
			outs[ord] = CreateOutput{UserID: userID, PersonCardID: cardID}
		}
		return outs, rows.Err()
	}
}

// runDelete removes agent user_account rows along with every row that
// references them: activity (actor + person-card targets),
// attribute_value (person-card values), and finally the user_account
// itself plus its person card. user_account cascade clears session,
// user_token, user_card_agent, user_card_sort, and user_account_person
// automatically — the explicit deletes here only cover the
// NO-ACTION-FK tables where pg refuses to cascade.
//
// Order:
//   1. Snapshot user_account_person so we know the person card ids
//      before the cascade wipes the link rows.
//   2. Delete activity where actor_id = any-agent OR card_id =
//      any-person-card.
//   3. Delete attribute_value where card_id = any-person-card.
//   4. Delete user_account (gated on is_agent=TRUE).
//   5. Delete the orphan person cards belonging to successfully-deleted
//      agents.
func runDelete(_ *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		ids := make([]int64, len(ins))
		for i, raw := range ins {
			ids[i] = raw.(DeleteInput).UserID
		}

		// 1. Look up person cards via the link rows that the cascade is
		//    about to wipe.
		rows, err := tx.Query(ctx, `
			SELECT user_account_id, person_card_id
			FROM user_account_person
			WHERE user_account_id = ANY($1)
		`, ids)
		if err != nil {
			return nil, fmt.Errorf("agent.delete: lookup persons: %w", err)
		}
		cardByUser := map[int64]int64{}
		for rows.Next() {
			var u, c int64
			if err := rows.Scan(&u, &c); err != nil {
				rows.Close()
				return nil, err
			}
			cardByUser[u] = c
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		personCards := make([]int64, 0, len(cardByUser))
		for _, c := range cardByUser {
			personCards = append(personCards, c)
		}

		// 2. Wipe attribute_value rows for the agent's person cards —
		//    NO ACTION FK on attribute_value.card_id would block the
		//    card delete otherwise. Done BEFORE clearing activity so
		//    we don't trip attribute_value.last_activity_id when
		//    activity rows referenced by those (now-removed) values
		//    go away in step 3.
		if len(personCards) > 0 {
			if _, err := tx.Exec(ctx, `
				DELETE FROM attribute_value WHERE card_id = ANY($1)
			`, personCards); err != nil {
				return nil, fmt.Errorf("agent.delete: clear attribute_value: %w", err)
			}
		}

		// 3. Null out attribute_value.last_activity_id for any
		//    *remaining* rows still pointing at activity rows we're
		//    about to delete (e.g. activity rows where actor_id =
		//    agent but card_id is some other card the agent acted on).
		//    The column is nullable so this is safe — losing the
		//    last-actor pointer is a small price for being able to
		//    remove the agent.
		if _, err := tx.Exec(ctx, `
			UPDATE attribute_value SET last_activity_id = NULL
			WHERE last_activity_id IN (
				SELECT id FROM activity
				WHERE actor_id = ANY($1) OR card_id = ANY($2)
			)
		`, ids, personCards); err != nil {
			return nil, fmt.Errorf("agent.delete: null last_activity_id: %w", err)
		}

		// 4. Wipe activity rows referencing either the agent (as actor)
		//    or the agent's person card (as subject).
		if _, err := tx.Exec(ctx, `
			DELETE FROM activity WHERE actor_id = ANY($1) OR card_id = ANY($2)
		`, ids, personCards); err != nil {
			return nil, fmt.Errorf("agent.delete: clear activity: %w", err)
		}

		// 5. Delete user_account rows. Cascade clears session,
		//    user_token, user_card_agent (both sides), user_card_sort,
		//    and user_account_person. Gate on is_agent=TRUE so a stray
		//    id (deleted, or a non-agent user) is reported as 0.
		delRows, err := tx.Query(ctx, `
			DELETE FROM user_account
			WHERE id = ANY($1) AND is_agent = TRUE
			RETURNING id
		`, ids)
		if err != nil {
			return nil, fmt.Errorf("agent.delete: delete user_account: %w", err)
		}
		deleted := map[int64]bool{}
		for delRows.Next() {
			var id int64
			if err := delRows.Scan(&id); err != nil {
				delRows.Close()
				return nil, err
			}
			deleted[id] = true
		}
		delRows.Close()
		if err := delRows.Err(); err != nil {
			return nil, err
		}

		// 6. Sweep person cards owned by successfully-deleted agents.
		//    Skip ones whose user_account row wasn't actually removed
		//    (e.g. non-agent target slipped past the lookup) so we
		//    don't orphan a real user's person card.
		var orphanCards []int64
		for u, c := range cardByUser {
			if deleted[u] {
				orphanCards = append(orphanCards, c)
			}
		}
		if len(orphanCards) > 0 {
			if _, err := tx.Exec(ctx, `DELETE FROM card WHERE id = ANY($1)`, orphanCards); err != nil {
				return nil, fmt.Errorf("agent.delete: delete person cards: %w", err)
			}
		}

		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(DeleteInput)
			n := 0
			if deleted[in.UserID] {
				n = 1
			}
			outs[i] = DeleteOutput{OK: n > 0, Deleted: n}
		}
		return outs, nil
	}
}
