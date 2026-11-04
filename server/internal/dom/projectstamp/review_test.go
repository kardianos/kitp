package projectstamp_test

import "testing"

// TestStampTemplateWhoseTasksHaveChildren (review 2026-11-03 #26): a
// template's tasks aren't copied, and neither are the links and threads
// under them — before, the walk took them in and the stamp failed with
// "parent … not in remap".
func TestStampTemplateWhoseTasksHaveChildren(t *testing.T) {
	f := setup(t, "kitp_test_projectstamp_task_children")
	f.seedTemplate(t)
	tasks := f.addTemplateTasks(t, 1)
	for _, typ := range []string{"link", "comm"} {
		if _, err := f.sp.P.Exec(f.ctx, `
			INSERT INTO card (card_type_id, parent_card_id) SELECT id, $1 FROM card_type WHERE name = $2`, tasks[0], typ); err != nil {
			t.Fatalf("%s under the template's task: %v", typ, err)
		}
	}
	out := stamp(t, f, f.templateID, "Stamped with task children") // fails the test if the stamp does
	var n int
	if err := f.sp.P.QueryRow(f.ctx, `
		SELECT count(*) FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE ct.name IN ('link', 'comm') AND card_enclosing_project(c.id) = $1`, out.NewProjectID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Errorf("the stamped project got %d links / threads from the template's tasks", n)
	}
}
