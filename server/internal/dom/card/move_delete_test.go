package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// TestDeleteUndelete checks the soft-delete + activity log lifecycle.
func TestDeleteUndelete(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_del")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// Delete then undelete in a single batch.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "d", Endpoint: "card", Action: "delete", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("delete: %+v", resp.Subresponses[0])
	}

	// Default select_with_attributes hides the deleted task.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":%d,"card_type_name":"task"}`, pOut.ID))},
	}})
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 0 {
		t.Errorf("hidden default: got %d rows, want 0", len(gOut.Rows))
	}

	// include_deleted shows it.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":%d,"card_type_name":"task","include_deleted":true}`, pOut.ID))},
	}})
	gOut = card.SelectWithAttributesOutput{}
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 1 {
		t.Errorf("include_deleted: got %d rows, want 1", len(gOut.Rows))
	}

	// Undelete and verify activity contains both card_delete + card_undelete.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "u", Endpoint: "card", Action: "undelete", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("undelete: %+v", resp.Subresponses[0])
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)
	kinds := []string{}
	for _, r := range aOut.Rows {
		kinds = append(kinds, r.Kind)
	}
	// Expect: card_create, attr_update (title), card_delete, card_undelete.
	wantKinds := []string{"card_create", "attr_update", "card_delete", "card_undelete"}
	if len(kinds) != len(wantKinds) {
		t.Fatalf("activity kinds: %v want %v", kinds, wantKinds)
	}
	for i, k := range kinds {
		if k != wantKinds[i] {
			t.Errorf("activity[%d]: got %q want %q", i, k, wantKinds[i])
		}
	}
}

// TestMoveValidatesParentType: moving a task under a tag is rejected.
func TestMoveValidatesParentType(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_card_move")
	ctx := context.Background()

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "tag", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"tag","parent_card_id":%d,"title":"priority/high","attributes":{"path":"priority/high"}}`, pOut.ID))},
	}})
	var tagOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tagOut)

	// Move task under tag → rejected.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "m", Endpoint: "card", Action: "move", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"new_parent_card_id":%d}`, tOut.ID, tagOut.ID))},
	}})
	if resp.Subresponses[0].OK {
		t.Fatalf("expected edge_violation; got %+v", resp.Subresponses[0])
	}
	if resp.Subresponses[0].Error == nil || resp.Subresponses[0].Error.Code != "edge_violation" {
		t.Errorf("error code: %+v", resp.Subresponses[0].Error)
	}

	// Move task under a different sub-task (allow_self_parent on task) is allowed.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t2", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T2"}`, pOut.ID))},
	}})
	var t2Out card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &t2Out)
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "m", Endpoint: "card", Action: "move", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"new_parent_card_id":%d}`, tOut.ID, t2Out.ID))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("expected ok; got %+v", resp.Subresponses[0])
	}
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)
	hasMove := false
	for _, r := range aOut.Rows {
		if r.Kind == "card_move" {
			hasMove = true
			break
		}
	}
	if !hasMove {
		t.Errorf("activity missing card_move: %+v", aOut.Rows)
	}
}
