package session

import (
	"context"
	"testing"

	"github.com/kitp/kitp/server/internal/store"
)

// TestBuildMePersonCardID covers the /auth/me person_card_id field: a user
// with a user_account_person link reports its person CARD id (the value the
// client resolves "Self" to when editing a person-typed card_ref), and a
// login-only account with no link reports nil.
func TestBuildMePersonCardID(t *testing.T) {
	pool := store.TestPool(t, "kitp_test_buildme_person")
	ctx := context.Background()
	cfg := HTTPConfig{Pool: pool}

	// A user linked to a person card.
	var uid, cardID int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, "linky",
	).Scan(&uid); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		INSERT INTO card (card_type_id)
		SELECT id FROM card_type WHERE name = 'person'
		RETURNING id
	`).Scan(&cardID); err != nil {
		t.Fatalf("seed person card: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO user_account_person (user_account_id, person_card_id)
		VALUES ($1, $2)
	`, uid, cardID); err != nil {
		t.Fatalf("seed link: %v", err)
	}

	me, err := buildMe(ctx, cfg, uid, "linky")
	if err != nil {
		t.Fatalf("buildMe(linked): %v", err)
	}
	if me.PersonCardID == nil {
		t.Fatalf("PersonCardID: got nil, want %d", cardID)
	}
	if *me.PersonCardID != cardID {
		t.Errorf("PersonCardID: got %d, want %d", *me.PersonCardID, cardID)
	}

	// A login-only account with no person link.
	var loner int64
	if err := pool.QueryRow(ctx,
		`INSERT INTO user_account (display_name) VALUES ($1) RETURNING id`, "loner",
	).Scan(&loner); err != nil {
		t.Fatalf("seed loner: %v", err)
	}
	me2, err := buildMe(ctx, cfg, loner, "loner")
	if err != nil {
		t.Fatalf("buildMe(unlinked): %v", err)
	}
	if me2.PersonCardID != nil {
		t.Errorf("PersonCardID for unlinked user: got %d, want nil", *me2.PersonCardID)
	}
}
