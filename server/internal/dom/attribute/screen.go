// File attribute/screen.go: per-screen-attribute validation that runs
// inside the attribute.update transaction. Two attributes on the
// `screen` card_type need app-level uniqueness within the enclosing
// project scope:
//
//   - hotkey — single character keyboard chord (g <hotkey>) per project.
//   - slug   — URL token unique within the parent project. Also
//              validates regex ^[a-z][a-z0-9-]*$.
//
// Per V2 of docs/FLOW_AND_SCREEN_KERNEL.md, the check is a single
// query inside the same transaction so concurrent writes can't race
// past it. Rejection codes follow the established envelope:
//
//   - slug_invalid    — slug doesn't match the regex
//   - slug_in_use     — another screen in the same project owns the slug
//   - hotkey_in_use   — another screen in the same project owns the hotkey
//
// The dispatcher carries reg.HandlerError directly into the SubResponse
// envelope; no extra Detail payload is needed since the message names
// the conflicting screen.
package attribute


import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
)


// slugRE pins URL-safe screen slugs to lowercase letters, digits, and
// hyphens, with a letter lead. Mirrors the spec's regex literally.
var slugRE = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)

// screenUniquenessCheck runs inside the attribute.update tx before the
// UPSERT. If the (cardID, attributeName) tuple targets `slug` or
// `hotkey` on a screen card, the check confirms no sibling screen
// under the same parent project already owns the candidate value.
//
// Returns (nil, nil) when the check doesn't apply to this attribute.
// Returns (*reg.HandlerError, nil) for app-level rejections.
// Returns (nil, err) for query / decode failures.
//
// The check is intentionally O(1) per row: one indexed lookup of the
// card's parent + card_type, plus one EXISTS query against the
// existing attribute_value rows. Callers run this in a loop inside
// runUpdate before the bulk UPSERT.
func screenUniquenessCheck(
	ctx context.Context, tx pgx.Tx,
	cardID int64, attrName string, value json.RawMessage,
) (*reg.HandlerError, error) {
	if attrName != "slug" && attrName != "hotkey" {
		return nil, nil
	}
	if isJSONNull(value) {
		// Clearing a unique attribute is fine — nothing to dedupe.
		return nil, nil
	}
	// Resolve the candidate value as a string. Both `slug` and `hotkey`
	// are text attributes.
	var candidate string
	if err := json.Unmarshal(value, &candidate); err != nil {
		return &reg.HandlerError{Code: "validation",
			Message: fmt.Sprintf("attribute.update: %q must be a string", attrName)}, nil
	}
	// Confirm the target is a screen card and pick up its parent.
	var parentCardID *int64
	var cardTypeName string
	row := tx.QueryRow(ctx, `
		SELECT c.parent_card_id, ct.name
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.id = $1 AND c.deleted_at IS NULL
	`, cardID)
	if err := row.Scan(&parentCardID, &cardTypeName); err != nil {
		if err == pgx.ErrNoRows {
			// runUpdate would surface this as a constraint error anyway;
			// let the UPSERT handle it.
			return nil, nil
		}
		return nil, fmt.Errorf("attribute.update: lookup card for %s check: %w", attrName, err)
	}
	if cardTypeName != "screen" {
		// Attribute carries the same name on a non-screen card_type
		// (none today, but stay defensive). No uniqueness rule applies.
		return nil, nil
	}
	if parentCardID == nil {
		// A screen with no parent shouldn't exist (the screen card_type
		// requires a project parent), but if one shows up, the
		// uniqueness rule has no scope to apply against.
		return nil, nil
	}
	// slug also validates the regex.
	if attrName == "slug" {
		if !slugRE.MatchString(candidate) {
			return &reg.HandlerError{Code: "slug_invalid",
				Message: fmt.Sprintf("attribute.update: slug %q must match ^[a-z][a-z0-9-]*$", candidate)}, nil
		}
	}
	// hotkey value, when present, is intended to be one character. We
	// don't reject longer values here because the kernel stays
	// permissive — the UI is the canonical filter. The uniqueness
	// check still runs.
	if attrName == "hotkey" {
		// Allow trim-empty as a clear request even if the JSON was a
		// non-null empty string ("" → no hotkey set).
		if strings.TrimSpace(candidate) == "" {
			return nil, nil
		}
	}
	// V2 EXISTS query — single statement, runs in the open tx.
	// JSON-encode the candidate value to compare against attribute_value.value (jsonb).
	valueJSON, err := json.Marshal(candidate)
	if err != nil {
		return nil, fmt.Errorf("attribute.update: encode %s value: %w", attrName, err)
	}
	var conflictTitle *string
	row = tx.QueryRow(ctx, `
		SELECT COALESCE(
			(SELECT av_t.value #>> '{}'
			 FROM attribute_value av_t
			 JOIN attribute_def ad_t ON ad_t.id = av_t.attribute_def_id
			 WHERE av_t.card_id = c.id AND ad_t.name = 'title'),
			c.id::text
		)
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		JOIN card c ON c.id = av.card_id
		WHERE ad.name = $1
		  AND av.value = $2::jsonb
		  AND c.parent_card_id = $3
		  AND c.id <> $4
		  AND c.deleted_at IS NULL
		LIMIT 1
	`, attrName, string(valueJSON), *parentCardID, cardID)
	if err := row.Scan(&conflictTitle); err != nil {
		if err == pgx.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("attribute.update: %s uniqueness check: %w", attrName, err)
	}
	code := attrName + "_in_use"
	otherLabel := ""
	if conflictTitle != nil {
		otherLabel = *conflictTitle
	}
	return &reg.HandlerError{Code: code,
		Message: fmt.Sprintf("attribute.update: %s %q is already used by screen %q in this project",
			attrName, candidate, otherLabel)}, nil
}
