// Package projectstamp implements Gate 10 of FLOW_AND_SCREEN_KERNEL.md:
// the project.stamp handler that produces a fresh project by graph-copying
// a template project (a project card with is_template=true).
//
// Stamping is a single-transaction copy of the template's structural
// graph — value cards (statuses, milestones, components, tags), screen
// cards and their filter children, predicate_snippet cards, flow rows
// scoped to the template, and flow_step rows under those flows. The new
// project's title comes from the handler input; everything else is
// copied with new ids and the internal references between rows
// (card_ref attribute values, flow from/to references, screen flow_ref /
// default_filter / default_create_status, and filter-card predicate
// JSON) are rewritten through the same in-DB id remap so the new
// project's cards reference each other.
//
// Deliberately NOT copied (FLOW_AND_SCREEN_KERNEL §"Project templates"):
//   - task cards and their attribute_values
//   - comment_body rows and activity rows
//   - user_card_sort, user_card_agent (per-user state)
//   - attribute_value rows on the template project itself (the new
//     project's own attributes are managed via the standard
//     attribute.update path; only the title + is_template=false are
//     stamped on creation)
//
// Authz: manager / admin (V26). Workers cannot stamp new projects.
//
// Implementation: Phase 4 of UNIFIED_HANDLER_PLAN.md collapsed the
// per-row Go body into the project_stamp_batch PL/pgSQL function, which
// is itself a one-line wrapper around the shared copy_project_template
// helper that card.insert(project) also calls.
package projectstamp

import (
	"reflect"
	"time"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// StampInput names the template to copy and the title for the fresh
// project. The template_project_id must point at an existing project
// card (is_template is not enforced — a normal project can be stamped
// as a starting shape; V24 covers the empty-template degenerate case).
type StampInput struct {
	TemplateProjectID int64  `json:"template_project_id,string" mcp:"required,desc=id of the project card to use as the source template"`
	Name              string `json:"name" mcp:"required,desc=title for the new project card"`
}

// StampOutput surfaces the new project's id plus a Warnings field so
// callers can show V24-style hints (e.g., "template had no screens").
type StampOutput struct {
	NewProjectID int64    `json:"new_project_id,string" mcp:"desc=id of the freshly stamped project"`
	Warnings     []string `json:"warnings,omitempty" mcp:"desc=non-fatal advisories about the template (e.g. empty template)"`
}

// Register installs the project.stamp handler. The pool parameter is
// unused (the SQLFunc dispatcher captures the pool from the server)
// but the signature is preserved so main.go's wiring stays uniform.
func Register(_ *store.Pool) {
	reg.Register(reg.Handler{
		Endpoint:     "project",
		Action:       "stamp",
		Doc:          "Create a fresh project by graph-copying a template project's value cards, screens, filters, flows, and flow_steps with ID remapping. Tasks, comments, activity, and per-user state are not copied (FLOW_AND_SCREEN_KERNEL §Project templates / Gate 10).",
		InputType:    reflect.TypeFor[StampInput](),
		OutputType:   reflect.TypeFor[StampOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		// project.stamp materialises a brand-new project — there's
		// no pre-existing card to scope-check against (mirrors
		// card.insert's special-case path for top-level project
		// creation in api/authz.go).
		GlobalScope: true,
		Timeout:     60 * time.Second, // graph-copy of template; per S1
		SQLFunc:     "project_stamp_batch",
	})
}
