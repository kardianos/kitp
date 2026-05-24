package attribute_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// makeScreenFixture creates a project, then bypasses the automatic screen
// seed by selecting one of the seeded screens. Useful for tests that need
// a screen card under a project without hand-crafting the entire chain.
//
// Project seeding graph-copies the install-seed template, which carries
// seven screens (inbox/grid/kanban/project/ideas/archive/comms). Tests
// use the inbox screen as their starting point.
func mustGetSeededInboxScreen(t *testing.T, srv *api.Server, ctx context.Context, projectID int64) card.CardWithAttrs {
	t.Helper()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d"}`, projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &sOut)
	for _, r := range sOut.Rows {
		var slug string
		if err := json.Unmarshal(r.Attributes["slug"], &slug); err != nil {
			continue
		}
		if slug == "inbox" {
			return r
		}
	}
	t.Fatalf("no inbox screen under project %d", projectID)
	return card.CardWithAttrs{}
}

// mustInsertProject inserts a project and returns its id.
func mustInsertProject(t *testing.T, srv *api.Server, ctx context.Context, title string) int64 {
	t.Helper()
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"project","title":%q}`, title))},
	}})
	mustOK(t, resp.Subresponses[0])
	var pOut card.InsertOutput
	raw(t, resp.Subresponses[0], &pOut)
	return pOut.ID
}

// TestHotkey_DuplicateRejected — two screens under the same project, the
// second screen attempting to claim a hotkey already held by the first
// is rejected with code "hotkey_in_use".
func TestHotkey_DuplicateRejected(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_hotkey_dup")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")

	// The auto-seeded Inbox already holds hotkey="i". Pick the
	// project-detail screen (no hotkey by default) and try to set 'i'.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d"}`, projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &sOut)
	var projectScreenID int64
	for _, r := range sOut.Rows {
		var slug string
		if err := json.Unmarshal(r.Attributes["slug"], &slug); err != nil {
			continue
		}
		if slug == "project" {
			projectScreenID = r.ID
			break
		}
	}
	if projectScreenID == 0 {
		t.Fatal("no project screen seeded")
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"hotkey","value":"i"}`, projectScreenID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected hotkey_in_use; got OK")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "hotkey_in_use" {
		t.Fatalf("expected hotkey_in_use; got %+v", resp.Subresponses[0].Error)
	}
}

// TestHotkey_AllowedAcrossProjects — two different projects each owning
// a hotkey 'i' is fine; the uniqueness is scoped to (parent_card_id, value).
func TestHotkey_AllowedAcrossProjects(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_hotkey_cross")
	ctx := auth.WithSystemUser(context.Background())

	// Both projects get auto-seeded Inbox screens with hotkey 'i'. The
	// fact that both apply cleanly is the assertion.
	projectA := mustInsertProject(t, srv, ctx, "A")
	projectB := mustInsertProject(t, srv, ctx, "B")

	scA := mustGetSeededInboxScreen(t, srv, ctx, projectA)
	scB := mustGetSeededInboxScreen(t, srv, ctx, projectB)

	var hkA, hkB string
	if err := json.Unmarshal(scA.Attributes["hotkey"], &hkA); err != nil {
		t.Fatalf("decode hotkey A: %v", err)
	}
	if err := json.Unmarshal(scB.Attributes["hotkey"], &hkB); err != nil {
		t.Fatalf("decode hotkey B: %v", err)
	}
	if hkA != "i" || hkB != "i" {
		t.Errorf("expected both hotkeys=i, got A=%q B=%q", hkA, hkB)
	}
}

// TestHotkey_SelfUpdate — setting the same hotkey on the same screen
// (a no-op rewrite) succeeds because the EXISTS query excludes the row
// being updated via c.id <> $screenId.
func TestHotkey_SelfUpdate(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_hotkey_self")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	inbox := mustGetSeededInboxScreen(t, srv, ctx, projectID)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"hotkey","value":"i"}`, inbox.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
}

// TestHotkey_ChangeValue — re-binding a screen to a new, project-unique
// hotkey succeeds; an in-tx tx-scoped uniqueness check is the only gate.
func TestHotkey_ChangeValue(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_hotkey_change")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	inbox := mustGetSeededInboxScreen(t, srv, ctx, projectID)

	// 'z' isn't seeded; this should land.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"hotkey","value":"z"}`, inbox.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
}

// TestSlug_InvalidRejected — slugs that don't match the regex are
// rejected with code "slug_invalid". Tests every interesting failure
// shape (uppercase, leading digit, leading hyphen, special chars, empty).
func TestSlug_InvalidRejected(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_slug_bad")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	inbox := mustGetSeededInboxScreen(t, srv, ctx, projectID)

	cases := []struct {
		label string
		slug  string
	}{
		{"uppercase", "Inbox"},
		{"leading digit", "9inbox"},
		{"leading hyphen", "-inbox"},
		{"special chars", "in_box"},
		{"empty", ""},
		{"space", "in box"},
	}
	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
				{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
					fmt.Sprintf(`{"card_id":"%d","attribute_name":"slug","value":%q}`, inbox.ID, tc.slug))},
			}})
			if resp.Subresponses[0].OK {
				t.Fatalf("%q: expected slug_invalid; got OK", tc.slug)
			}
			if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "slug_invalid" {
				t.Fatalf("%q: expected slug_invalid; got %+v", tc.slug, resp.Subresponses[0].Error)
			}
		})
	}
}

// TestSlug_ValidAccepted — slugs that match the regex AND are unique
// in the project are accepted.
func TestSlug_ValidAccepted(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_slug_ok")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	inbox := mustGetSeededInboxScreen(t, srv, ctx, projectID)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"slug","value":"custom-inbox"}`, inbox.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
}

// TestSlug_DuplicateRejected — two screens under the same project can't
// both own the same slug. The auto-seeded Inbox owns "inbox"; pushing
// "inbox" onto another seeded screen rejects with code "slug_in_use".
func TestSlug_DuplicateRejected(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_slug_dup")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")

	// Pick the project-detail screen and try to claim slug "inbox".
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d"}`, projectID))},
	}})
	mustOK(t, resp.Subresponses[0])
	var sOut card.SelectWithAttributesOutput
	raw(t, resp.Subresponses[0], &sOut)
	var pdID int64
	for _, r := range sOut.Rows {
		var slug string
		if err := json.Unmarshal(r.Attributes["slug"], &slug); err != nil {
			continue
		}
		if slug == "project" {
			pdID = r.ID
			break
		}
	}
	if pdID == 0 {
		t.Fatal("no project screen seeded")
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"slug","value":"inbox"}`, pdID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected slug_in_use; got OK")
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "slug_in_use" {
		t.Fatalf("expected slug_in_use; got %+v", resp.Subresponses[0].Error)
	}
}

// TestSlug_AllowedAcrossProjects — the same slug under two projects is
// fine.
func TestSlug_AllowedAcrossProjects(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_slug_cross")
	ctx := auth.WithSystemUser(context.Background())

	// Both projects get auto-seeded Inbox with slug="inbox"; the lack
	// of conflict is the assertion.
	projectA := mustInsertProject(t, srv, ctx, "A")
	projectB := mustInsertProject(t, srv, ctx, "B")

	scA := mustGetSeededInboxScreen(t, srv, ctx, projectA)
	scB := mustGetSeededInboxScreen(t, srv, ctx, projectB)

	var slugA, slugB string
	if err := json.Unmarshal(scA.Attributes["slug"], &slugA); err != nil {
		t.Fatalf("decode slug A: %v", err)
	}
	if err := json.Unmarshal(scB.Attributes["slug"], &slugB); err != nil {
		t.Fatalf("decode slug B: %v", err)
	}
	if slugA != "inbox" || slugB != "inbox" {
		t.Errorf("expected both slugs=inbox, got A=%q B=%q", slugA, slugB)
	}
}

// TestHotkey_ClearedAcceptsEmpty — clearing a hotkey (JSON null) is
// accepted, since the uniqueness rule has no value to dedupe against.
func TestHotkey_ClearedAcceptsEmpty(t *testing.T) {
	srv, _ := setup(t, "kitp_test_attr_hotkey_clear")
	ctx := auth.WithSystemUser(context.Background())
	projectID := mustInsertProject(t, srv, ctx, "P")
	inbox := mustGetSeededInboxScreen(t, srv, ctx, projectID)

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "attribute", Action: "update", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":"%d","attribute_name":"hotkey","value":null}`, inbox.ID))},
	}})
	mustOK(t, resp.Subresponses[0])
}
