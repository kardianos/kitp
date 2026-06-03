package mcp

import "github.com/kitp/kitp/server/internal/reg"

// curatedTools is the single source of truth for the MCP `tools/list`
// surface: the deliberately small set of agent-facing operations
// advertised as standalone, fully-typed tools. It is an axis SEPARATE
// from HTTP/role authz — a handler can be perfectly valid over HTTP
// (and reachable via the proc__batch meta-tool) without cluttering an
// LLM's tool catalogue.
//
// Everything NOT listed here stays reachable: proc__search discovers
// any op + its input schema, and proc__batch invokes it (role- and
// authz-checked exactly like a direct call). Review/trim the LLM tool
// surface HERE rather than hunting flags across handler registrations.
//
// Names are "<endpoint>__<action>". TestCuratedToolsAreRegistered
// guards against drift (a curated name that no longer resolves to a
// registered handler fails the test).
var curatedTools = map[string]bool{
	// Card + task reads.
	"card__search":                 true,
	"card__select":                 true,
	"card__select_with_attributes": true,
	"card_type__select":            true,
	"attribute_def__select":        true,
	"activity__poll":               true,
	"activity__select":             true,
	// Card + task writes.
	"card__insert":      true,
	"card__move":        true,
	"card__set_phase":   true,
	"card__delete":      true,
	"card__undelete":    true,
	"attribute__update": true,
	"task__move":        true,
	// Comments.
	"comment__insert": true,
	"comment__update": true,
	// Attachments + the file/CAS upload plumbing they depend on.
	"attachment__list":         true,
	"attachment__create":       true,
	"attachment__download_url": true,
	"attachment__delete":       true,
	"file__create":             true,
	"cas__missing_chunks":      true,
	// Tags.
	"tag__apply":  true,
	"tag__remove": true,
	// Flow transition reads (what a card may currently fire).
	"flow__list":               true,
	"flow_step__list":          true,
	"flow_step__list_for_card": true,
	// Comm threads: read-only display alongside a task (management /
	// outbound reply ops stay off the list, reachable via proc__batch).
	"comm__list_for_task": true,
	// Personal per-card sort order (inbox drag-drop reorder).
	"user_card_sort__set": true,
	// Misc agent-facing affordances.
	"config__get":      true,
	"help__get_topic":  true,
	"help__get_screen": true,
	// Discovery + connectivity. proc__search is how the LLM finds the
	// long tail; echo__ping is the dispatcher smoke test.
	"proc__search": true,
	"echo__ping":   true,
}

// isCuratedTool reports whether a handler is advertised as a standalone
// MCP tool.
func isCuratedTool(h reg.Handler) bool {
	return curatedTools[h.Endpoint+"__"+h.Action]
}

// CuratedToolNames returns the curated tool names ("<endpoint>__<action>")
// advertised in tools/list. Exported so a test in a package with the
// full handler registry loaded can assert every name still resolves to
// a registered handler (drift guard).
func CuratedToolNames() []string {
	names := make([]string, 0, len(curatedTools))
	for name := range curatedTools {
		names = append(names, name)
	}
	return names
}
