// comm_recipients — the participant list on a comm card.
//
// Recipients live on the comm itself (thread-level default) rather
// than per-reply: an operator picks them once in the Start-comm form
// or via the Edit-recipients affordance, and every outbound reply
// resolves the same list to the email To: header at send time.
//
// Inbound mail (imap.go) merges newly-seen senders / Cc addresses
// into this list via mergeCommRecipients so the participant set
// stays current as a thread evolves. Manual edits go through the
// comm.set_recipients handler below; the SMTP sender (smtp.go)
// reads recipients via loadCommRecipientEmails.

package comm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// CommSetRecipientsInput replaces the entire participant list on a
// comm card. Empty list is valid (clears the recipients).
type CommSetRecipientsInput struct {
	CommID             int64   `json:"comm_id,string" mcp:"required,desc=comm card id to edit"`
	RecipientPersonIDs reg.IDs `json:"recipient_person_ids" mcp:"required,desc=new participant list; each id must reference a person card. Pass [] to clear"`
}

// CommSetRecipientsOutput surfaces the resulting list count so the
// UI can render a confirmation without a re-fetch.
type CommSetRecipientsOutput struct {
	Count int `json:"count" mcp:"desc=number of distinct person card ids stored on comm_recipients after the write"`
}

func registerCommSetRecipients(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "comm",
		Action:       "set_recipients",
		Doc:          "Replace the comm_recipients participant list on a comm card. Pass an empty array to clear. Each id must reference a person card. Authz: worker / manager / admin (matches the manager grant on comm).",
		InputType:    reflect.TypeFor[CommSetRecipientsInput](),
		OutputType:   reflect.TypeFor[CommSetRecipientsOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromCommSetRecipientsInput,
		// Unified handler — body lives in
		// db/schema/functions/comm_set_recipients_batch.sql. Per
		// Phase 3 of docs/UNIFIED_HANDLER_PLAN.md the SQL function
		// now owns the full validate + write pipeline.
		SQLFunc: "comm_set_recipients_batch",
	})
}

// cardTypeFromCommSetRecipientsInput walks comm → parent task and
// returns the parent task's card_type so the dispatcher can
// scope-check against the actor's task-level grant. See
// `cardTypeFromReplyPostInput` (comm.go) for the seed-driven
// rationale — workers hold `card.update` on task, not comm.
func cardTypeFromCommSetRecipientsInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	commID := raw.(CommSetRecipientsInput).CommID
	var parentCardTypeID int64
	err := pool.QueryRow(ctx, `
		SELECT parent.card_type_id
		FROM card c
		JOIN card parent ON parent.id = c.parent_card_id
		WHERE c.id = $1
	`, commID).Scan(&parentCardTypeID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, nil
		}
		return 0, err
	}
	return parentCardTypeID, nil
}

// writeCommRecipients stores the supplied id list (already validated +
// deduped) on the comm card's comm_recipients attribute. Empty list
// becomes a `[]` jsonb value (clears the attribute meaningfully —
// reads still see "no recipients").
func writeCommRecipients(
	ctx context.Context,
	tx pgx.Tx,
	snap *schema.Snapshot,
	commID int64,
	ids []int64,
	actorID int64,
) error {
	ad, ok := snap.AttrByName["comm_recipients"]
	if !ok {
		return fmt.Errorf("writeCommRecipients: attribute_def comm_recipients missing")
	}
	if ids == nil {
		ids = []int64{}
	}
	raw, err := json.Marshal(ids)
	if err != nil {
		return err
	}
	return writeAttributeValue(ctx, tx, commID, ad.ID, raw, actorID)
}

// mergeCommRecipients reads the current comm_recipients list, unions
// in `add` (preserving existing order, appending the new ids in input
// order), and writes back when the set actually grew. Used by the
// IMAP parser to fold inbound senders / Cc addresses into a comm's
// participant list without losing prior participants.
func mergeCommRecipients(
	ctx context.Context,
	tx pgx.Tx,
	snap *schema.Snapshot,
	commID int64,
	add []int64,
	actorID int64,
) (added int, err error) {
	if len(add) == 0 {
		return 0, nil
	}
	cur, _, err := readAttributeValueRaw(ctx, tx, commID, "comm_recipients")
	if err != nil {
		return 0, err
	}
	existing := decodeCardRefArray(cur)
	seen := make(map[int64]struct{}, len(existing)+len(add))
	for _, id := range existing {
		seen[id] = struct{}{}
	}
	merged := append([]int64(nil), existing...)
	for _, id := range add {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		merged = append(merged, id)
		added++
	}
	if added == 0 {
		return 0, nil
	}
	if err := writeCommRecipients(ctx, tx, snap, commID, merged, actorID); err != nil {
		return 0, err
	}
	return added, nil
}

