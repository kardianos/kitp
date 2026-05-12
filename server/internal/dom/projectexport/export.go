// Package projectexport implements the simple-CSV export endpoint
// (phase 3 of docs/PROJECT_PORTABILITY_PLAN.md). One row per task,
// columns are flattened so the file is self-contained: id, title,
// status, assignee email + name, milestone title, component title,
// tag paths, description, sort_order, created_at, deleted_at, and
// every comment body joined into one cell with `\n---\n`.
//
// The endpoint lives outside the JSON batch dispatcher because the
// response is text/csv with no JSON envelope; reusing
// attachment.RegisterHTTP's pattern (a dedicated HTTP route streamed
// straight to the writer) is the cleanest fit. Authz is done inline:
// the caller must hold a card.update grant on the project's
// card_type (admin / manager / system in v1).
package projectexport

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the export routes into the rest of the server.
//
//   - Pool is the dispatcher pool used for every read.
//   - Storage is the CAS storage chain; required for the full-zip
//     endpoint (which streams attachment bytes). The simple-csv
//     endpoint never reads from Storage and tolerates nil.
//   - Logger is optional (defaults to slog.Default).
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
	Logger  *slog.Logger
}

// RegisterHTTP mounts the export routes on `mux`:
//
//   - GET /api/v1/project/{id}/export.csv?include_deleted=1
//     One CSV, one row per task.
//   - GET /api/v1/project/{id}/export.zip?include_deleted=1&include_attachments=1&include_activity=1
//     A streamed ZIP containing project / tasks / comments /
//     milestones / components / tags / persons CSVs, plus an
//     optional activity.csv and attachments/ folder.
func RegisterHTTP(mux *http.ServeMux, cfg Config) {
	mux.HandleFunc("GET /api/v1/project/{id}/export.csv", func(w http.ResponseWriter, r *http.Request) {
		if err := handleSimpleCSV(r.Context(), w, r, cfg); err != nil {
			writeErr(w, cfg.Logger, err)
		}
	})
	mux.HandleFunc("GET /api/v1/project/{id}/export.zip", func(w http.ResponseWriter, r *http.Request) {
		if err := handleFullZip(r.Context(), w, r, cfg); err != nil {
			writeErr(w, cfg.Logger, err)
		}
	})
}

// handleSimpleCSV streams one CSV row per task. Headers are emitted
// up-front and the body follows; on a streaming failure mid-response
// the connection just closes with a truncated payload (logged) —
// there is no graceful way to undo a 200 once bytes are out.
func handleSimpleCSV(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config) error {
	user, ok := auth.FromContext(ctx)
	if !ok || user == nil || user.ID == 0 {
		return httpError(http.StatusUnauthorized, "login required")
	}

	idStr := r.PathValue("id")
	projectID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || projectID <= 0 {
		return httpError(http.StatusBadRequest, "invalid project id")
	}
	includeDeleted := r.URL.Query().Get("include_deleted") == "1"

	// Verify the project exists and pick up its title (drives the
	// Content-Disposition filename). A single row tells us both whether
	// the id is real and that it's actually a project, not some other
	// card_type.
	projectTitle, err := loadProjectTitle(ctx, cfg.Pool, projectID)
	if err != nil {
		return err
	}

	// Authz: card.update grant on the project's card_type, optionally
	// scoped to this project. system / admin / manager all pass.
	auth, err := isAuthorized(ctx, cfg.Pool, user.ID, projectID)
	if err != nil {
		return httpError(http.StatusInternalServerError, "authz: "+err.Error())
	}
	if !auth {
		return httpError(http.StatusForbidden, "not authorized to export this project")
	}

	tasks, err := loadTaskRows(ctx, cfg.Pool, projectID, includeDeleted)
	if err != nil {
		return err
	}

	// Pull every referenced lookup (persons / milestones / components /
	// tags) in one round-trip each, keyed by the ids the tasks point at.
	personIDs, milestoneIDs, componentIDs, tagIDs := collectReferencedIDs(tasks)
	personLookup, err := loadPersonLookup(ctx, cfg.Pool, personIDs)
	if err != nil {
		return err
	}
	ids := append([]int64{}, milestoneIDs...)
	ids = append(ids, componentIDs...)
	titleLookup, err := loadTitleLookup(ctx, cfg.Pool, ids)
	if err != nil {
		return err
	}
	tagPaths, err := loadTagPaths(ctx, cfg.Pool, tagIDs)
	if err != nil {
		return err
	}
	commentsByTask, err := loadComments(ctx, cfg.Pool, taskIDsOf(tasks))
	if err != nil {
		return err
	}

	// Headers go before any bytes; csv.Writer flushes lazily, so we
	// drive Flush() explicitly to avoid buffering the whole project in
	// memory for very large exports.
	filename := simpleExportFilename(projectID, projectTitle)
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, filename))

	cw := csv.NewWriter(w)
	header := []string{
		"id", "title", "assignee_email", "assignee_name",
		"milestone", "component", "tags", "description", "sort_order",
		"created_at", "deleted_at", "comments",
	}
	if err := cw.Write(header); err != nil {
		return httpError(http.StatusInternalServerError, "write header: "+err.Error())
	}
	for _, t := range tasks {
		row := []string{
			strconv.FormatInt(t.ID, 10),
			t.Title,
			emailOrEmpty(personLookup, t.AssigneeID),
			titleOrEmpty(personLookup, t.AssigneeID),
			titleLookup[t.MilestoneID],
			titleLookup[t.ComponentID],
			joinTagPaths(t.TagIDs, tagPaths),
			t.Description,
			t.SortOrder,
			isoOrEmpty(t.CreatedAt),
			isoOrEmpty(t.DeletedAt),
			strings.Join(commentsByTask[t.ID], "\n---\n"),
		}
		if err := cw.Write(row); err != nil {
			return httpError(http.StatusInternalServerError, "write row: "+err.Error())
		}
	}
	cw.Flush()
	return cw.Error()
}

// taskRow holds the data we need for one CSV line. Pointer-ish ids
// (assignee / milestone_ref / component_ref) are 0 when the attribute
// is unset; tagIDs is nil when the tags list is empty.
type taskRow struct {
	ID          int64
	Title       string
	Description string
	SortOrder   string
	AssigneeID  int64
	MilestoneID int64
	ComponentID int64
	TagIDs      []int64
	CreatedAt   *time.Time
	DeletedAt   *time.Time
}

// loadProjectTitle returns the project's title attribute. Errors with
// 404 when the id is missing or refers to a non-project card.
func loadProjectTitle(ctx context.Context, pool *store.Pool, projectID int64) (string, error) {
	var title *string
	err := pool.P.QueryRow(ctx, `
		SELECT (
			SELECT av.value #>> '{}'
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id AND ad.name = 'title'
		)
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		WHERE c.id = $1 AND ct.name = 'project'
	`, projectID).Scan(&title)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", httpError(http.StatusNotFound, "project not found")
		}
		return "", httpError(http.StatusInternalServerError, "lookup project: "+err.Error())
	}
	if title == nil {
		return "", nil
	}
	return *title, nil
}

// isAuthorized: caller has card.update grant on the project card_type,
// either global or scoped to this project. Mirrors the dispatcher's
// authz contract — system / admin / manager pass; worker / viewer do not.
func isAuthorized(ctx context.Context, pool *store.Pool, userID, projectID int64) (bool, error) {
	var ok bool
	err := pool.P.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM user_role ur
			JOIN role r        ON r.id  = ur.role_id
			JOIN role_grant rg ON rg.role_id = r.id
			JOIN card_type ct  ON ct.id = rg.card_type_id AND ct.name = 'project'
			JOIN process p     ON p.id  = rg.process_id   AND p.name = 'card.update'
			WHERE ur.user_id = $1
			  AND (ur.scope_card_id IS NULL OR ur.scope_card_id = $2)
		)
	`, userID, projectID).Scan(&ok)
	return ok, err
}

// loadTaskRows pulls every task under projectID, hydrated with the
// flattened attribute values needed for the CSV. One query, one
// LATERAL aggregate — same pattern as card.select_with_attributes.
func loadTaskRows(ctx context.Context, pool *store.Pool, projectID int64, includeDeleted bool) ([]taskRow, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT c.id, c.created_at, c.deleted_at,
		       coalesce(attrs.values, '{}'::jsonb) AS attrs
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id
		LEFT JOIN LATERAL (
			SELECT jsonb_object_agg(ad.name, av.value) AS values
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
		) attrs ON TRUE
		WHERE ct.name = 'task' AND c.parent_card_id = $1
		  AND ($2 OR c.deleted_at IS NULL)
		ORDER BY c.id
	`, projectID, includeDeleted)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load tasks: "+err.Error())
	}
	defer rows.Close()

	var out []taskRow
	for rows.Next() {
		var t taskRow
		var attrsRaw []byte
		if err := rows.Scan(&t.ID, &t.CreatedAt, &t.DeletedAt, &attrsRaw); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan task: "+err.Error())
		}
		attrs := map[string]json.RawMessage{}
		if len(attrsRaw) > 0 {
			if err := json.Unmarshal(attrsRaw, &attrs); err != nil {
				return nil, httpError(http.StatusInternalServerError, "decode attrs: "+err.Error())
			}
		}
		t.Title = jsonAsText(attrs["title"])
		t.Description = jsonAsText(attrs["description"])
		t.SortOrder = jsonAsNumberText(attrs["sort_order"])
		t.AssigneeID = jsonAsCardID(attrs["assignee"])
		t.MilestoneID = jsonAsCardID(attrs["milestone_ref"])
		t.ComponentID = jsonAsCardID(attrs["component_ref"])
		t.TagIDs = jsonAsCardIDArray(attrs["tags"])
		out = append(out, t)
	}
	return out, rows.Err()
}

// collectReferencedIDs scans every task and returns the set of
// referenced person / milestone / component / tag ids so each lookup
// can fire as a single batched query.
func collectReferencedIDs(tasks []taskRow) (persons, milestones, components, tags []int64) {
	personSet := map[int64]struct{}{}
	mileSet := map[int64]struct{}{}
	compSet := map[int64]struct{}{}
	tagSet := map[int64]struct{}{}
	for _, t := range tasks {
		if t.AssigneeID != 0 {
			personSet[t.AssigneeID] = struct{}{}
		}
		if t.MilestoneID != 0 {
			mileSet[t.MilestoneID] = struct{}{}
		}
		if t.ComponentID != 0 {
			compSet[t.ComponentID] = struct{}{}
		}
		for _, id := range t.TagIDs {
			if id != 0 {
				tagSet[id] = struct{}{}
			}
		}
	}
	return keys(personSet), keys(mileSet), keys(compSet), keys(tagSet)
}

func keys(m map[int64]struct{}) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

type personInfo struct {
	Title string
	Email string
}

func loadPersonLookup(ctx context.Context, pool *store.Pool, ids []int64) (map[int64]personInfo, error) {
	out := map[int64]personInfo{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT c.id,
		       (SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name = 'title') AS title,
		       (SELECT av.value #>> '{}' FROM attribute_value av JOIN attribute_def ad ON ad.id = av.attribute_def_id WHERE av.card_id = c.id AND ad.name = 'email') AS email
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'person'
		WHERE c.id = ANY($1::bigint[])
	`, ids)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load persons: "+err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var title, email *string
		if err := rows.Scan(&id, &title, &email); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan person: "+err.Error())
		}
		out[id] = personInfo{Title: derefStr(title), Email: derefStr(email)}
	}
	return out, rows.Err()
}

// loadTitleLookup returns id -> title for any card kind. Used for the
// milestone / component columns since both carry the title attribute.
func loadTitleLookup(ctx context.Context, pool *store.Pool, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT c.id, av.value #>> '{}'
		FROM card c
		LEFT JOIN attribute_value av
		  JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'title'
		  ON av.card_id = c.id
		WHERE c.id = ANY($1::bigint[])
	`, ids)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load titles: "+err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var title *string
		if err := rows.Scan(&id, &title); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan title: "+err.Error())
		}
		out[id] = derefStr(title)
	}
	return out, rows.Err()
}

// loadTagPaths returns id -> path for every tag card referenced. Tags
// surface as their slash-delimited `path` attribute (priority/high
// etc.) — that's the value the kanban / inbox chips render.
func loadTagPaths(ctx context.Context, pool *store.Pool, ids []int64) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT c.id, av.value #>> '{}'
		FROM card c
		LEFT JOIN attribute_value av
		  JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'path'
		  ON av.card_id = c.id
		WHERE c.id = ANY($1::bigint[])
	`, ids)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load tag paths: "+err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var path *string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan tag path: "+err.Error())
		}
		out[id] = derefStr(path)
	}
	return out, rows.Err()
}

// loadComments returns ordered (created_at asc) comment_body texts
// per task. The export joins them with the `\n---\n` separator at
// render time so each task occupies a single CSV cell.
func loadComments(ctx context.Context, pool *store.Pool, taskIDs []int64) (map[int64][]string, error) {
	out := map[int64][]string{}
	if len(taskIDs) == 0 {
		return out, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT a.card_id, cb.body
		FROM activity a
		JOIN comment_body cb ON cb.id = (a.value_new ->> 'comment_body_id')::bigint
		WHERE a.kind = 'comment' AND a.card_id = ANY($1::bigint[])
		ORDER BY a.card_id, a.created_at, a.id
	`, taskIDs)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load comments: "+err.Error())
	}
	defer rows.Close()
	for rows.Next() {
		var cardID int64
		var body string
		if err := rows.Scan(&cardID, &body); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan comment: "+err.Error())
		}
		out[cardID] = append(out[cardID], body)
	}
	return out, rows.Err()
}

func taskIDsOf(tasks []taskRow) []int64 {
	out := make([]int64, len(tasks))
	for i, t := range tasks {
		out[i] = t.ID
	}
	return out
}

// simpleExportFilename builds `project-<slug>-<id>.csv`. The slug is
// the title lowercased with non-alphanum collapsed to hyphens; the id
// suffix keeps it unambiguous when two projects share a title or the
// title is empty.
func simpleExportFilename(id int64, title string) string {
	return fmt.Sprintf("project-%s-%d.csv", slugify(title), id)
}

func slugify(s string) string {
	if s == "" {
		return "untitled"
	}
	var b strings.Builder
	prevHyphen := true
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			prevHyphen = false
		default:
			if !prevHyphen {
				b.WriteRune('-')
				prevHyphen = true
			}
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		return "untitled"
	}
	return out
}

// jsonAsText returns the underlying text of a JSON value. Strings are
// unquoted; numbers / booleans render via their JSON form; null and
// empty inputs return "".
func jsonAsText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(t)
	default:
		return string(raw)
	}
}

// jsonAsNumberText preserves integer formatting (no trailing ".0").
func jsonAsNumberText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	s := strings.TrimSpace(string(raw))
	if s == "null" {
		return ""
	}
	// numeric or quoted numeric — return without quotes
	s = strings.Trim(s, `"`)
	if s == "" {
		return ""
	}
	return s
}

// jsonAsCardID handles both quoted-string id ("42") and bare-number id
// (42) — both shapes exist in attribute_value depending on whether
// the row was written via the dispatcher (string) or the seed
// (number).
func jsonAsCardID(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	s := strings.TrimSpace(string(raw))
	if s == "null" || s == "" {
		return 0
	}
	s = strings.Trim(s, `"`)
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0
	}
	return n
}

func jsonAsCardIDArray(raw json.RawMessage) []int64 {
	if len(raw) == 0 {
		return nil
	}
	var arr []json.RawMessage
	if err := json.Unmarshal(raw, &arr); err != nil {
		return nil
	}
	out := make([]int64, 0, len(arr))
	for _, el := range arr {
		if id := jsonAsCardID(el); id != 0 {
			out = append(out, id)
		}
	}
	return out
}

func emailOrEmpty(m map[int64]personInfo, id int64) string {
	if id == 0 {
		return ""
	}
	return m[id].Email
}

func titleOrEmpty(m map[int64]personInfo, id int64) string {
	if id == 0 {
		return ""
	}
	return m[id].Title
}

func joinTagPaths(ids []int64, paths map[int64]string) string {
	if len(ids) == 0 {
		return ""
	}
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		if p, ok := paths[id]; ok && p != "" {
			parts = append(parts, p)
		}
	}
	return strings.Join(parts, ",")
}

func isoOrEmpty(t *time.Time) string {
	if t == nil {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// httpErr is the typed error the handler returns; writeErr maps it to
// the wire response. Mirrors attachment/http.go.
type httpErr struct {
	status int
	msg    string
}

func (e *httpErr) Error() string { return e.msg }

func httpError(status int, msg string) error {
	return &httpErr{status: status, msg: msg}
}

func writeErr(w http.ResponseWriter, logger *slog.Logger, err error) {
	status := http.StatusInternalServerError
	msg := err.Error()
	var he *httpErr
	if errors.As(err, &he) {
		status = he.status
		msg = he.msg
	}
	if status >= 500 {
		l := logger
		if l == nil {
			l = slog.Default()
		}
		l.LogAttrs(context.Background(), slog.LevelError, "project export",
			slog.Int("status", status), slog.String("err", msg))
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `{"error":%q}`, msg)
}
