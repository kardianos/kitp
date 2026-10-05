// Package activitysink: digest.go turns a delivery's matched activity rows
// into a Digest — the events grouped by task, each task's changes rolled
// up — and renders it as plain text (email) or simple HTML (Teams).
//
// Grouping: every row belongs to its SUBJECT card (nearest task
// ancestor-or-self, see scannedRow.SubjectID), so a comm's status change
// or an attachment lands under its task. Groups keep first-seen order.
//
// Roll-up within a group: repeated changes to one attribute of one card
// collapse into a single "first old → last new" line with a change count
// and every actor; comments, attachments and lifecycle events stay one
// line each, in order.
package activitysink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/kitp/kitp/server/internal/named"
)

// Digest is one delivery's content.
type Digest struct {
	ProjectName string
	SinkName    string
	UnitName    string // subscription title (personal) or sink title (broadcast)
	Personal    bool
	PublicURL   string
	EventCount  int
	Groups      []DigestGroup
}

// DigestGroup is one subject card and its rolled-up changes.
type DigestGroup struct {
	CardID   int64
	CardType string
	Title    string
	URL      string // deep link (tasks only, when a public URL is configured)
	Lines    []DigestLine
}

// DigestLine is one rolled-up change.
type DigestLine struct {
	Prefix string // e.g. `Comm "Billing question": ` when the change is on a child card
	Label  string // "Status", "Comment", "Created", …
	Old    string // attribute lines only
	New    string // attribute lines only
	IsAttr bool
	Body   string // multi-line payload (comment text)
	Count  int
	Actors []string
}

// Truncation limits for rendered text.
const (
	titleMaxRunes   = 60
	valueMaxRunes   = 160
	commentMaxRunes = 4000
	teamsMaxBytes   = 24000 // Teams rejects messages past ~28KB
)

type cardInfo struct {
	typeName string
	title    string
}

// buildDigest enriches the matched rows (card titles + types, actor
// names, comment bodies, card_ref display values) and groups them.
func (p *Pumper) buildDigest(ctx context.Context, cfg unitConfig, rows []scannedRow) (Digest, error) {
	cardIDs := map[int64]bool{}
	actorIDs := map[int64]bool{}
	commentIDs := map[int64]bool{}
	for _, r := range rows {
		cardIDs[r.CardID] = true
		cardIDs[r.SubjectID] = true
		actorIDs[r.ActorID] = true
		for _, id := range rowRefIDs(r) {
			cardIDs[id] = true
		}
		if r.Kind == "comment" {
			if id := jsonField(r.ValueNew, "comment_body_id"); id != 0 {
				commentIDs[id] = true
			}
		}
	}
	cards, err := p.loadCardInfo(ctx, keys(cardIDs))
	if err != nil {
		return Digest{}, fmt.Errorf("card titles: %w", err)
	}
	actors, err := p.loadActorNames(ctx, keys(actorIDs))
	if err != nil {
		return Digest{}, fmt.Errorf("actor names: %w", err)
	}
	comments, err := p.loadCommentBodies(ctx, keys(commentIDs))
	if err != nil {
		return Digest{}, fmt.Errorf("comment bodies: %w", err)
	}
	unitName := cfg.unitName
	if unitName == "" {
		unitName = cfg.sinkName
	}
	d := Digest{
		ProjectName: cfg.projectName,
		SinkName:    cfg.sinkName,
		UnitName:    unitName,
		Personal:    p.personal(),
		PublicURL:   p.publicURL,
		EventCount:  len(rows),
	}
	d.Groups = groupRows(rows, cards, actors, comments, p.publicURL)
	return d, nil
}

// groupRows is the pure grouping + roll-up step (unit-tested directly).
func groupRows(rows []scannedRow, cards map[int64]cardInfo, actors map[int64]string, comments map[int64]string, publicURL string) []DigestGroup {
	type attrKey struct {
		cardID int64
		attr   string
	}
	var groups []DigestGroup
	groupIdx := map[int64]int{}
	attrLine := map[attrKey][2]int{} // → (group index, line index)

	for _, r := range rows {
		gi, ok := groupIdx[r.SubjectID]
		if !ok {
			ci := cards[r.SubjectID]
			g := DigestGroup{CardID: r.SubjectID, CardType: ci.typeName, Title: ci.title}
			if ci.typeName == "task" && publicURL != "" {
				g.URL = publicURL + "/task/" + strconv.FormatInt(r.SubjectID, 10)
			}
			groups = append(groups, g)
			gi = len(groups) - 1
			groupIdx[r.SubjectID] = gi
		}
		actor := actors[r.ActorID]
		prefix := ""
		if r.CardID != r.SubjectID {
			ci := cards[r.CardID]
			prefix = typeLabel(ci.typeName)
			if ci.title != "" {
				prefix += " “" + clip(oneLine(ci.title), titleMaxRunes) + "”"
			}
			prefix += ": "
		}

		if isAttrKind(r.Kind) {
			k := attrKey{r.CardID, r.AttributeName}
			newVal := displayValue(r.ValueType, r.ValueNew, cards)
			if pos, ok := attrLine[k]; ok {
				ln := &groups[pos[0]].Lines[pos[1]]
				ln.New = newVal
				ln.Count++
				ln.Actors = addActor(ln.Actors, actor)
				continue
			}
			label := attrLabel(r.AttributeName)
			if label == "" {
				label = "Updated"
			}
			groups[gi].Lines = append(groups[gi].Lines, DigestLine{
				Prefix: prefix,
				Label:  label,
				Old:    displayValue(r.ValueType, r.ValueOld, cards),
				New:    newVal,
				IsAttr: true,
				Count:  1,
				Actors: addActor(nil, actor),
			})
			attrLine[k] = [2]int{gi, len(groups[gi].Lines) - 1}
			continue
		}

		ln := DigestLine{Prefix: prefix, Count: 1, Actors: addActor(nil, actor)}
		switch r.Kind {
		case "card_create":
			ln.Label = "Created"
		case "card_delete":
			ln.Label = "Deleted"
		case "card_undelete":
			ln.Label = "Restored"
		case "comment":
			ln.Label = "Comment"
			ln.Body = clip(strings.TrimSpace(comments[jsonField(r.ValueNew, "comment_body_id")]), commentMaxRunes)
		case "comment_edit":
			ln.Label = "Edited a comment"
			ln.Body = clip(strings.TrimSpace(jsonString(r.ValueNew, "new_body")), commentMaxRunes)
		case "attachment_create":
			ln.Label = "Attached " + quoted(jsonString(r.ValueNew, "filename"))
		case "attachment_delete":
			ln.Label = "Removed attachment " + quoted(jsonString(r.ValueOld, "filename"))
		case "card_move":
			ln.Label = "Moved under " + quoted(cards[jsonScalarID(r.ValueNew)].title)
		case "task_move":
			ln.Label = "Moved to project " + quoted(cards[jsonField(r.ValueNew, "new_project_id")].title)
		case "card_merge":
			ln.Label = "Merged duplicates"
		case "card_set_phase":
			ln.Label = "Phase: " + displayValue("text", r.ValueOld, cards) + " → " + displayValue("text", r.ValueNew, cards)
		default:
			ln.Label = humanize(r.Kind)
		}
		groups[gi].Lines = append(groups[gi].Lines, ln)
	}
	return groups
}

func isAttrKind(kind string) bool {
	switch kind {
	case "attr_update", "tag_apply", "tag_remove":
		return true
	}
	return false
}

func addActor(list []string, name string) []string {
	if name == "" {
		return list
	}
	for _, a := range list {
		if a == name {
			return list
		}
	}
	return append(list, name)
}

// ---- rendering ----

// Subject is the email subject / Teams heading line.
func (d Digest) Subject() string {
	prefix := ""
	if d.ProjectName != "" {
		prefix = "[" + oneLine(d.ProjectName) + "] "
	}
	if len(d.Groups) == 1 {
		g := d.Groups[0]
		return prefix + groupHeading(g)
	}
	return prefix + d.summary()
}

func (d Digest) summary() string {
	noun := "task"
	for _, g := range d.Groups {
		if g.CardType != "task" {
			noun = "item"
			break
		}
	}
	return fmt.Sprintf("%s on %s", plural(d.EventCount, "update"), plural(len(d.Groups), noun))
}

// plural renders "1 task" / "3 tasks".
func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return strconv.Itoa(n) + " " + noun + "s"
}

// groupHeading is "#1234 Truncated title" (type-labelled for non-tasks).
func groupHeading(g DigestGroup) string {
	title := clip(oneLine(g.Title), titleMaxRunes)
	head := "#" + strconv.FormatInt(g.CardID, 10)
	if g.CardType != "task" && g.CardType != "" {
		head = typeLabel(g.CardType) + " " + head
	}
	if title == "" {
		return head
	}
	return head + " " + title
}

func (ln DigestLine) text() string {
	var b strings.Builder
	b.WriteString(ln.Prefix)
	b.WriteString(ln.Label)
	if ln.IsAttr {
		b.WriteString(": ")
		b.WriteString(ln.Old)
		b.WriteString(" → ")
		b.WriteString(ln.New)
		if ln.Count > 1 {
			fmt.Fprintf(&b, " (%d changes)", ln.Count)
		}
	}
	if len(ln.Actors) > 0 {
		b.WriteString("  — ")
		b.WriteString(strings.Join(ln.Actors, ", "))
	}
	return b.String()
}

// Text renders the plain-text email body.
func (d Digest) Text() string {
	var b strings.Builder
	head := d.summary()
	if d.ProjectName != "" {
		head = oneLine(d.ProjectName) + " — " + head
	}
	b.WriteString(head)
	b.WriteString("\n")
	for _, g := range d.Groups {
		b.WriteString("\n")
		b.WriteString(groupHeading(g))
		b.WriteString("\n")
		if g.URL != "" {
			b.WriteString(g.URL)
			b.WriteString("\n")
		}
		for _, ln := range g.Lines {
			b.WriteString("  - ")
			b.WriteString(ln.text())
			b.WriteString("\n")
			if ln.Body != "" {
				for _, l := range strings.Split(strings.ReplaceAll(ln.Body, "\r\n", "\n"), "\n") {
					b.WriteString("      ")
					b.WriteString(l)
					b.WriteString("\n")
				}
			}
		}
	}
	b.WriteString("\n-- \n")
	if d.Personal {
		fmt.Fprintf(&b, "You are receiving this because of your notification subscription %s", quoted(oneLine(d.UnitName)))
		if d.ProjectName != "" {
			fmt.Fprintf(&b, " in %s", oneLine(d.ProjectName))
		}
		b.WriteString(".\n")
		if d.PublicURL != "" {
			b.WriteString("Manage your notifications: " + d.PublicURL + "/account\n")
		}
	} else {
		fmt.Fprintf(&b, "Sent by the %s activity sink.\n", quoted(oneLine(d.UnitName)))
	}
	b.WriteString("Replies to this email are not read.\n")
	return b.String()
}

// HTML renders the Teams message: one heading per task with its link and
// a bullet list of rolled-up changes. Groups past teamsMaxBytes are
// summarised as "…and N more" so the post stays under the Teams cap.
func (d Digest) HTML() string {
	var b strings.Builder
	head := d.summary()
	if d.ProjectName != "" {
		head = oneLine(d.ProjectName) + " — " + head
	}
	b.WriteString("<p><b>" + html.EscapeString(head) + "</b></p>")
	for i, g := range d.Groups {
		var gb strings.Builder
		heading := html.EscapeString(groupHeading(g))
		if g.URL != "" {
			heading = `<a href="` + html.EscapeString(g.URL) + `">` + heading + `</a>`
		}
		gb.WriteString("<p><b>" + heading + "</b></p><ul>")
		for _, ln := range g.Lines {
			gb.WriteString("<li>" + html.EscapeString(ln.text()))
			if ln.Body != "" {
				gb.WriteString("<br>" + strings.ReplaceAll(html.EscapeString(ln.Body), "\n", "<br>"))
			}
			gb.WriteString("</li>")
		}
		gb.WriteString("</ul>")
		if b.Len()+gb.Len() > teamsMaxBytes {
			fmt.Fprintf(&b, "<p>…and %d more</p>", len(d.Groups)-i)
			break
		}
		b.WriteString(gb.String())
	}
	return b.String()
}

// ---- value display ----

// displayValue renders one activity value for a change line: card_ref
// ids → card titles, bools → yes/no, text clipped to one line; absent →
// "—".
func displayValue(valueType string, raw []byte, cards map[int64]cardInfo) string {
	v, ok := decodeJSON(raw)
	if !ok || v == nil {
		return "—"
	}
	if valueType == "card_ref" || valueType == "card_ref[]" {
		ids := refIDsOf(v)
		if len(ids) == 0 {
			return "—"
		}
		names := make([]string, 0, len(ids))
		for _, id := range ids {
			if t := cards[id].title; t != "" {
				names = append(names, clip(oneLine(t), titleMaxRunes))
			} else {
				names = append(names, "#"+strconv.FormatInt(id, 10))
			}
		}
		return strings.Join(names, ", ")
	}
	switch t := v.(type) {
	case string:
		s := clip(oneLine(t), valueMaxRunes)
		if s == "" {
			return "—"
		}
		return s
	case bool:
		if t {
			return "yes"
		}
		return "no"
	case json.Number:
		return t.String()
	case []any:
		if len(t) == 0 {
			return "—"
		}
	}
	buf, err := json.Marshal(v)
	if err != nil {
		return "—"
	}
	return clip(string(buf), valueMaxRunes)
}

// rowRefIDs lists the card ids a row's display needs a title for.
func rowRefIDs(r scannedRow) []int64 {
	var out []int64
	if r.ValueType == "card_ref" || r.ValueType == "card_ref[]" {
		for _, raw := range [][]byte{r.ValueOld, r.ValueNew} {
			if v, ok := decodeJSON(raw); ok {
				out = append(out, refIDsOf(v)...)
			}
		}
	}
	switch r.Kind {
	case "card_move":
		if id := jsonScalarID(r.ValueNew); id != 0 {
			out = append(out, id)
		}
	case "task_move":
		if id := jsonField(r.ValueNew, "new_project_id"); id != 0 {
			out = append(out, id)
		}
	}
	return out
}

// refIDsOf extracts card ids from a card_ref (number / numeric string) or
// card_ref[] value.
func refIDsOf(v any) []int64 {
	switch t := v.(type) {
	case json.Number:
		if id, err := t.Int64(); err == nil {
			return []int64{id}
		}
	case string:
		if id, err := strconv.ParseInt(t, 10, 64); err == nil {
			return []int64{id}
		}
	case []any:
		var out []int64
		for _, e := range t {
			out = append(out, refIDsOf(e)...)
		}
		return out
	}
	return nil
}

func decodeJSON(raw []byte) (any, bool) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	return v, true
}

// jsonField reads an id-valued key (number or numeric string) off a JSON object.
func jsonField(raw []byte, key string) int64 {
	v, ok := decodeJSON(raw)
	if !ok {
		return 0
	}
	m, ok := v.(map[string]any)
	if !ok {
		return 0
	}
	ids := refIDsOf(m[key])
	if len(ids) != 1 {
		return 0
	}
	return ids[0]
}

// jsonScalarID reads a bare id value (number or numeric string).
func jsonScalarID(raw []byte) int64 {
	v, ok := decodeJSON(raw)
	if !ok {
		return 0
	}
	ids := refIDsOf(v)
	if len(ids) != 1 {
		return 0
	}
	return ids[0]
}

func jsonString(raw []byte, key string) string {
	v, ok := decodeJSON(raw)
	if !ok {
		return ""
	}
	m, ok := v.(map[string]any)
	if !ok {
		return ""
	}
	s, _ := m[key].(string)
	return s
}

// attrLabel humanises an attribute_def name: "milestone_ref" → "Milestone",
// "due_date" → "Due date".
func attrLabel(name string) string {
	return humanize(strings.TrimSuffix(name, "_ref"))
}

// typeLabel humanises a card_type name: "comm" → "Comm".
func typeLabel(name string) string {
	if name == "" {
		return "Card"
	}
	return humanize(name)
}

func humanize(s string) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "_", " "))
	if s == "" {
		return ""
	}
	r, size := utf8.DecodeRuneInString(s)
	return strings.ToUpper(string(r)) + s[size:]
}

func quoted(s string) string {
	if s == "" {
		return "“”"
	}
	return "“" + clip(oneLine(s), titleMaxRunes) + "”"
}

// oneLine collapses all whitespace runs (incl. newlines) to single spaces.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// clip truncates to n runes with an ellipsis, never splitting a rune, and
// backs off to the last word boundary when one sits in the final third.
func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)[:n]
	for i := len(runes) - 1; i > n*2/3; i-- {
		if runes[i] == ' ' {
			runes = runes[:i]
			break
		}
	}
	return strings.TrimRight(string(runes), " ") + "…"
}

func keys(m map[int64]bool) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---- lookups ----

func (p *Pumper) loadCardInfo(ctx context.Context, ids []int64) (map[int64]cardInfo, error) {
	out := map[int64]cardInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	b := named.New()
	b.Set("ids", ids)
	sql, args, err := b.Compile(`
		SELECT c.id, ct.name, ` + attrSQL("c.id", "title", "") + `
		FROM card c JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.id = ANY(CAST(:ids AS bigint[]))
	`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var ci cardInfo
		if err := rows.Scan(&id, &ci.typeName, &ci.title); err != nil {
			return nil, err
		}
		out[id] = ci
	}
	return out, rows.Err()
}

func (p *Pumper) loadActorNames(ctx context.Context, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	b := named.New()
	b.Set("ids", ids)
	sql, args, err := b.Compile(`
		SELECT id, COALESCE(display_name, '') FROM user_account
		WHERE id = ANY(CAST(:ids AS bigint[]))
	`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var name string
		if err := rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out[id] = name
	}
	return out, rows.Err()
}

func (p *Pumper) loadCommentBodies(ctx context.Context, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	b := named.New()
	b.Set("ids", ids)
	sql, args, err := b.Compile(`
		SELECT id, body FROM comment_body WHERE id = ANY(CAST(:ids AS bigint[]))
	`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := p.pool.P.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var body string
		if err := rows.Scan(&id, &body); err != nil {
			return nil, err
		}
		out[id] = body
	}
	return out, rows.Err()
}
