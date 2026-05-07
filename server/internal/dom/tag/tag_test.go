package tag_test

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/echo"
	"github.com/kitp/kitp/server/internal/dom/tag"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func setup(t *testing.T, schema string) (*api.Server, *store.Pool) {
	t.Helper()
	reg.Reset()
	pool := store.TestPool(t, schema)
	sp := store.NewPool(pool)
	echo.Register()
	cardtype.Register()
	card.Register(sp)
	attribute.Register(sp)
	activity.Register(sp)
	tag.Register(sp)
	return api.NewServer(sp), sp
}

// makeTag creates a tag CARD with the given path and exclusion root.
func makeTag(t *testing.T, srv *api.Server, projectID int64, path, root string) int64 {
	t.Helper()
	ctx := auth.WithSystemUser(context.Background())
	rootJSON := "null"
	if root != "" {
		rootJSON = fmt.Sprintf("%q", root)
	}
	data := fmt.Sprintf(
		`{"card_type_name":"tag","parent_card_id":%d,"title":%q,"attributes":{"path":%q,"root_exclusive_at":%s}}`,
		projectID, path, path, rootJSON)
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(data)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("tag insert: %+v", resp.Subresponses[0])
	}
	var out card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &out)
	return out.ID
}

// TestApplyMutualExclusion: applying priority/high then priority/low on
// one task leaves only priority/low; activity shows the removal.
func TestApplyMutualExclusion(t *testing.T) {
	srv, _ := setup(t, "kitp_test_tag_mutex")
	ctx := auth.WithSystemUser(context.Background())

	// Project + task + 2 mutually-exclusive tags.
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
	var taskOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &taskOut)

	high := makeTag(t, srv, pOut.ID, "priority/high", "priority")
	low := makeTag(t, srv, pOut.ID, "priority/low", "priority")

	// Apply high.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "ah", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, high))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("apply high: %+v", resp.Subresponses[0])
	}

	// Apply low — should remove high.
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "al", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, low))},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("apply low: %+v", resp.Subresponses[0])
	}
	var alOut tag.ApplyOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &alOut)
	if len(alOut.RemovedTagIDs) != 1 || alOut.RemovedTagIDs[0] != high {
		t.Errorf("removed: got %v want [%d]", alOut.RemovedTagIDs, high)
	}

	// Verify final attribute_value.tags == [low].
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":%d,"card_type_name":"task"}`, pOut.ID))},
	}})
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	if len(gOut.Rows) != 1 {
		t.Fatalf("rows: %+v", gOut.Rows)
	}
	var arr []int64
	if err := json.Unmarshal(gOut.Rows[0].Attributes["tags"], &arr); err != nil {
		t.Fatalf("tags decode: %v (raw=%s)", err, gOut.Rows[0].Attributes["tags"])
	}
	if len(arr) != 1 || arr[0] != low {
		t.Errorf("tags: got %v, want [%d]", arr, low)
	}

	// Activity should include two tag_apply events (no separate removal kind
	// — the value transition tells the story).
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, taskOut.ID))},
	}})
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)
	tagApplyCount := 0
	for _, r := range aOut.Rows {
		if r.Kind == "tag_apply" {
			tagApplyCount++
		}
	}
	if tagApplyCount != 2 {
		t.Errorf("tag_apply rows: got %d, want 2: %+v", tagApplyCount, aOut.Rows)
	}
}

// TestApplyNonExclusive: two tags with no shared exclusion root both stay.
func TestApplyNonExclusive(t *testing.T) {
	srv, _ := setup(t, "kitp_test_tag_nonexcl")
	ctx := auth.WithSystemUser(context.Background())

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
	var taskOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &taskOut)

	t1 := makeTag(t, srv, pOut.ID, "team/frontend", "")
	t2 := makeTag(t, srv, pOut.ID, "area/login", "")

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a1", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, t1))},
		{ID: "a2", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, t2))},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("apply: %+v", sr.Error)
		}
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "g", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"parent_card_id":%d,"card_type_name":"task"}`, pOut.ID))},
	}})
	var gOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &gOut)
	var arr []int64
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(gOut.Rows[0].Attributes["tags"]))), &arr); err != nil {
		t.Fatalf("tags decode: %v (raw=%s)", err, gOut.Rows[0].Attributes["tags"])
	}
	want := []int64{t1, t2}
	if len(arr) != len(want) || arr[0] != want[0] || arr[1] != want[1] {
		t.Errorf("tags: got %v, want %v", arr, want)
	}
}

// TestApplyCoalesces: two tag.apply sub-requests in one batch issue ONE
// statement group (LastWrites == 1) regardless of N.
func TestApplyCoalesces(t *testing.T) {
	srv, sp := setup(t, "kitp_test_tag_coal")
	ctx := auth.WithSystemUser(context.Background())

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
	var taskOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &taskOut)

	t1 := makeTag(t, srv, pOut.ID, "team/frontend", "")
	t2 := makeTag(t, srv, pOut.ID, "area/login", "")

	sp.ResetWrites()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a1", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, t1))},
		{ID: "a2", Endpoint: "tag", Action: "apply", Data: json.RawMessage(
			fmt.Sprintf(`{"target_card_id":%d,"tag_card_id":%d}`, taskOut.ID, t2))},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("apply: %+v", sr.Error)
		}
	}
	if got := sp.LastWrites(); got != 1 {
		t.Errorf("LastWrites: got %d, want 1 (two tag.apply must coalesce)", got)
	}
}
