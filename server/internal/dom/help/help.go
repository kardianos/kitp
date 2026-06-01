// Package help serves the in-app per-screen help modal. Two handlers:
//
//   - help.get_topic   — static lookup of authored Markdown by topic key
//     (admin.screens, admin.flows, layout.list, …).
//   - help.get_screen  — composes the per-screen documentation: the
//     embedded layout primer + a plain-English description of the
//     screen's default filter, walked from the predicate AST.
//
// All authored prose lives under `content/` and is go:embed-ed so the
// server ships a single binary with no runtime file dependency.
package help

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"reflect"
	"strings"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

//go:embed content/*.md
var contentFS embed.FS

// topicFiles maps the wire-side topic key to its embedded markdown file.
// Keep keys stable — they appear in client code and in shared links.
// Filters are edited inside the Screens admin page (right pane), so a
// separate "admin.filters" topic is intentionally absent — the
// admin_screens.md body covers both halves of that workflow.
var topicFiles = map[string]string{
	"admin.screens":        "content/admin_screens.md",
	"admin.named_filters":  "content/admin_named_filters.md",
	"admin.flows":          "content/admin_flows.md",
	"admin.projects":       "content/admin_projects.md",
	"admin.attributes":     "content/admin_attributes.md",
	"admin.roles":          "content/admin_roles.md",
	"admin.oidc_claims":    "content/admin_oidc_claims.md",
	"admin.users":          "content/admin_users.md",
	"admin.contacts":       "content/admin_contacts.md",
	"admin.agents":         "content/admin_agents.md",
	"admin.comm_channels":  "content/admin_comm_channels.md",
	"admin.comm_log":       "content/admin_comm_log.md",
	"admin.activity_sinks": "content/admin_activity_sinks.md",
	"task_detail":          "content/task_detail.md",
	"layout.list":          "content/layout_list.md",
	"layout.grid":          "content/layout_grid.md",
	"layout.kanban":        "content/layout_kanban.md",
	"layout.pair":          "content/layout_pair.md",
}

// GetTopicInput is the wire shape for help.get_topic.
type GetTopicInput struct {
	Topic string `json:"topic" mcp:"required,desc=help topic key (e.g. admin.screens, layout.kanban)"`
}

// GetTopicOutput carries the rendered markdown body and a derived title
// (the first H1 heading, used by the modal chrome).
type GetTopicOutput struct {
	Title    string `json:"title" mcp:"desc=human-readable title; the first H1 in the body, or the topic key"`
	Markdown string `json:"markdown" mcp:"desc=markdown body suitable for the in-app help modal"`
}

// GetScreenInput is the wire shape for help.get_screen. The id is the
// `screen` card id resolved by ScreenHost; the handler reads its
// `layout`, `title`, and `default_filter` attributes plus the linked
// filter card's `predicate`, and composes a per-screen markdown body.
type GetScreenInput struct {
	ScreenCardID int64 `json:"screen_card_id,string" mcp:"required,desc=id of the screen card whose help should be generated"`
}

// GetScreenOutput is the same shape as GetTopicOutput so the client can
// render both endpoints through a single component.
type GetScreenOutput struct {
	Title    string `json:"title" mcp:"desc=screen title used as the modal heading"`
	Markdown string `json:"markdown" mcp:"desc=layout primer plus a plain-English description of the default filter"`
}

// Register installs both handlers. Called from cmd/kitpd/main.go.
func Register() {
	reg.Register(reg.Handler{
		Endpoint:     "help",
		Action:       "get_topic",
		Doc:          "Return the authored markdown for a named help topic (admin.screens, layout.kanban, ...).",
		InputType:    reflect.TypeFor[GetTopicInput](),
		OutputType:   reflect.TypeFor[GetTopicOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runGetTopic,
	})
	reg.Register(reg.Handler{
		Endpoint:     "help",
		Action:       "get_screen",
		Doc:          "Compose per-screen help: layout primer + plain-English description of the default filter.",
		InputType:    reflect.TypeFor[GetScreenInput](),
		OutputType:   reflect.TypeFor[GetScreenOutput](),
		AllowedRoles: []string{reg.RoleAuthenticated},
		Run:          runGetScreen,
	})
}

func runGetTopic(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
	outs := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(GetTopicInput)
		body, err := readTopic(in.Topic)
		if err != nil {
			return nil, err
		}
		outs[i] = GetTopicOutput{Title: firstH1(body, in.Topic), Markdown: body}
	}
	return outs, nil
}

func runGetScreen(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
	outs := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(GetScreenInput)
		body, title, err := buildScreenHelp(ctx, tx, in.ScreenCardID)
		if err != nil {
			return nil, err
		}
		outs[i] = GetScreenOutput{Title: title, Markdown: body}
	}
	return outs, nil
}

// readTopic returns the embedded markdown for [topic] or an error when
// the topic is unknown.
func readTopic(topic string) (string, error) {
	path, ok := topicFiles[topic]
	if !ok {
		return "", fmt.Errorf("help: unknown topic %q", topic)
	}
	b, err := fs.ReadFile(contentFS, path)
	if err != nil {
		return "", fmt.Errorf("help: read embedded %q: %w", path, err)
	}
	return string(b), nil
}

// firstH1 picks the first markdown H1 (`# Heading`) from [body] for use
// as the modal title; falls back to [fallback] when no H1 is present.
func firstH1(body, fallback string) string {
	for line := range strings.SplitSeq(body, "\n") {
		s := strings.TrimSpace(line)
		if rest, ok := strings.CutPrefix(s, "# "); ok {
			return strings.TrimSpace(rest)
		}
	}
	return fallback
}

// buildScreenHelp assembles per-screen markdown: heading + layout primer
// + filter prose. Missing attributes degrade gracefully: an unknown
// layout drops the primer; an absent / unparseable predicate falls
// through to a generic "every task in this project" line.
func buildScreenHelp(ctx context.Context, tx store.Querier, screenID int64) (string, string, error) {
	attrs, err := loadCardAttrs(ctx, tx, screenID)
	if err != nil {
		return "", "", err
	}
	title := stringAttr(attrs, "title")
	if title == "" {
		title = fmt.Sprintf("Screen #%d", screenID)
	}
	layout := stringAttr(attrs, "layout")
	defaultFilterID := idAttr(attrs, "default_filter")

	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\n", title)

	if primer, err := readTopic("layout." + layout); err == nil {
		b.WriteString(primer)
		if !strings.HasSuffix(primer, "\n") {
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}

	b.WriteString("## What this view shows\n\n")
	prose, err := buildFilterProse(ctx, tx, defaultFilterID)
	if err != nil {
		// Don't fail the whole help fetch on a single bad predicate; the
		// layout primer is still useful. Surface a neutral sentence so
		// the user is not staring at a missing section.
		prose = "This view applies the screen's default filter."
	}
	b.WriteString(prose)
	b.WriteString("\n")

	return b.String(), title, nil
}

// buildFilterProse renders the per-screen sentence describing what the
// default filter selects. When the screen has no default filter we
// return the no-filter line.
func buildFilterProse(ctx context.Context, tx store.Querier, filterID int64) (string, error) {
	if filterID == 0 {
		return "This view shows every task in the project, with no extra filter applied.", nil
	}
	attrs, err := loadCardAttrs(ctx, tx, filterID)
	if err != nil {
		return "", err
	}
	raw := stringAttr(attrs, "predicate")
	english, err := RenderPredicateJSON(raw)
	if err != nil {
		return "", err
	}
	name := stringAttr(attrs, "title")
	if name == "" {
		name = "The default filter"
	}
	return fmt.Sprintf("**%s** selects %s.", name, english), nil
}

// loadCardAttrs returns the attribute_value map for a single card id.
// Returns an empty map (not an error) when the card has no attributes;
// returns an error only on query failure.
func loadCardAttrs(ctx context.Context, tx store.Querier, cardID int64) (map[string]json.RawMessage, error) {
	rows, err := tx.Query(ctx, `
		SELECT ad.name, av.value
		FROM attribute_value av
		JOIN attribute_def ad ON ad.id = av.attribute_def_id
		WHERE av.card_id = $1
	`, cardID)
	if err != nil {
		return nil, fmt.Errorf("help: load attrs for card %d: %w", cardID, err)
	}
	defer rows.Close()
	out := map[string]json.RawMessage{}
	for rows.Next() {
		var name string
		var raw []byte
		if err := rows.Scan(&name, &raw); err != nil {
			return nil, fmt.Errorf("help: scan attr: %w", err)
		}
		out[name] = json.RawMessage(append([]byte(nil), raw...))
	}
	return out, rows.Err()
}

// stringAttr unwraps a JSON-string attribute; returns "" when absent or
// not a string.
func stringAttr(m map[string]json.RawMessage, key string) string {
	raw, ok := m[key]
	if !ok {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return ""
	}
	return s
}

// idAttr unwraps a JSON-number attribute as int64; returns 0 when absent
// or not coercible. card_ref values may be encoded as quoted strings on
// the wire (the client's stringifyBigInt), so we accept either shape.
func idAttr(m map[string]json.RawMessage, key string) int64 {
	raw, ok := m[key]
	if !ok {
		return 0
	}
	var n int64
	if err := json.Unmarshal(raw, &n); err == nil {
		return n
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		var n2 int64
		if _, err := fmt.Sscanf(s, "%d", &n2); err == nil {
			return n2
		}
	}
	return 0
}
