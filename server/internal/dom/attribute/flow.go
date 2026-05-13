// File attribute/flow.go: the flow-aware authorization branch for
// attribute.update (Gate 5 of docs/FLOW_AND_SCREEN_KERNEL.md).
//
// When an attribute has a flow bound in the card's enclosing project
// scope, writes are tightened by flow_step existence and per-actor role
// satisfaction. role_grant stays the outer gate; the flow check
// tightens the already-permitted path without replacing it.
//
// Rejection envelope (V13): both "no matching step" and "role
// insufficient" surface as structured *reg.HandlerError values with
// codes "flow_disallowed" / "flow_role_required" and a Detail payload
// carrying { from, attempted_to, available[] } so the client and MCP
// renderers can render positive-feedback affordances ("you can do X,
// ask a manager for Y") without making another round-trip.
//
// The available[] array is computed via flow.ListAvailableTransitions
// — the same helper that backs the read-side flow_step.list_for_card
// handler from Gate 4. One implementation, two call sites.
package attribute

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/flow"
	"github.com/kitp/kitp/server/internal/reg"
)

// flowRow is the minimal flow tuple validateFlow needs.
type flowRow struct {
	ID             int64
	AttributeDefID int64
}

// flowStepRow is the minimal flow_step tuple validateFlow needs.
type flowStepRow struct {
	ID             int64
	RequiresRoleID *int64
}

// flowEndpoint describes one side of a transition for the V13 rejection
// envelope (from / attempted_to). Matches the shape in the spec:
// `{ "id": "101", "label": "Doing", "phase": "active" }`.
type flowEndpoint struct {
	ID    int64  `json:"id,string"`
	Label string `json:"label"`
	Phase string `json:"phase"`
}

// flowAvailableTo is the per-row payload inside the V13 envelope's
// `available[]` array. The shape is intentionally narrow — the full
// AvailableTransition struct carries fields (sort_order, flow_name,
// attribute_def_name, …) the spec does not surface to clients on
// rejection. Reducing the surface here keeps the rejection payload
// focused on actionable choices.
type flowAvailableTo struct {
	StepID          int64        `json:"step_id,string"`
	To              flowEndpoint `json:"to"`
	Label           string       `json:"label"`
	YourRoleAllows  bool         `json:"your_role_allows"`
	RequiresRole    *string      `json:"requires_role"`
}

// flowRejectionDetail is the full V13 envelope payload that rides on
// `reg.HandlerError.Detail` for flow_disallowed / flow_role_required.
// The dispatcher serialises it verbatim into the SubResponse's
// ErrorEnvelope.Detail field. JSON shape exactly matches the spec.
type flowRejectionDetail struct {
	From         flowEndpoint      `json:"from"`
	AttemptedTo  flowEndpoint      `json:"attempted_to"`
	Available    []flowAvailableTo `json:"available"`
}

// validateFlow is the Gate 5 hook called from validateUpdate after the
// existing edge / required-removal / project-scope checks.
//
//   - Resolves the card's enclosing project; no project ⇒ no flow gate
//     applies (orphan or root card; the same shortcut Gate 4's
//     list_for_card uses).
//   - Looks up `flow` by (attribute_def_id, scope_card_id). No flow ⇒
//     attribute.update goes through unchanged (the normal demo today).
//   - Reads the card's current value on this attribute. A flow gates
//     transitions; missing prev value is a seed bug because the spec
//     pins flow-bound attributes as is_required=true (Gate 2).
//   - Parses the inbound new value as a card_ref id. The required-edge
//     check upstream already rejects null/missing.
//   - Looks up flow_step (flow_id, from=prev, to=new). Missing ⇒
//     reject with code "flow_disallowed" + structured V13 detail.
//   - If a role gate is present, checks actor roles (with the same
//     project / global / system bypass shape Gate 4 implements).
//     Insufficient ⇒ reject with code "flow_role_required" + V13 detail.
//
// On both rejections the `available[]` field is populated via
// flow.ListAvailableTransitions — same helper Gate 4's read-side
// handler uses. The MCP server consumes the identical envelope; only
// the renderer differs.
func validateFlow(
	ctx context.Context, pool reg.ValidationPool,
	cardID int64, attrName string, attrDefID int64, valueType string,
	rawValue json.RawMessage,
) error {
	// Flow gates only attributes whose value is a card_ref (the value
	// is a value-card id). card_ref[] makes no sense as a state machine
	// — a set of refs isn't a single state — so we shortcut.
	if valueType != "card_ref" {
		return nil
	}

	// Resolve enclosing project. No project ⇒ no flow applies.
	projectID, err := flow.ProjectIDForCard(ctx, pool, cardID)
	if err != nil {
		return fmt.Errorf("attribute.update: resolve project for card %d: %w", cardID, err)
	}
	if projectID == 0 {
		return nil
	}

	// Look up the flow row, if any.
	fl, err := lookupFlowForAttribute(ctx, pool, attrDefID, projectID)
	if err != nil {
		return fmt.Errorf("attribute.update: lookup flow: %w", err)
	}
	if fl == nil {
		// No flow on this (attribute_def, project) — attribute.update
		// goes through unchanged.
		return nil
	}

	// Read the current value the card holds for this attribute.
	prevID, err := readCurrentCardRefValue(ctx, pool, cardID, attrDefID)
	if err != nil {
		return fmt.Errorf("attribute.update: read prev value: %w", err)
	}
	if prevID == 0 {
		// Spec invariant: flow-bound attributes are required (Gate 2
		// flipped (task, status) to is_required=true). A missing prev
		// value at this point means the seed is broken — surface a
		// distinct code so the operator sees the cause.
		return &reg.HandlerError{
			Code:    "flow_invariant",
			Message: fmt.Sprintf("attribute.update: card %d has no current value for flow-bound attribute %q", cardID, attrName),
		}
	}

	// Parse the inbound new value as a card_ref id. The existing
	// required-edge check upstream already rejected null/missing, so
	// any error here is an input validation issue.
	valueIDs, err := ParseCardRefValue(attrName, rawValue)
	if err != nil {
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("attribute.update: %v", err)}
	}
	if len(valueIDs) == 0 {
		// Shouldn't happen for non-null card_ref values, but treat as
		// validation rather than reach for a flow code.
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("attribute.update: flow-bound attribute %q requires a value", attrName)}
	}
	newID := valueIDs[0]

	// Same value (no transition) is a no-op for the flow gate. The
	// underlying UPSERT still runs and lands a fresh activity row, but
	// no flow_step is needed to "transition" prev→prev.
	if newID == prevID {
		return nil
	}

	// Locate the flow_step.
	step, err := findFlowStep(ctx, pool, fl.ID, prevID, newID)
	if err != nil {
		return fmt.Errorf("attribute.update: find flow_step: %w", err)
	}
	actorID := auth.ActorOrSystem(ctx)

	if step == nil {
		// No matching step: build the V13 rejection envelope and
		// surface it as flow_disallowed.
		detail, derr := buildFlowRejectionDetail(ctx, pool, actorID, cardID, projectID, prevID, newID)
		if derr != nil {
			return fmt.Errorf("attribute.update: build rejection detail: %w", derr)
		}
		fromLabel := detail.From.Label
		if fromLabel == "" {
			fromLabel = fmt.Sprintf("%d", prevID)
		}
		toLabel := detail.AttemptedTo.Label
		if toLabel == "" {
			toLabel = fmt.Sprintf("%d", newID)
		}
		return &reg.HandlerError{
			Code: "flow_disallowed",
			Message: fmt.Sprintf("Cannot move %s from %q to %q.",
				attrName, fromLabel, toLabel),
			Detail: detail,
		}
	}

	// Step found. If it carries a requires_role_id, check actor.
	if step.RequiresRoleID != nil {
		ok, roleName, err := actorSatisfiesRole(ctx, pool, actorID, *step.RequiresRoleID, projectID)
		if err != nil {
			return fmt.Errorf("attribute.update: check role: %w", err)
		}
		if !ok {
			detail, derr := buildFlowRejectionDetail(ctx, pool, actorID, cardID, projectID, prevID, newID)
			if derr != nil {
				return fmt.Errorf("attribute.update: build rejection detail: %w", derr)
			}
			return &reg.HandlerError{
				Code: "flow_role_required",
				Message: fmt.Sprintf("attribute.update: transition requires role %q; actor does not hold it",
					roleName),
				Detail: detail,
			}
		}
	}
	return nil
}

// lookupFlowForAttribute returns the flow row gating (attribute_def_id,
// project) or nil if none exists. The unique constraint
// (attribute_def_id, scope_card_id) on `flow` (V18) makes this a single
// indexed lookup.
func lookupFlowForAttribute(ctx context.Context, pool reg.ValidationPool, attributeDefID, projectID int64) (*flowRow, error) {
	var fr flowRow
	row := pool.QueryRow(ctx, `
		SELECT id, attribute_def_id
		FROM flow
		WHERE attribute_def_id = $1 AND scope_card_id = $2
	`, attributeDefID, projectID)
	if err := row.Scan(&fr.ID, &fr.AttributeDefID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &fr, nil
}

// readCurrentCardRefValue returns the card_ref id currently held on
// (cardID, attributeDefID). Returns 0 if no row exists or the value
// isn't a JSON number (the canonical card_ref form). The dispatcher
// canonicalises writes so a row living in attribute_value always has
// a numeric JSON value for card_ref attributes — see the CASE in
// runUpdate's CTE.
func readCurrentCardRefValue(ctx context.Context, pool reg.ValidationPool, cardID, attributeDefID int64) (int64, error) {
	var v *int64
	row := pool.QueryRow(ctx, `
		SELECT
			CASE WHEN jsonb_typeof(value) = 'number' THEN (value)::text::bigint
			     ELSE NULL
			END
		FROM attribute_value
		WHERE card_id = $1 AND attribute_def_id = $2
	`, cardID, attributeDefID)
	if err := row.Scan(&v); err != nil {
		if err == pgx.ErrNoRows {
			return 0, nil
		}
		return 0, err
	}
	if v == nil {
		return 0, nil
	}
	return *v, nil
}

// findFlowStep returns the flow_step row for (flow_id, from, to) or nil
// if none exists. Pulls requires_role_id so the role gate can run
// without a second query.
func findFlowStep(ctx context.Context, pool reg.ValidationPool, flowID, fromID, toID int64) (*flowStepRow, error) {
	var fs flowStepRow
	row := pool.QueryRow(ctx, `
		SELECT id, requires_role_id
		FROM flow_step
		WHERE flow_id = $1 AND from_card_id = $2 AND to_card_id = $3
		LIMIT 1
	`, flowID, fromID, toID)
	if err := row.Scan(&fs.ID, &fs.RequiresRoleID); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, err
	}
	return &fs, nil
}

// actorSatisfiesRole returns (true, roleName) when the actor holds the
// supplied role globally (scope_card_id IS NULL), scoped to projectID,
// or holds the seeded `system` role globally (system bypass — same
// shape as Gate 4's list_for_card and the dispatcher's role gate).
// The roleName is returned for the rejection envelope so the UI / MCP
// can render "ask a manager".
//
// One query: pulls the target role's name and the satisfaction bit
// together. EXISTS-with-OR over the two clauses (system bypass /
// direct match) is cheap and stays consistent with how
// listAvailableTransitions evaluates `allowed`.
func actorSatisfiesRole(ctx context.Context, pool reg.ValidationPool, actorID, roleID, projectID int64) (bool, string, error) {
	var roleName string
	var ok bool
	row := pool.QueryRow(ctx, `
		SELECT
			r.name,
			(
				EXISTS (
					SELECT 1 FROM user_role ur
					JOIN role sr ON sr.id = ur.role_id
					WHERE ur.user_id = $1 AND sr.name = 'system' AND ur.scope_card_id IS NULL
				)
				OR EXISTS (
					SELECT 1 FROM user_role ur
					WHERE ur.user_id = $1 AND ur.role_id = $2
					  AND (ur.scope_card_id IS NULL OR ur.scope_card_id = $3)
				)
			) AS allowed
		FROM role r
		WHERE r.id = $2
	`, actorID, roleID, projectID)
	if err := row.Scan(&roleName, &ok); err != nil {
		if err == pgx.ErrNoRows {
			return false, "", fmt.Errorf("role %d not found", roleID)
		}
		return false, "", err
	}
	return ok, roleName, nil
}

// readValueCardEndpoint loads { id, label, phase } for one value card.
// Used to populate `from` / `attempted_to` on the V13 rejection
// envelope. A missing row returns the id with empty label/phase so the
// renderer can still show something.
func readValueCardEndpoint(ctx context.Context, pool reg.ValidationPool, cardID int64) (flowEndpoint, error) {
	out := flowEndpoint{ID: cardID}
	row := pool.QueryRow(ctx, `
		SELECT
			c.phase,
			COALESCE(av.value #>> '{}', '') AS title
		FROM card c
		LEFT JOIN attribute_def ad_title ON ad_title.name = 'title'
		LEFT JOIN attribute_value av
		  ON av.card_id          = c.id
		 AND av.attribute_def_id = ad_title.id
		WHERE c.id = $1 AND c.deleted_at IS NULL
	`, cardID)
	if err := row.Scan(&out.Phase, &out.Label); err != nil {
		if err == pgx.ErrNoRows {
			return out, nil
		}
		return out, err
	}
	return out, nil
}

// buildFlowRejectionDetail assembles the V13 positive-feedback
// envelope: { from, attempted_to, available[] }. `available[]` is
// computed via flow.ListAvailableTransitions on the same shape Gate 4
// returns to the read-side handler — one implementation, two call
// sites. The list is filtered down to the narrower flowAvailableTo
// shape the spec surfaces on rejection (no sort_order, no flow_name,
// no from-side metadata — the from side already lives on the envelope's
// top-level `from`).
func buildFlowRejectionDetail(
	ctx context.Context, pool reg.ValidationPool,
	actorID, cardID, projectID, prevID, newID int64,
) (*flowRejectionDetail, error) {
	from, err := readValueCardEndpoint(ctx, pool, prevID)
	if err != nil {
		return nil, fmt.Errorf("read from value-card %d: %w", prevID, err)
	}
	attemptedTo, err := readValueCardEndpoint(ctx, pool, newID)
	if err != nil {
		return nil, fmt.Errorf("read attempted_to value-card %d: %w", newID, err)
	}

	avail, err := flow.ListAvailableTransitions(ctx, pool, actorID, cardID, projectID)
	if err != nil {
		return nil, fmt.Errorf("list available transitions: %w", err)
	}
	out := make([]flowAvailableTo, 0, len(avail))
	for _, t := range avail {
		row := flowAvailableTo{
			StepID: t.ID,
			To: flowEndpoint{
				ID:    t.ToCardID,
				Label: t.ToLabel,
				Phase: t.ToPhase,
			},
			Label:          t.Label,
			YourRoleAllows: t.Allowed,
		}
		if t.RequiresRoleName != "" {
			rn := t.RequiresRoleName
			row.RequiresRole = &rn
		}
		out = append(out, row)
	}
	return &flowRejectionDetail{
		From:        from,
		AttemptedTo: attemptedTo,
		Available:   out,
	}, nil
}
