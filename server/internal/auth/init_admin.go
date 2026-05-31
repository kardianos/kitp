// Package auth — startup-time admin bootstrap.
//
// When the database is fresh (no non-System user holds the admin
// role) and the operator has named an admin via the
// KITP_INIT_ADMIN_EMAIL environment variable, we pre-create the
// matching user_account + person card + user_account_person link AND
// grant them the admin role before the HTTP server starts taking
// traffic. On first OIDC sign-in the OIDC provisioner picks up that
// row via its email-fallback (see oidc.provisionUser) and attaches
// the OIDC subject — so the named admin is recognised the moment
// they log in.
//
// When KITP_INIT_ADMIN_EMAIL is NOT set, this is a no-op; the OIDC
// provisioner instead self-elevates the *first* user to sign in to
// admin via the same init-mode check (see grantAdminIfInitMode in
// auth/oidc).
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/kitp/kitp/server/internal/textnorm"
)

// BootstrapInitAdmin pre-creates the named admin when the database
// is in "init mode" (no non-System admin yet) and [email] is
// non-empty. Idempotent: re-running after an admin already exists is
// a no-op.
//
// Caller is responsible for reading the env var and deciding to
// invoke this; we don't read os.Getenv here so tests can drive the
// helper directly.
func BootstrapInitAdmin(ctx context.Context, pool *pgxpool.Pool, email string) error {
	// Normalize so the env-supplied address compares equal to what
	// the OIDC fallback will see on first sign-in (textnorm.Email
	// lowercases + NFC-normalises). Without this, an env var like
	// "Boot@Example.COM" would pre-create one row but OIDC would
	// match "boot@example.com" as not-found and create a second.
	email = textnorm.Email(email)
	if email == "" {
		return nil
	}

	// Cheap precondition check outside the tx: if an admin already
	// exists, skip without taking a row lock.
	if hasAdmin, err := hasNonSystemAdmin(ctx, pool); err != nil {
		return fmt.Errorf("bootstrap init-admin: check existing: %w", err)
	} else if hasAdmin {
		return nil
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("bootstrap init-admin: begin: %w", err)
	}
	defer tx.Rollback(ctx)

	// Re-check inside the tx in case a concurrent OIDC sign-in
	// elevated someone between the precondition check above and now.
	// Two-step (read → write) under READ COMMITTED would otherwise
	// race; the re-check inside the tx is cheap.
	if hasAdmin, err := hasNonSystemAdminTx(ctx, tx); err != nil {
		return fmt.Errorf("bootstrap init-admin: recheck: %w", err)
	} else if hasAdmin {
		return nil
	}

	// Look for an existing user_account with this email. The admin
	// might have been pre-created via the People admin UI's
	// "+ Add person" with tier=user already; in that case we just
	// grant the role and return.
	var userID int64
	preExisting := true
	// Case-fold + NFC the stored email on lookup so a row inserted via
	// a non-normalising path (legacy migration, manual SQL, import)
	// still matches the textnorm-normalised env input. The application
	// layer normalises on every fresh insert; this `lower(...)` guard
	// covers historic rows. See
	// DI-7 in docs/DESIGN_INVARIANTS.md.
	if err := tx.QueryRow(ctx,
		`SELECT id FROM user_account WHERE lower(email) = $1 ORDER BY id LIMIT 1`,
		email,
	).Scan(&userID); err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("bootstrap init-admin: lookup email: %w", err)
		}
		preExisting = false
	}

	if !preExisting {
		// Create user_account with no oidc_sub — the OIDC provisioner
		// attaches a sub on first sign-in via its email fallback.
		// Display name is just the email until the OIDC `name` claim
		// supplies something better.
		if err := tx.QueryRow(ctx, `
			INSERT INTO user_account (display_name, email)
			VALUES ($1, $2)
			RETURNING id
		`, email, email).Scan(&userID); err != nil {
			return fmt.Errorf("bootstrap init-admin: insert user_account: %w", err)
		}
		if err := provisionAdminPersonCard(ctx, tx, userID, email); err != nil {
			return fmt.Errorf("bootstrap init-admin: person card: %w", err)
		}
	}

	// Grant the admin role globally. ON CONFLICT DO NOTHING handles
	// the "already granted via some other path" case so this stays
	// idempotent.
	var adminRoleID int64
	if err := tx.QueryRow(ctx,
		`SELECT id FROM role WHERE name = 'admin'`,
	).Scan(&adminRoleID); err != nil {
		return fmt.Errorf("bootstrap init-admin: lookup admin role: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_role (user_id, role_id, scope_card_id)
		VALUES ($1, $2, NULL)
		ON CONFLICT DO NOTHING
	`, userID, adminRoleID); err != nil {
		return fmt.Errorf("bootstrap init-admin: grant: %w", err)
	}

	return tx.Commit(ctx)
}

func hasNonSystemAdmin(ctx context.Context, pool *pgxpool.Pool) (bool, error) {
	var n int
	err := pool.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE r.name = 'admin' AND ur.user_id <> $1
	`, SystemUserID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func hasNonSystemAdminTx(ctx context.Context, tx pgx.Tx) (bool, error) {
	var n int
	err := tx.QueryRow(ctx, `
		SELECT count(*) FROM user_role ur
		JOIN role r ON r.id = ur.role_id
		WHERE r.name = 'admin' AND ur.user_id <> $1
	`, SystemUserID).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// provisionAdminPersonCard inserts the person card + activity rows +
// attribute_values + user_account_person link for the bootstrap
// admin. Mirrors what the OIDC provisioner does on first sight,
// minus the optional fields we don't have yet at startup time.
//
// Uses person_kind='member' so the row immediately shows up in
// assignee dropdowns (the bootstrap admin is by definition a real
// team member).
func provisionAdminPersonCard(ctx context.Context, tx pgx.Tx, userID int64, email string) error {
	var personCardID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO card (card_type_id, parent_card_id)
		SELECT id, NULL FROM card_type WHERE name = 'person'
		RETURNING id
	`).Scan(&personCardID); err != nil {
		return fmt.Errorf("person card: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO activity (card_id, kind, actor_id) VALUES ($1, 'card_create', $2)`,
		personCardID, userID,
	); err != nil {
		return fmt.Errorf("card_create activity: %w", err)
	}
	// title, email, person_kind. The pattern here intentionally
	// duplicates the OIDC provisioner — extracting a shared helper
	// would cross the auth/oidc package boundary and the SQL is
	// short.
	for _, w := range []struct {
		attrName string
		value    string
	}{
		{"title", email},
		{"email", email},
		{"person_kind", "member"},
	} {
		var actID int64
		if err := tx.QueryRow(ctx, `
			INSERT INTO activity (card_id, kind, attribute_def_id, value_old, value_new, actor_id)
			SELECT $1, 'attr_update', ad.id, NULL, to_jsonb($2::text), $3
			FROM attribute_def ad WHERE ad.name = $4
			RETURNING id
		`, personCardID, w.value, userID, w.attrName).Scan(&actID); err != nil {
			return fmt.Errorf("%s activity: %w", w.attrName, err)
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO attribute_value (card_id, attribute_def_id, value, last_activity_id)
			SELECT $1, ad.id, to_jsonb($2::text), $3
			FROM attribute_def ad WHERE ad.name = $4
		`, personCardID, w.value, actID, w.attrName); err != nil {
			return fmt.Errorf("%s value: %w", w.attrName, err)
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO user_account_person (user_account_id, person_card_id)
		VALUES ($1, $2)
	`, userID, personCardID); err != nil {
		return fmt.Errorf("link: %w", err)
	}
	return nil
}
