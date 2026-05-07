package comment_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/activity"
	"github.com/kitp/kitp/server/internal/dom/attribute"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/dom/cardtype"
	"github.com/kitp/kitp/server/internal/dom/comment"
	"github.com/kitp/kitp/server/internal/dom/echo"
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
	comment.Register(sp)
	return api.NewServer(sp), sp
}

// TestCommentLifecycle: create task → post 3 comments → activity has 4 rows
// (card_create + 3 comments) in order, comments include body text.
func TestCommentLifecycle(t *testing.T) {
	srv, sp := setup(t, "kitp_test_comment_life")
	ctx := auth.WithSystemUser(context.Background())

	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"P"}`)},
	}})
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Insert task — but only with title (no other attributes), so the
	// activity stream begins with [card_create, attr_update title].
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "t", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"task","parent_card_id":%d,"title":"T"}`, pOut.ID))},
	}})
	var tOut card.InsertOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &tOut)

	// Post 3 comments in one batch — ONE Run, ONE statement group.
	sp.ResetWrites()
	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "c1", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"body":"first"}`, tOut.ID))},
		{ID: "c2", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"body":"second"}`, tOut.ID))},
		{ID: "c3", Endpoint: "comment", Action: "insert", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d,"body":"third"}`, tOut.ID))},
	}})
	for _, sr := range resp.Subresponses {
		if !sr.OK {
			t.Fatalf("comment.insert failed: %+v", sr.Error)
		}
	}
	if got := sp.LastWrites(); got != 1 {
		t.Errorf("LastWrites: got %d, want 1 (3 comments must coalesce)", got)
	}

	resp = srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "a", Endpoint: "activity", Action: "select", Data: json.RawMessage(
			fmt.Sprintf(`{"card_id":%d}`, tOut.ID))},
	}})
	var aOut activity.SelectOutput
	buf, _ = json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &aOut)

	// Expect: card_create, attr_update title, comment first, comment second, comment third.
	wantKinds := []string{"card_create", "attr_update", "comment", "comment", "comment"}
	if len(aOut.Rows) != len(wantKinds) {
		t.Fatalf("rows: %d want %d. got: %+v", len(aOut.Rows), len(wantKinds), aOut.Rows)
	}
	for i, k := range wantKinds {
		if aOut.Rows[i].Kind != k {
			t.Errorf("row %d kind: %q want %q", i, aOut.Rows[i].Kind, k)
		}
	}
	wantBodies := []string{"first", "second", "third"}
	for i, b := range wantBodies {
		row := aOut.Rows[i+2]
		if row.CommentBody == nil || *row.CommentBody != b {
			t.Errorf("comment %d body: %v want %q", i, row.CommentBody, b)
		}
	}
}
