package card_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
)

// TestProjectInsertSeedsScreens runs the data table of expected
// (screen_type, title, sort_order, column_attr) tuples against a
// freshly-inserted project and confirms each row materialises in the
// DB with the correct attributes + filter child + default_filter
// wiring. Treats the seed as data: adding a new screen_type to
// `screenSeed` in screen_seed.go is the only change required for this
// test to keep passing once you extend the matrix below.
func TestProjectInsertSeedsScreens(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_project_screen_seed")
	ctx := auth.WithSystemUser(context.Background())

	// Create a project via card.insert; the runInsert hook should seed
	// the screens + filters automatically.
	resp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "p", Endpoint: "card", Action: "insert", Data: json.RawMessage(
			`{"card_type_name":"project","title":"Seeded"}`)},
	}})
	if !resp.Subresponses[0].OK {
		t.Fatalf("project insert: %+v", resp.Subresponses[0].Error)
	}
	var pOut card.InsertOutput
	buf, _ := json.Marshal(resp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &pOut)

	// Pull every screen under this project.
	sResp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
		{ID: "s", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
			fmt.Sprintf(`{"card_type_name":"screen","parent_card_id":"%d"}`, pOut.ID))},
	}})
	if !sResp.Subresponses[0].OK {
		t.Fatalf("screens select: %+v", sResp.Subresponses[0].Error)
	}
	var sOut card.SelectWithAttributesOutput
	buf, _ = json.Marshal(sResp.Subresponses[0].Data)
	_ = json.Unmarshal(buf, &sOut)

	// Data-table expectations. Mirrors `screenSeed` in screen_seed.go;
	// when that table grows, this one grows alongside it.
	type want struct {
		screenType string
		title      string
		sortOrder  int64
		columnAttr string // empty when the filter shouldn't carry one
	}
	wants := []want{
		{screenType: "inbox", title: "Inbox", sortOrder: 1},
		{screenType: "grid", title: "Grid", sortOrder: 2},
		{screenType: "kanban", title: "Kanban", sortOrder: 3, columnAttr: "milestone_ref"},
		{screenType: "project_detail", title: "Project detail", sortOrder: 4},
	}
	if len(sOut.Rows) != len(wants) {
		t.Fatalf("screen count: got %d, want %d", len(sOut.Rows), len(wants))
	}

	// Index seeded screens by screen_type for table-driven checks.
	byType := map[string]card.CardWithAttrs{}
	for _, r := range sOut.Rows {
		var stRaw string
		if err := json.Unmarshal(r.Attributes["screen_type"], &stRaw); err != nil {
			t.Fatalf("decode screen_type on card %d: %v", r.ID, err)
		}
		byType[stRaw] = r
	}

	for _, w := range wants {
		t.Run(w.screenType, func(t *testing.T) {
			screen, ok := byType[w.screenType]
			if !ok {
				t.Fatalf("no screen seeded for %q", w.screenType)
			}
			var titleRaw string
			if err := json.Unmarshal(screen.Attributes["title"], &titleRaw); err != nil {
				t.Fatalf("decode title: %v", err)
			}
			if titleRaw != w.title {
				t.Errorf("title: got %q, want %q", titleRaw, w.title)
			}
			var sortRaw int64
			if err := json.Unmarshal(screen.Attributes["sort_order"], &sortRaw); err != nil {
				t.Fatalf("decode sort_order: %v", err)
			}
			if sortRaw != w.sortOrder {
				t.Errorf("sort_order: got %d, want %d", sortRaw, w.sortOrder)
			}

			// One filter child should exist and screen.default_filter
			// should point at it.
			fResp := srv.Dispatch(ctx, api.BatchRequest{Subrequests: []api.SubRequest{
				{ID: "f", Endpoint: "card", Action: "select_with_attributes", Data: json.RawMessage(
					fmt.Sprintf(`{"card_type_name":"filter","parent_card_id":"%d"}`, screen.ID))},
			}})
			if !fResp.Subresponses[0].OK {
				t.Fatalf("filters select: %+v", fResp.Subresponses[0].Error)
			}
			var fOut card.SelectWithAttributesOutput
			fb, _ := json.Marshal(fResp.Subresponses[0].Data)
			_ = json.Unmarshal(fb, &fOut)
			if len(fOut.Rows) != 1 {
				t.Fatalf("filter count: got %d, want 1", len(fOut.Rows))
			}
			filter := fOut.Rows[0]

			var fTitle string
			_ = json.Unmarshal(filter.Attributes["title"], &fTitle)
			if fTitle != "Default" {
				t.Errorf("filter title: got %q, want Default", fTitle)
			}

			// column_attr on filter, when the seed spec carries one.
			caRaw, hasCA := filter.Attributes["column_attr"]
			if w.columnAttr == "" {
				if hasCA {
					t.Errorf("filter has column_attr=%s, want absent", caRaw)
				}
			} else {
				var ca string
				_ = json.Unmarshal(caRaw, &ca)
				if ca != w.columnAttr {
					t.Errorf("filter column_attr: got %q, want %q", ca, w.columnAttr)
				}
			}

			// screen.default_filter card_ref should point at the lone filter.
			dfRaw, hasDF := screen.Attributes["default_filter"]
			if !hasDF {
				t.Fatalf("screen has no default_filter wired")
			}
			// Wire format: bigint encoded as a JSON string (see card_ref
			// reviver in dispatch). Trim outer quotes for the compare.
			var dfStr string
			if err := json.Unmarshal(dfRaw, &dfStr); err != nil {
				// Some code paths emit raw number; fall back to int decode.
				var dfNum int64
				if err2 := json.Unmarshal(dfRaw, &dfNum); err2 != nil {
					t.Fatalf("decode default_filter: %v / %v", err, err2)
				}
				if dfNum != filter.ID {
					t.Errorf("default_filter: got %d, want %d", dfNum, filter.ID)
				}
				return
			}
			if dfStr != fmt.Sprintf("%d", filter.ID) {
				t.Errorf("default_filter: got %q, want %d", dfStr, filter.ID)
			}
		})
	}
}
