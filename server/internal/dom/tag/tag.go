// Package tag implements tag.apply / tag.remove. Tags are CARDs of
// type 'tag' with two built-in attributes: 'path' (slash-delimited) and
// 'root_exclusive_at' (the prefix at which the tag is mutually exclusive
// with sibling tags). Applying/removing a tag mutates the target card's
// 'tags' attribute (a jsonb array of tag card ids).
//
// All state changes route through attribute_value + activity, just like
// every other domain write.
package tag

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ApplyInput is one (target, tag) pair to apply.
type ApplyInput struct {
	TargetCardID int64 `json:"target_card_id" mcp:"required,desc=id of the card receiving the tag"`
	TagCardID    int64 `json:"tag_card_id" mcp:"required,desc=id of the tag card to apply"`
}

// ApplyOutput acknowledges success.
type ApplyOutput struct {
	OK         bool    `json:"ok" mcp:"desc=true on success"`
	ActivityID int64   `json:"activity_id" mcp:"desc=id of the activity row recording the apply"`
	RemovedTagIDs []int64 `json:"removed_tag_ids,omitempty" mcp:"desc=ids of sibling tags removed by mutual exclusion"`
}

// RemoveInput is one (target, tag) pair to remove.
type RemoveInput struct {
	TargetCardID int64 `json:"target_card_id" mcp:"required,desc=id of the card to remove the tag from"`
	TagCardID    int64 `json:"tag_card_id" mcp:"required,desc=id of the tag card to remove"`
}

// RemoveOutput acknowledges success.
type RemoveOutput struct {
	OK         bool  `json:"ok" mcp:"desc=true on success"`
	ActivityID int64 `json:"activity_id" mcp:"desc=id of the activity row recording the removal"`
}

// Register installs tag.apply and tag.remove.
func Register(p *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "tag",
		Action:       "apply",
		Doc:          "Apply a tag card to a target card; mutually-exclusive sibling tags at the same root are removed atomically.",
		InputType:    reflect.TypeFor[ApplyInput](),
		OutputType:   reflect.TypeFor[ApplyOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runApply(p),
	})
	reg.Register(reg.Handler{
		Endpoint:     "tag",
		Action:       "remove",
		Doc:          "Remove a tag card from a target card.",
		InputType:    reflect.TypeFor[RemoveInput](),
		OutputType:   reflect.TypeFor[RemoveOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		Run:          runRemove(p),
	})
}

// runApply is an arrayPath writer. It groups inputs and computes the new
// 'tags' value per target in Go (cheap, since attribute_value rows are
// small) then issues ONE coalesced upsert+activity statement. // arrayPath
func runApply(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		tagsAttr, ok := snap.AttrByName["tags"]
		if !ok {
			return nil, fmt.Errorf("tag.apply: 'tags' attribute_def missing (run migration 0003)")
		}

		// Validate inputs and collect:
		//  - target -> current tag id list
		//  - tag id -> path and root_exclusive_at
		targetIDs := make(map[int64]struct{})
		tagIDs := make(map[int64]struct{})
		for i, raw := range ins {
			in := raw.(ApplyInput)
			if in.TargetCardID == 0 || in.TagCardID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "tag.apply: target_card_id and tag_card_id are required"}
			}
			targetIDs[in.TargetCardID] = struct{}{}
			tagIDs[in.TagCardID] = struct{}{}
		}

		// Confirm targets exist and have a card_type that allows the 'tags' edge.
		targetTypes := map[int64]int32{}
		{
			ids := keysInt64(targetIDs)
			rows, err := tx.Query(ctx, `SELECT id, card_type_id FROM card WHERE id = ANY($1::bigint[])`, ids)
			if err != nil {
				return nil, fmt.Errorf("tag.apply: target lookup: %w", err)
			}
			for rows.Next() {
				var id int64
				var ctid int32
				if err := rows.Scan(&id, &ctid); err != nil {
					rows.Close()
					return nil, err
				}
				targetTypes[id] = ctid
			}
			rows.Close()
		}
		// Validate tag cards (must be card_type 'tag') and load their attributes.
		tagPath := map[int64]string{}
		tagRoot := map[int64]string{}
		{
			ids := keysInt64(tagIDs)
			pathID, ok := snap.AttrByName["path"]
			if !ok {
				return nil, fmt.Errorf("tag.apply: 'path' attribute_def missing")
			}
			rootID := snap.AttrByName["root_exclusive_at"]
			rows, err := tx.Query(ctx, `
				SELECT c.id,
				       (SELECT av.value FROM attribute_value av
				          WHERE av.card_id=c.id AND av.attribute_def_id=$2) AS path_v,
				       (SELECT av.value FROM attribute_value av
				          WHERE av.card_id=c.id AND av.attribute_def_id=$3) AS root_v
				FROM card c
				JOIN card_type ct ON ct.id = c.card_type_id
				WHERE c.id = ANY($1::bigint[]) AND ct.name='tag'
			`, ids, pathID.ID, rootID.ID)
			if err != nil {
				return nil, fmt.Errorf("tag.apply: tag lookup: %w", err)
			}
			for rows.Next() {
				var id int64
				var pathRaw, rootRaw []byte
				if err := rows.Scan(&id, &pathRaw, &rootRaw); err != nil {
					rows.Close()
					return nil, err
				}
				tagPath[id] = jsonStr(pathRaw)
				tagRoot[id] = jsonStr(rootRaw)
			}
			rows.Close()
		}

		// Validate every input.
		for i, raw := range ins {
			in := raw.(ApplyInput)
			ctid, ok := targetTypes[in.TargetCardID]
			if !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "card_not_found",
					Message: fmt.Sprintf("tag.apply: target card %d not found", in.TargetCardID)}
			}
			if _, ok := snap.AllowedAttrs[ctid][tagsAttr.ID]; !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "edge_violation",
					Message: fmt.Sprintf("tag.apply: card_type id=%d does not allow 'tags'", ctid)}
			}
			if _, ok := tagPath[in.TagCardID]; !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "tag_not_found",
					Message: fmt.Sprintf("tag.apply: tag card %d not found or not a tag", in.TagCardID)}
			}
		}

		// Load current tags arrays for every target in one query.
		currentTags := map[int64][]int64{}
		{
			ids := keysInt64(targetIDs)
			rows, err := tx.Query(ctx, `
				SELECT av.card_id, av.value
				FROM attribute_value av
				WHERE av.attribute_def_id = $1 AND av.card_id = ANY($2::bigint[])
			`, tagsAttr.ID, ids)
			if err != nil {
				return nil, fmt.Errorf("tag.apply: current tags: %w", err)
			}
			for rows.Next() {
				var cid int64
				var raw []byte
				if err := rows.Scan(&cid, &raw); err != nil {
					rows.Close()
					return nil, err
				}
				var arr []int64
				if len(raw) > 0 && string(raw) != "null" {
					_ = json.Unmarshal(raw, &arr)
				}
				currentTags[cid] = arr
			}
			rows.Close()
		}

		// Augment tagPath / tagRoot with metadata for any pre-existing tag
		// already on any target — we need their path to evaluate the
		// mutual-exclusion rule against the tag being applied.
		extraIDs := map[int64]struct{}{}
		for _, arr := range currentTags {
			for _, tid := range arr {
				if _, have := tagPath[tid]; !have {
					extraIDs[tid] = struct{}{}
				}
			}
		}
		if len(extraIDs) > 0 {
			pathID := snap.AttrByName["path"].ID
			rootID := snap.AttrByName["root_exclusive_at"].ID
			rows, err := tx.Query(ctx, `
				SELECT c.id,
				       (SELECT av.value FROM attribute_value av
				          WHERE av.card_id=c.id AND av.attribute_def_id=$2) AS path_v,
				       (SELECT av.value FROM attribute_value av
				          WHERE av.card_id=c.id AND av.attribute_def_id=$3) AS root_v
				FROM card c
				WHERE c.id = ANY($1::bigint[])
			`, keysInt64(extraIDs), pathID, rootID)
			if err != nil {
				return nil, fmt.Errorf("tag.apply: existing tag lookup: %w", err)
			}
			for rows.Next() {
				var id int64
				var pathRaw, rootRaw []byte
				if err := rows.Scan(&id, &pathRaw, &rootRaw); err != nil {
					rows.Close()
					return nil, err
				}
				tagPath[id] = jsonStr(pathRaw)
				tagRoot[id] = jsonStr(rootRaw)
			}
			rows.Close()
		}

		// Compute new tag arrays per input. Track removed tag ids per input
		// for the response. After processing all inputs, we have the final
		// state per target; one upsert/activity per target+input.
		// Per input, emit a separate activity row (so the activity stream
		// shows individual apply events) and end with one upsert per
		// distinct target, but carrying the final state.
		//
		// Simpler model: process inputs sequentially; each input produces
		// (target_id, new_value, removed) and one activity row. The final
		// upsert collapses repeated targets into the latest value.
		type step struct {
			InputIndex int
			TargetID   int64
			ValueOld   []int64
			ValueNew   []int64
			Removed    []int64
		}
		steps := make([]step, len(ins))
		for i, raw := range ins {
			in := raw.(ApplyInput)
			cur := append([]int64(nil), currentTags[in.TargetCardID]...)
			old := append([]int64(nil), cur...)
			// Add (idempotent: if already present, dedupe).
			if !slices.Contains(cur, in.TagCardID) {
				cur = append(cur, in.TagCardID)
			}
			// Apply mutual-exclusion at root, if any.
			var removed []int64
			if root := tagRoot[in.TagCardID]; root != "" {
				newCur := cur[:0]
				for _, tid := range cur {
					if tid == in.TagCardID {
						newCur = append(newCur, tid)
						continue
					}
					p := tagPath[tid]
					if pathRoot(p) == root {
						removed = append(removed, tid)
						continue
					}
					newCur = append(newCur, tid)
				}
				cur = newCur
			}
			steps[i] = step{InputIndex: i, TargetID: in.TargetCardID, ValueOld: old, ValueNew: cur, Removed: removed}
			currentTags[in.TargetCardID] = cur // chain for next input on the same target
		}

		// Emit one activity row per step (kind='tag_apply' with value_old / value_new),
		// upsert the final attribute_value per distinct target.
		// We do it in two statements: one INSERT activity, one upsert via
		// COALESCE of latest. Actually we can do it in one CTE.
		type jsonStep struct {
			Ord       int    `json:"ord"`
			TargetID  int64  `json:"target_id"`
			ValueOld  string `json:"value_old"`  // jsonb-as-text
			ValueNew  string `json:"value_new"`
			TagCardID int64  `json:"tag_card_id"`
		}
		spayload := make([]jsonStep, len(steps))
		for i, s := range steps {
			oldB, _ := json.Marshal(s.ValueOld)
			newB, _ := json.Marshal(s.ValueNew)
			spayload[i] = jsonStep{
				Ord:       i,
				TargetID:  s.TargetID,
				ValueOld:  string(oldB),
				ValueNew:  string(newB),
				TagCardID: ins[i].(ApplyInput).TagCardID,
			}
		}
		buf, err := json.Marshal(spayload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT ord, target_id, value_old::jsonb AS value_old, value_new::jsonb AS value_new, tag_card_id
				FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, target_id bigint, value_old text, value_new text, tag_card_id bigint)
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT target_id, 'tag_apply', $2, value_old, value_new, $3
				FROM input
				ORDER BY ord
				RETURNING id, card_id
			),
			act_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			input_numbered AS (
				SELECT input.*, row_number() OVER (ORDER BY ord) AS rn FROM input
			),
			zipped AS (
				SELECT i.ord, i.target_id, i.value_new, a.id AS activity_id
				FROM act_numbered a
				JOIN input_numbered i ON i.rn = a.rn
			),
			-- Per target, pick the row with the highest ord (the last write wins).
			latest AS (
				SELECT DISTINCT ON (target_id) target_id, value_new, activity_id
				FROM zipped
				ORDER BY target_id, ord DESC
			),
			upsert AS (
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT target_id, $2, value_new, activity_id FROM latest
				ON CONFLICT (card_id, attribute_def_id) DO UPDATE
					SET value = EXCLUDED.value,
					    last_activity_id = EXCLUDED.last_activity_id
				RETURNING card_id
			)
			SELECT ord, activity_id FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf, tagsAttr.ID, actorID)
		if err != nil {
			return nil, fmt.Errorf("tag.apply: %w", err)
		}
		outs := make([]any, len(ins))
		for rows.Next() {
			var ord int
			var actID int64
			if err := rows.Scan(&ord, &actID); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord] = ApplyOutput{
				OK:            true,
				ActivityID:    actID,
				RemovedTagIDs: steps[ord].Removed,
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// runRemove is an arrayPath writer. // arrayPath
func runRemove(p *store.Pool) func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		snap, err := schema.Load(ctx, tx)
		if err != nil {
			return nil, err
		}
		tagsAttr, ok := snap.AttrByName["tags"]
		if !ok {
			return nil, fmt.Errorf("tag.remove: 'tags' attribute_def missing")
		}

		// Load current arrays for every distinct target.
		targetIDs := map[int64]struct{}{}
		for _, raw := range ins {
			in := raw.(RemoveInput)
			if in.TargetCardID == 0 {
				return nil, &reg.HandlerError{Code: "validation",
					Message: "tag.remove: target_card_id is required"}
			}
			targetIDs[in.TargetCardID] = struct{}{}
		}
		currentTags := map[int64][]int64{}
		{
			rows, err := tx.Query(ctx, `
				SELECT av.card_id, av.value
				FROM attribute_value av
				WHERE av.attribute_def_id = $1 AND av.card_id = ANY($2::bigint[])
			`, tagsAttr.ID, keysInt64(targetIDs))
			if err != nil {
				return nil, fmt.Errorf("tag.remove: current tags: %w", err)
			}
			for rows.Next() {
				var cid int64
				var raw []byte
				if err := rows.Scan(&cid, &raw); err != nil {
					rows.Close()
					return nil, err
				}
				var arr []int64
				if len(raw) > 0 && string(raw) != "null" {
					_ = json.Unmarshal(raw, &arr)
				}
				currentTags[cid] = arr
			}
			rows.Close()
		}

		// Compute new arrays.
		type step struct {
			TargetID int64
			ValueOld []int64
			ValueNew []int64
		}
		steps := make([]step, len(ins))
		for i, raw := range ins {
			in := raw.(RemoveInput)
			cur := append([]int64(nil), currentTags[in.TargetCardID]...)
			old := append([]int64(nil), cur...)
			newCur := cur[:0]
			for _, tid := range cur {
				if tid != in.TagCardID {
					newCur = append(newCur, tid)
				}
			}
			steps[i] = step{TargetID: in.TargetCardID, ValueOld: old, ValueNew: newCur}
			currentTags[in.TargetCardID] = newCur
		}

		type jsonStep struct {
			Ord      int    `json:"ord"`
			TargetID int64  `json:"target_id"`
			ValueOld string `json:"value_old"`
			ValueNew string `json:"value_new"`
		}
		spayload := make([]jsonStep, len(steps))
		for i, s := range steps {
			oldB, _ := json.Marshal(s.ValueOld)
			newB, _ := json.Marshal(s.ValueNew)
			spayload[i] = jsonStep{Ord: i, TargetID: s.TargetID, ValueOld: string(oldB), ValueNew: string(newB)}
		}
		buf, err := json.Marshal(spayload)
		if err != nil {
			return nil, err
		}
		const q = `
			WITH input AS (
				SELECT ord, target_id, value_old::jsonb AS value_old, value_new::jsonb AS value_new
				FROM jsonb_to_recordset($1::jsonb)
				AS x(ord int, target_id bigint, value_old text, value_new text)
			),
			ins_act AS (
				INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
				SELECT target_id, 'tag_remove', $2, value_old, value_new, $3
				FROM input
				ORDER BY ord
				RETURNING id
			),
			act_numbered AS (
				SELECT id, row_number() OVER (ORDER BY id) AS rn FROM ins_act
			),
			input_numbered AS (
				SELECT input.*, row_number() OVER (ORDER BY ord) AS rn FROM input
			),
			zipped AS (
				SELECT i.ord, i.target_id, i.value_new, a.id AS activity_id
				FROM act_numbered a
				JOIN input_numbered i ON i.rn = a.rn
			),
			latest AS (
				SELECT DISTINCT ON (target_id) target_id, value_new, activity_id
				FROM zipped
				ORDER BY target_id, ord DESC
			),
			upsert AS (
				INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
				SELECT target_id, $2, value_new, activity_id FROM latest
				ON CONFLICT (card_id, attribute_def_id) DO UPDATE
					SET value = EXCLUDED.value,
					    last_activity_id = EXCLUDED.last_activity_id
				RETURNING card_id
			)
			SELECT ord, activity_id FROM zipped ORDER BY ord
		`
		rows, err := tx.Query(ctx, q, buf, tagsAttr.ID, actorID)
		if err != nil {
			return nil, fmt.Errorf("tag.remove: %w", err)
		}
		outs := make([]any, len(ins))
		for rows.Next() {
			var ord int
			var actID int64
			if err := rows.Scan(&ord, &actID); err != nil {
				rows.Close()
				return nil, err
			}
			outs[ord] = RemoveOutput{OK: true, ActivityID: actID}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func keysInt64(m map[int64]struct{}) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// pathRoot returns everything before the first '/' in p. For "priority/high"
// it returns "priority"; for "priority" it returns "priority".
func pathRoot(p string) string {
	for i := 0; i < len(p); i++ {
		if p[i] == '/' {
			return p[:i]
		}
	}
	return p
}

// jsonStr unmarshals a jsonb scalar value into a Go string. Returns "" if
// the value is null, missing, or not a string.
func jsonStr(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}
