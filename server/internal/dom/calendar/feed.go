package calendar

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/obs/logpath"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// FeedPathPrefix is where calendar apps fetch a feed; the rest of the
// path is the secret token, kept out of logs (logpath).
const FeedPathPrefix = "/api/v1/calendar/"

// MaxEvents caps one feed.
const MaxEvents = 5000

// FeedConfig wires the feed route.
type FeedConfig struct {
	Pool *store.Pool
	// PublicURL (KITP_PUBLIC_URL) is the base of the task links; when
	// empty the request's own scheme and host are used.
	PublicURL string
	Logger    *slog.Logger
	// Now is the clock (tests).
	Now func() time.Time
}

var tokenShape = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Mount registers GET /api/v1/calendar/{token}.ics (also without .ics).
// No session: the token is the credential. Nothing is cached — each fetch
// runs the query, so a task's change shows on the next fetch.
func Mount(rt *api.Router, cfg FeedConfig) {
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	logpath.Mark(FeedPathPrefix)
	f := &feed{cfg}
	rt.Public("GET "+FeedPathPrefix+"{file}", f.serve)
}

type feed struct{ FeedConfig }

// calendarRef is what a token reaches.
type calendarRef struct {
	accessID   int64
	calendarID int64
	title      string
	predicate  string
	pastDays   int
	futureDays int
	personID   int64
	userID     int64
}

type event struct {
	taskID   int64
	due      time.Time
	title    string
	project  string
	status   string
	terminal bool
	modified time.Time
}

func (f *feed) serve(ctx context.Context, w http.ResponseWriter, r *http.Request) error {
	token := strings.TrimSuffix(r.PathValue("file"), ".ics")
	ref, ok, err := f.lookup(ctx, token)
	if err != nil {
		return api.Internal(err)
	}
	if !ok {
		http.NotFound(w, r)
		return nil
	}
	evs, err := f.events(ctx, ref)
	if err != nil {
		// A failure (a filter that no longer compiles) answers 500 so the
		// calendar app keeps its last copy; the reason shows on the
		// Account page.
		f.Logger.Warn("calendar feed", "calendar_id", ref.calendarID, "err", err)
		// What the Account page shows: the compiler's own reason for a
		// filter that no longer compiles, never a database error's text
		// (CLAUDE.md; review 2026-11-03 #30). The log has the whole error.
		if nerr := f.note(ctx, ref.accessID, r.UserAgent(), feedErrorText(err)); nerr != nil {
			f.Logger.Warn("calendar feed: note error", "err", nerr)
		}
		return api.Internal(fmt.Errorf("calendar %d: %w", ref.calendarID, err))
	}
	if err := f.note(ctx, ref.accessID, r.UserAgent(), ""); err != nil {
		f.Logger.Warn("calendar feed: note fetch", "err", err)
	}
	body := f.render(r, ref, evs)
	h := w.Header()
	h.Set("Content-Type", "text/calendar; charset=utf-8")
	h.Set("Content-Disposition", `inline; filename="calendar.ics"`)
	h.Set("Cache-Control", "no-cache")
	h.Set("X-Content-Type-Options", "nosniff")
	_, err = w.Write([]byte(body))
	return err
}

// lookup resolves a token to its calendar and owner. A deleted calendar,
// an owner without a login or a disabled person reaches nothing.
func (f *feed) lookup(ctx context.Context, token string) (calendarRef, bool, error) {
	var ref calendarRef
	if !tokenShape.MatchString(token) {
		return ref, false, nil
	}
	b := named.New()
	b.Set("hash", auth.HashSecret(token))
	sql, args, err := b.Compile(`
		SELECT a.id, c.id,
		       COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
		                 WHERE v.card_id = c.id AND d.name = 'title'), ''),
		       COALESCE((SELECT v.value #>> '{}' FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
		                 WHERE v.card_id = c.id AND d.name = 'predicate' AND jsonb_typeof(v.value) = 'string'), ''),
		       COALESCE((SELECT (v.value)::text::int FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
		                 WHERE v.card_id = c.id AND d.name = 'past_days' AND jsonb_typeof(v.value) = 'number'), 30),
		       COALESCE((SELECT (v.value)::text::int FROM attribute_value v JOIN attribute_def d ON d.id = v.attribute_def_id
		                 WHERE v.card_id = c.id AND d.name = 'future_days' AND jsonb_typeof(v.value) = 'number'), 365),
		       uap.person_card_id, uap.user_account_id
		FROM card_access a
		JOIN card c ON c.id = a.card_id AND c.deleted_at IS NULL
		JOIN attribute_value sv ON sv.card_id = c.id
		  AND sv.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'subscriber')
		  AND jsonb_typeof(sv.value) = 'number'
		JOIN user_account_person uap ON uap.person_card_id = (sv.value)::text::bigint
		JOIN card p ON p.id = uap.person_card_id AND p.deleted_at IS NULL
		WHERE a.token_hash = :hash AND a.purpose = 'calendar'
		  AND NOT EXISTS (SELECT 1 FROM attribute_value iv JOIN attribute_def ia ON ia.id = iv.attribute_def_id
		                  WHERE iv.card_id = p.id AND ia.name = 'is_active' AND iv.value = 'false'::jsonb)`)
	if err != nil {
		return ref, false, fmt.Errorf("calendar lookup: compile: %w", err)
	}
	err = f.Pool.P.QueryRow(ctx, sql, args...).Scan(&ref.accessID, &ref.calendarID, &ref.title, &ref.predicate,
		&ref.pastDays, &ref.futureDays, &ref.personID, &ref.userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ref, false, nil
	}
	if err != nil {
		return ref, false, fmt.Errorf("calendar lookup: %w", err)
	}
	return ref, true, nil
}

// events is the one query: tasks the owner can see (DI-6, off areas
// included), matching the calendar's filter, due in the window. The range
// is on the (attribute_def_id, value) btree — the literal value_type_id
// band matches the partial index's predicate, and ISO dates sort in date
// order (every stored date is YYYY-MM-DD; see §1).
func (f *feed) events(ctx context.Context, ref calendarRef) ([]event, error) {
	today := f.Now().UTC().Truncate(24 * time.Hour)
	from := today.AddDate(0, 0, -ref.pastDays).Format("2006-01-02")
	to := today.AddDate(0, 0, ref.futureDays).Format("2006-01-02")

	tx, err := f.Pool.P.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	snap, err := schema.Load(ctx, tx)
	if err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}

	b := named.New()
	filter := "TRUE"
	if tree, ok, err := parseFilter(ref.predicate, ref.personID); err != nil {
		return nil, fmt.Errorf("the calendar's filter is not valid JSON: %w", err)
	} else if ok {
		filter, err = card.CompileTree(ctx, tx, card.CardWhereGroup{Connective: "and", Children: []card.CardWhereTreeNode{tree}}, b.Bind, snap, ref.personID)
		if err != nil {
			return nil, fmt.Errorf("the calendar's filter: %w", err)
		}
	}
	b.Set("user", ref.userID)
	b.Set("from", from)
	b.Set("to", to)
	b.Set("limit", MaxEvents)
	sql, args, err := b.Compile(`
		SELECT c.id, av.value #>> '{}',
		       COALESCE((SELECT t.value #>> '{}' FROM attribute_value t WHERE t.card_id = c.id
		                 AND t.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')), ''),
		       COALESCE((SELECT pt.value #>> '{}' FROM attribute_value pt WHERE pt.card_id = card_enclosing_project(c.id)
		                 AND pt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')), ''),
		       COALESCE(st.title, ''), COALESCE(st.phase = 'terminal', false),
		       COALESCE((SELECT max(a.created_at) FROM activity a WHERE a.card_id = c.id), now())
		FROM attribute_value av
		JOIN card c ON c.id = av.card_id AND c.deleted_at IS NULL
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'task'
		LEFT JOIN LATERAL (
			SELECT s.phase, (SELECT stt.value #>> '{}' FROM attribute_value stt WHERE stt.card_id = s.id
			                 AND stt.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'title')) AS title
			FROM attribute_value sv JOIN card s ON s.id = (sv.value)::text::bigint
			WHERE sv.card_id = c.id AND jsonb_typeof(sv.value) = 'number'
			  AND sv.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'status')
		) st ON true
		WHERE av.attribute_def_id = (SELECT id FROM attribute_def WHERE name = 'due_date')
		  AND av.value_type_id < 50
		  AND av.value >= to_jsonb(:from::text) AND av.value <= to_jsonb(:to::text)
		  AND ` + schema.VisibilityClause("c.id", ":user") + `
		  AND (` + filter + `)
		ORDER BY av.value, c.id
		LIMIT :limit`)
	if err != nil {
		return nil, fmt.Errorf("compile: %w", err)
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []event
	for rows.Next() {
		var e event
		var due string
		if err := rows.Scan(&e.taskID, &due, &e.title, &e.project, &e.status, &e.terminal, &e.modified); err != nil {
			return nil, err
		}
		t, err := time.Parse("2006-01-02", due)
		if err != nil {
			continue // not a stored-form date; migration 0023 cleared these
		}
		e.due = t
		out = append(out, e)
	}
	return out, rows.Err()
}

// parseFilter decodes a stored card filter, with "@me" as the owner's
// person card. Empty / {} = no filter.
func parseFilter(raw string, personID int64) (card.CardWhereTreeNode, bool, error) {
	if strings.TrimSpace(raw) == "" {
		return card.CardWhereTreeNode{}, false, nil
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(raw)))
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	tree = replaceMe(tree, json.Number(strconv.FormatInt(personID, 10)))
	buf, err := json.Marshal(tree)
	if err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	var n card.CardWhereTreeNode
	if err := json.Unmarshal(buf, &n); err != nil {
		return card.CardWhereTreeNode{}, false, err
	}
	if n.Connective == "" && n.Attr == "" {
		return card.CardWhereTreeNode{}, false, nil
	}
	return n, true, nil
}

func replaceMe(v any, me json.Number) any {
	switch t := v.(type) {
	case string:
		if t == "@me" {
			return me
		}
	case []any:
		for i := range t {
			t[i] = replaceMe(t[i], me)
		}
	case map[string]any:
		for k := range t {
			t[k] = replaceMe(t[k], me)
		}
	}
	return v
}

// note records a fetch on the URL: when, which app, and the error (if any).
func (f *feed) note(ctx context.Context, accessID int64, agent, errMsg string) error {
	b := named.New()
	b.Set("id", accessID)
	b.Set("client", truncate(agent, 200))
	b.Set("err", truncate(errMsg, 300))
	sql, args, err := b.Compile(`
		UPDATE card_access SET last_used_at = now(), last_client = :client,
		       last_error = CASE WHEN :err = '' THEN last_error ELSE :err END,
		       last_error_at = CASE WHEN :err = '' THEN last_error_at ELSE now() END
		WHERE id = :id`)
	if err != nil {
		return err
	}
	_, err = f.Pool.P.Exec(ctx, sql, args...)
	return err
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xC0 == 0x80 {
		n--
	}
	return s[:n]
}

// base is where task links point: KITP_PUBLIC_URL, else the request's own
// scheme and host.
func (f *feed) base(r *http.Request) string {
	if f.PublicURL != "" {
		return strings.TrimRight(f.PublicURL, "/")
	}
	scheme := "https"
	if r.TLS == nil && !strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https") {
		scheme = "http"
	}
	return scheme + "://" + r.Host
}

func (f *feed) render(r *http.Request, ref calendarRef, evs []event) string {
	base := f.base(r)
	host := r.Host
	if i := strings.IndexByte(host, ':'); i >= 0 {
		host = host[:i]
	}
	now := icsStamp(f.Now())
	var w icsWriter
	w.prop("BEGIN", "VCALENDAR")
	w.prop("VERSION", "2.0")
	w.prop("PRODID", "-//kitp//calendar feed//EN")
	w.prop("CALSCALE", "GREGORIAN")
	w.prop("METHOD", "PUBLISH")
	w.text("X-WR-CALNAME", ref.title)
	w.prop("REFRESH-INTERVAL;VALUE=DURATION", "PT1H")
	w.prop("X-PUBLISHED-TTL", "PT1H")
	for _, e := range evs {
		link := fmt.Sprintf("%s/task/%d", base, e.taskID)
		summary := fmt.Sprintf("#%d %s", e.taskID, e.title)
		if e.terminal {
			summary = "✓ " + summary
		}
		desc := e.project
		if e.status != "" {
			if desc != "" {
				desc += " · "
			}
			desc += e.status
		}
		if desc != "" {
			desc += "\n"
		}
		desc += link
		w.prop("BEGIN", "VEVENT")
		w.prop("UID", fmt.Sprintf("task-%d@%s", e.taskID, host))
		w.prop("DTSTAMP", now)
		w.prop("LAST-MODIFIED", icsStamp(e.modified))
		w.prop("DTSTART;VALUE=DATE", icsDate(e.due))
		w.prop("DTEND;VALUE=DATE", icsDate(e.due.AddDate(0, 0, 1)))
		w.text("SUMMARY", summary)
		w.text("DESCRIPTION", desc)
		w.prop("URL", link)
		w.prop("TRANSP", "TRANSPARENT")
		w.prop("END", "VEVENT")
	}
	w.prop("END", "VCALENDAR")
	return w.String()
}

// feedErrorText is the reason stored for a feed that failed: the filter's
// own fault when that's what it was, else a generic line.
func feedErrorText(err error) string {
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		return "the calendar couldn't be read; try again later"
	}
	if strings.Contains(err.Error(), "the calendar's filter") {
		return "the calendar's filter no longer works; edit it on the Account page"
	}
	return "the calendar couldn't be read; try again later"
}
