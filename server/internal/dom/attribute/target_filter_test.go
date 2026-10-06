package attribute_test

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// targetFilterFixture extends the scope fixture with the three person
// shapes the seeded assignee target_filter distinguishes.
type targetFilterFixture struct {
	scopeFixture
	member   int64 // person_kind 'member'
	contact  int64 // person_kind 'contact' — never newly assignable
	disabled int64 // is_active false — never newly assignable
}

func makeTargetFilterFixture(t *testing.T, srv *api.Server) targetFilterFixture {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	mkPerson := func(name, attrs string) int64 {
		resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
			{ID: "ps", Endpoint: "card", Action: "insert", Data: json.RawMessage(
				fmt.Sprintf(`{"card_type_name":"person","title":%q,"attributes":%s}`, name, attrs))},
		}})
		if !resp.Subresponses[0].OK {
			t.Fatalf("person %q: %+v", name, resp.Subresponses[0])
		}
		var o card.InsertOutput
		raw(t, resp.Subresponses[0], &o)
		return o.ID
	}
	return targetFilterFixture{
		scopeFixture: makeProjectFixture(t, srv),
		member:       mkPerson("Member", `{"person_kind":"member"}`),
		contact:      mkPerson("Contact", `{"person_kind":"contact"}`),
		disabled:     mkPerson("Disabled", `{"person_kind":"member","is_active":false}`),
	}
}

func dispatchOne(t *testing.T, srv *api.Server, endpoint, action, data string) api.SubResponse {
	t.Helper()
	resp := srv.Dispatch(auth.WithSystemUser(context.Background()), api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "x", Endpoint: endpoint, Action: action, Data: json.RawMessage(data)},
	}})
	return resp.Subresponses[0]
}

func wantCode(t *testing.T, sr api.SubResponse, code string) {
	t.Helper()
	if code == "" {
		if !sr.OK {
			t.Fatalf("want OK; got %+v", sr.Error)
		}
		return
	}
	if sr.OK {
		t.Fatalf("want %s; got OK", code)
	}
	if sr.Error == nil || sr.Error.Code != code {
		t.Fatalf("want code %s; got %+v", code, sr.Error)
	}
}

// TestTargetFilter_Writes: the assignee target_filter rejects a contact or
// disabled person as a NEW value on attribute.update and card.insert, while
// originator (no filter) still accepts a contact.
func TestTargetFilter_Writes(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_target_filter_writes")
	fx := makeTargetFilterFixture(t, srv)

	type row struct {
		name   string
		attr   string
		person int64
		code   string
	}
	rows := []row{
		{"assignee member", "assignee", fx.member, ""},
		{"assignee unset person_kind", "assignee", fx.personID, ""},
		{"assignee contact", "assignee", fx.contact, "ref_not_allowed"},
		{"assignee disabled", "assignee", fx.disabled, "ref_not_allowed"},
		{"originator contact", "originator", fx.contact, ""},
	}
	for _, r := range rows {
		t.Run("update "+r.name, func(t *testing.T) {
			wantCode(t, dispatchOne(t, srv, "attribute", "update", fmt.Sprintf(
				`{"card_id":"%d","attribute_name":%q,"value":"%d"}`, fx.taskA, r.attr, r.person)), r.code)
		})
		t.Run("insert "+r.name, func(t *testing.T) {
			wantCode(t, dispatchOne(t, srv, "card", "insert", fmt.Sprintf(
				`{"card_type_name":"task","parent_card_id":"%d","title":"T","attributes":{%q:"%d","status":"%d"}}`,
				fx.projectA, r.attr, r.person, fx.statusA)), r.code)
		})
	}
}

// TestTargetFilter_Grandfathered: a contact assigned before the rule existed
// stays put — re-saving the same value succeeds — and can still be replaced
// by a valid person.
func TestTargetFilter_Grandfathered(t *testing.T) {
	srv, sp := setupScope(t, "kitp_test_target_filter_grandfathered")
	fx := makeTargetFilterFixture(t, srv)

	// Store the contact directly, as pre-rule data would be.
	if _, err := sp.P.Exec(context.Background(), `
		INSERT INTO attribute_value (card_id, attribute_def_id, value)
		SELECT $1, ad.id, to_jsonb($2::bigint) FROM attribute_def ad WHERE ad.name = 'assignee'
	`, fx.taskA, fx.contact); err != nil {
		t.Fatalf("seed contact assignee: %v", err)
	}
	set := func(person int64) api.SubResponse {
		return dispatchOne(t, srv, "attribute", "update", fmt.Sprintf(
			`{"card_id":"%d","attribute_name":"assignee","value":"%d"}`, fx.taskA, person))
	}
	wantCode(t, set(fx.contact), "")
	wantCode(t, set(fx.member), "")
	// Once replaced, the contact is a NEW value again and is refused.
	wantCode(t, set(fx.contact), "ref_not_allowed")
}

// TestTargetFilter_Search: card.search with attribute_name offers only the
// persons the attribute accepts — even for an exact id lookup — while a
// search without it (or for an unfiltered attribute) still lists everyone.
func TestTargetFilter_Search(t *testing.T) {
	srv, _ := setupScope(t, "kitp_test_target_filter_search")
	fx := makeTargetFilterFixture(t, srv)

	ids := func(sr api.SubResponse) []int64 {
		t.Helper()
		wantCode(t, sr, "")
		var o card.SearchOutput
		raw(t, sr, &o)
		out := make([]int64, 0, len(o.Rows))
		for _, h := range o.Rows {
			out = append(out, h.ID)
		}
		return out
	}

	assignable := ids(dispatchOne(t, srv, "card", "search",
		`{"card_type_name":"person","attribute_name":"assignee"}`))
	for _, want := range []int64{fx.member, fx.personID} {
		if !slices.Contains(assignable, want) {
			t.Errorf("assignee search missing person %d; got %v", want, assignable)
		}
	}
	for _, bad := range []int64{fx.contact, fx.disabled} {
		if slices.Contains(assignable, bad) {
			t.Errorf("assignee search offered person %d; got %v", bad, assignable)
		}
	}

	byID := ids(dispatchOne(t, srv, "card", "search", fmt.Sprintf(
		`{"card_type_name":"person","attribute_name":"assignee","query":"%d"}`, fx.contact)))
	if len(byID) != 0 {
		t.Errorf("exact-id lookup of a contact for assignee = %v; want none", byID)
	}

	for _, input := range []string{
		`{"card_type_name":"person"}`,
		`{"card_type_name":"person","attribute_name":"originator"}`,
	} {
		all := ids(dispatchOne(t, srv, "card", "search", input))
		for _, want := range []int64{fx.member, fx.contact, fx.disabled} {
			if !slices.Contains(all, want) {
				t.Errorf("%s: missing person %d; got %v", input, want, all)
			}
		}
	}

	wantCode(t, dispatchOne(t, srv, "card", "search",
		`{"card_type_name":"person","attribute_name":"no_such_attr"}`), "validation")
}
