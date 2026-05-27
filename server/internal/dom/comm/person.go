// person.upsert_by_email and the shared upsertPersonByEmail helper.
//
// Lives in the comm package because both callers are comm-side: the
// recipient picker on the comms UI (via the dispatcher handler) and
// the IMAP inbound parser (via the in-process helper). Keeping the
// helper here avoids a `person → comm` import cycle when the parser
// materialises sender / Cc people from inbound headers.
//
// Matching is case-insensitive on the trimmed email string. New
// person cards are created at global scope (parent_card_id NULL,
// mirroring the seed's System person card) and tagged with
// person_kind so the assignee dropdowns can hide contacts.

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
	"github.com/kitp/kitp/server/internal/textnorm"
)

// PersonKindMember is the default kind for person cards created
// outside the comm flow (dev team, manual admin inserts). Treated as
// assignable.
const PersonKindMember = "member"

// PersonKindContact is set on person cards materialised from an email
// address — either by the recipient picker auto-create or by the IMAP
// parser. Excluded from assignee dropdowns.
const PersonKindContact = "contact"

// PersonUpsertByEmailInput is the wire payload for person.upsert_by_email.
type PersonUpsertByEmailInput struct {
	Email       string `json:"email" mcp:"required,desc=email address to find or create a person card for; matched case-insensitively against the person.email attribute"`
	DisplayName string `json:"display_name,omitempty" mcp:"desc=title for the new person card when no existing match is found; defaults to the email when empty"`
	Kind        string `json:"kind,omitempty" mcp:"desc=person_kind assigned to newly created person cards (one of 'member' | 'contact'); existing person cards are not reclassified; default 'contact'"`
}

// PersonUpsertByEmailOutput surfaces the resolved person id and a flag
// the caller can use to decide whether to render a "new contact added"
// toast.
type PersonUpsertByEmailOutput struct {
	PersonID int64 `json:"person_id,string" mcp:"desc=person card id (existing match or newly created row)"`
	Created  bool  `json:"created" mcp:"desc=true when a fresh person card was inserted; false when an existing card matched the email"`
}

// upsertPersonByEmail finds an existing person card by case-insensitive
// email match, or creates a new global person card with the supplied
// display name + email + kind. Returns the id and whether it was
// freshly inserted. Used by both the dispatcher handler and the IMAP
// parser; running both through the same helper keeps the upsert rules
// in one place.
func upsertPersonByEmail(
	ctx context.Context,
	tx pgx.Tx,
	snap *schema.Snapshot,
	email, displayName, kindIfNew string,
	actorID int64,
) (int64, bool, error) {
	// NFC + lowercase so visually identical addresses ("Foo@x.com",
	// "foo@x.com", composed-vs-decomposed forms of an accented
	// local-part) collapse to the same lookup key — otherwise two
	// person cards would land for the same human.
	trimmed := textnorm.Email(email)
	if trimmed == "" {
		return 0, false, fmt.Errorf("upsertPersonByEmail: email is empty")
	}

	personCTID, err := resolveCardType(snap, "person")
	if err != nil {
		return 0, false, err
	}
	titleADID, err := resolveAttr(snap, "title")
	if err != nil {
		return 0, false, err
	}
	emailADID, err := resolveAttr(snap, "email")
	if err != nil {
		return 0, false, err
	}
	kindADID, err := resolveAttr(snap, "person_kind")
	if err != nil {
		return 0, false, err
	}

	var existing int64
	err = tx.QueryRow(ctx, `
		SELECT av.card_id
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		JOIN card c ON c.id = av.card_id
		WHERE ad.id = $1
		  AND c.card_type_id = $2
		  AND c.deleted_at IS NULL
		  AND lower(av.value #>> '{}') = lower($3)
		ORDER BY av.card_id
		LIMIT 1
	`, emailADID, personCTID, trimmed).Scan(&existing)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return 0, false, fmt.Errorf("upsertPersonByEmail: lookup: %w", err)
	}
	if existing != 0 {
		return existing, false, nil
	}

	kind := kindIfNew
	if kind == "" {
		kind = PersonKindContact
	}
	// Title is a display field — NFC only (no case folding) so the
	// user's casing intent (e.g. "Müller" vs "MÜLLER") is preserved.
	title := textnorm.Name(displayName)
	if title == "" {
		title = trimmed
	}

	var newID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id) VALUES ($1, NULL) RETURNING id
	`, personCTID).Scan(&newID); err != nil {
		return 0, false, fmt.Errorf("upsertPersonByEmail: insert card: %w", err)
	}
	if err := writeCardCreateActivity(ctx, tx, newID, actorID); err != nil {
		return 0, false, fmt.Errorf("upsertPersonByEmail: activity: %w", err)
	}
	jstr := func(s string) json.RawMessage { b, _ := json.Marshal(s); return b }
	for _, w := range []struct {
		ad  int64
		val json.RawMessage
	}{
		{titleADID, jstr(title)},
		{emailADID, jstr(trimmed)},
		{kindADID, jstr(kind)},
	} {
		if err := writeAttributeValue(ctx, tx, newID, w.ad, w.val, actorID); err != nil {
			return 0, false, fmt.Errorf("upsertPersonByEmail: write attr: %w", err)
		}
	}
	return newID, true, nil
}

// person.upsert_by_email is migrated to
// db/schema/functions/person_upsert_by_email_batch.sql per Phase 3 of
// docs/UNIFIED_HANDLER_PLAN.md. The in-process upsertPersonByEmail
// helper above stays because the IMAP parser materialises contact
// persons in the same tx (avoids a person → comm import cycle).

// PersonCreateInput is the admin-side handler for the People admin
// screen's "Add person" dialog. Unlike upsert_by_email it always
// creates a fresh card (the dialog doesn't carry an email-or-id key)
// and supports an explicit tier — including the "user" tier, which
// also provisions a user_account row + the user_account_person link
// in the same tx so the new login is assignable immediately.
type PersonCreateInput struct {
	Title string `json:"title" mcp:"required,desc=display name for the new person card"`
	Email string `json:"email,omitempty" mcp:"desc=email attribute; required when tier='user' (the future OIDC match key); optional otherwise"`
	Tier  string `json:"tier" mcp:"required,desc=one of 'contact' | 'assignee' | 'user'. 'contact' sets person_kind='contact'; 'assignee' sets person_kind='member' with no login; 'user' sets person_kind='member' AND creates an empty user_account row + user_account_person link (OIDC sub left null; attached on first sign-in)"`
}

// PersonCreateOutput carries the new ids so the caller can route on
// them. UserAccountID is 0 unless tier='user'.
type PersonCreateOutput struct {
	PersonCardID  int64 `json:"person_card_id,string" mcp:"desc=newly inserted person card id"`
	UserAccountID int64 `json:"user_account_id,string,omitempty" mcp:"desc=newly inserted user_account id when tier='user'; 0 otherwise"`
}

// PersonGrantAccountInput promotes an EXISTING person card to a "user" by
// minting a user_account + the user_account_person link. The caller sets
// person_kind='member' separately (attribute.update); this only grants login.
type PersonGrantAccountInput struct {
	PersonCardID int64  `json:"person_card_id,string" mcp:"required,desc=person card to grant a login to"`
	Email        string `json:"email,omitempty" mcp:"desc=email override for the new user_account (the OIDC match key); when empty the person's stored email attribute is used; one of them must be non-empty"`
}

// PersonGrantAccountOutput carries the linked (or pre-existing) account id.
type PersonGrantAccountOutput struct {
	UserAccountID int64 `json:"user_account_id,string" mcp:"desc=the user_account id linked to the person (newly created, or the pre-existing one when already linked)"`
}

func registerPersonGrantAccount(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "person",
		Action:       "grant_account",
		Doc:          "Grant a login (user_account) to an EXISTING person card — promote an assignee/contact to a user. Idempotent: if the person already has an account, returns it. Email required (request override or the person's stored email). Admin-only.",
		InputType:    reflect.TypeFor[PersonGrantAccountInput](),
		OutputType:   reflect.TypeFor[PersonGrantAccountOutput](),
		AllowedRoles: []string{"admin"},
		// Unified handler — body in db/schema/functions/person_grant_account_batch.sql.
		SQLFunc: "person_grant_account_batch",
	})
}

func registerPersonCreate(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "person",
		Action:       "create",
		Doc:          "Create a new person card with the given title, optional email, and tier ('contact' | 'assignee' | 'user'). When tier='user' a user_account row is also created (oidc_sub NULL — attached on first sign-in) and linked via user_account_person. Admin-only.",
		InputType:    reflect.TypeFor[PersonCreateInput](),
		OutputType:   reflect.TypeFor[PersonCreateOutput](),
		AllowedRoles: []string{"admin"},
		// Unified handler — body lives in
		// db/schema/functions/person_create_batch.sql. Per Phase 4 of
		// docs/UNIFIED_HANDLER_PLAN.md the SQL function owns the
		// validate + write pipeline. The Go upsertPersonByEmail helper
		// above is unrelated (in-process IMAP path).
		SQLFunc: "person_create_batch",
	})
}

// registerPersonUpsertByEmail is called from Register(). Pulled into
// its own function so the comm.Register reads as a flat list rather
// than a wall of inline handler structs.
func registerPersonUpsertByEmail(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "person",
		Action:       "upsert_by_email",
		Doc:          "Find a person card by case-insensitive email match, or create a new global person card with the supplied display name + email + kind. Used by the comm recipient picker (kind='contact') so typing a fresh email materialises a contact card in one round trip. Authz: worker / manager / admin.",
		InputType:    reflect.TypeFor[PersonUpsertByEmailInput](),
		OutputType:   reflect.TypeFor[PersonUpsertByEmailOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		// Person cards are global — they live outside any project's
		// scope until a downstream domain attaches them (assignee,
		// recipient, etc.). The downstream attachment IS scope-checked.
		GlobalScope: true,
		// Unified handler — body lives in
		// db/schema/functions/person_upsert_by_email_batch.sql. Per
		// Phase 3 of docs/UNIFIED_HANDLER_PLAN.md the SQL function
		// owns the lookup + create pipeline. The Go upsertPersonByEmail
		// helper above is still used by imap.go on the inbound-parse
		// path (which runs inside its own tx, not via the dispatcher).
		SQLFunc: "person_upsert_by_email_batch",
	})
}
