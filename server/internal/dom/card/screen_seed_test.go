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
// (slug, layout, title, sort_order, hotkey) tuples against a
// freshly-inserted project and confirms each row materialises in the
// DB with the correct attributes. The shape mirrors the install-seed
// template (tpl_project + screens 17..22, 26) which card.insert
// graph-copies into every fresh project via copy_project_template.
// When the template grows another screen, extend the matrix here.
func TestProjectInsertSeedsScreens(t *testing.T) {
	srv, _ := setupAttr(t, "kitp_test_project_screen_seed")
	ctx := auth.WithSystemUser(context.Background())

	// Create a project via card.insert; the project hook graph-copies
	// the standard template (is_template=true) into the new project.
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

	// Data-table expectations. Mirrors the install seed's tpl_project
	// descendants (seed.hcsv §"Template screens").
	type want struct {
		slug      string
		layout    string
		title     string
		sortOrder int64
		hotkey    string // empty when the template doesn't bind one
	}
	wants := []want{
		{slug: "inbox", layout: "list", title: "Inbox", sortOrder: 1, hotkey: "i"},
		{slug: "grid", layout: "grid", title: "Grid", sortOrder: 2, hotkey: "g"},
		{slug: "kanban", layout: "kanban", title: "Kanban", sortOrder: 3, hotkey: "k"},
		{slug: "project", layout: "project", title: "Project", sortOrder: 4},
		{slug: "ideas", layout: "list", title: "Ideas", sortOrder: 5, hotkey: "n"},
		{slug: "archive", layout: "list", title: "Closed last 30d", sortOrder: 6},
		{slug: "comms", layout: "list", title: "Comms", sortOrder: 7, hotkey: "c"},
	}
	if len(sOut.Rows) != len(wants) {
		t.Fatalf("screen count: got %d, want %d", len(sOut.Rows), len(wants))
	}

	// Index seeded screens by slug for table-driven checks.
	bySlug := map[string]card.CardWithAttrs{}
	for _, r := range sOut.Rows {
		var slugRaw string
		if err := json.Unmarshal(r.Attributes["slug"], &slugRaw); err != nil {
			t.Fatalf("decode slug on card %d: %v", r.ID, err)
		}
		bySlug[slugRaw] = r
	}

	for _, w := range wants {
		t.Run(w.slug, func(t *testing.T) {
			screen, ok := bySlug[w.slug]
			if !ok {
				t.Fatalf("no screen seeded for slug %q", w.slug)
			}
			var layoutRaw string
			if err := json.Unmarshal(screen.Attributes["layout"], &layoutRaw); err != nil {
				t.Fatalf("decode layout: %v", err)
			}
			if layoutRaw != w.layout {
				t.Errorf("layout: got %q, want %q", layoutRaw, w.layout)
			}
			if w.hotkey == "" {
				if raw, ok := screen.Attributes["hotkey"]; ok {
					t.Errorf("hotkey: got %s, want absent", raw)
				}
			} else {
				var hkRaw string
				if err := json.Unmarshal(screen.Attributes["hotkey"], &hkRaw); err != nil {
					t.Fatalf("decode hotkey: %v", err)
				}
				if hkRaw != w.hotkey {
					t.Errorf("hotkey: got %q, want %q", hkRaw, w.hotkey)
				}
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
		})
	}
}
