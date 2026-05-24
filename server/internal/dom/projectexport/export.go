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
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// Config wires the export routes into the rest of the server.
//
//   - Pool is the dispatcher pool used for every read.
//   - Storage is the CAS storage chain; required for the full-zip
//     endpoint (which streams attachment bytes). The simple-csv
//     endpoint never reads from Storage and tolerates nil.
//
// Logging for 5xx is owned by the apiRouter; this config no longer
// carries a Logger field.
type Config struct {
	Pool    *store.Pool
	Storage *cas.Storage
}

// Mount registers the export routes on the apiRouter as Authed:
//
//   - GET /api/v1/project/{id}/export.csv?include_deleted=1
//     One CSV, one row per task.
//   - GET /api/v1/project/{id}/export.zip?include_deleted=1&include_attachments=1&include_activity=1
//     A streamed ZIP containing project / tasks / comments /
//     milestones / components / tags / persons CSVs, plus an
//     optional activity.csv and attachments/ folder.
//   - GET /api/v1/project/{id}/export.xlsx
//     Same shape as the .csv but emitted as a single-sheet workbook.
//
// Per-resource authz (the caller must hold card.update on the project's
// card_type, scoped or global) lives inline in each handler — see
// isAuthorized below. The wrap layer's session cookie check happens
// before any of the handlers run.
func Mount(rt *api.Router, cfg Config) {
	rt.Authed("GET /api/v1/project/{id}/export.csv", func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
		return handleSimpleCSV(ctx, w, r, cfg, u)
	})
	rt.Authed("GET /api/v1/project/{id}/export.zip", func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
		return handleFullZip(ctx, w, r, cfg, u)
	})
	rt.Authed("GET /api/v1/project/{id}/export.xlsx", func(ctx context.Context, w http.ResponseWriter, r *http.Request, u *auth.UserCtx) error {
		return handleSimpleXLSX(ctx, w, r, cfg, u)
	})
}

// handleSimpleCSV streams one CSV row per task. Headers are emitted
// up-front and the body follows; on a streaming failure mid-response
// the connection just closes with a truncated payload (logged) —
// there is no graceful way to undo a 200 once bytes are out.
func handleSimpleCSV(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config, user *auth.UserCtx) error {
	idStr := r.PathValue("id")
	projectID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || projectID <= 0 {
		return api.BadRequest("validation", "invalid project id")
	}
	includeDeleted := r.URL.Query().Get("include_deleted") == "1"
	tree, err := parseTreeParam(r.URL.Query().Get("tree"))
	if err != nil {
		return err
	}

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
		return api.Internal(fmt.Errorf("authz: %w", err))
	}
	if !auth {
		return httpError(http.StatusForbidden, "not authorized to export this project")
	}

	tasks, err := loadTaskRows(ctx, cfg.Pool, projectID, includeDeleted, tree)
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

	// Dynamic columns — any attribute_def bound to 'task' that isn't
	// already in the built-in column set gets its own column. Resolves
	// card_refs through a generic title lookup against the union of
	// extra-column references.
	attrCols, err := loadTaskAttrCols(ctx, cfg.Pool)
	if err != nil {
		return err
	}
	extraCols := extraExportCols(attrCols)
	extraTitles, err := loadTitleLookup(ctx, cfg.Pool, collectExtraRefIDs(tasks, extraCols))
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
	for _, c := range extraCols {
		header = append(header, c.Name)
	}
	if err := cw.Write(header); err != nil {
		return api.Internal(fmt.Errorf("write header: %w", err))
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
		for _, c := range extraCols {
			row = append(row, renderExtraCell(c, t.Attrs[c.Name], extraTitles))
		}
		if err := cw.Write(row); err != nil {
			return api.Internal(fmt.Errorf("write row: %w", err))
		}
	}
	cw.Flush()
	return cw.Error()
}

// taskRow holds the data we need for one CSV line. Pointer-ish ids
// (assignee / milestone_ref / component_ref) are 0 when the attribute
// is unset; tagIDs is nil when the tags list is empty.
//
// `Attrs` is the raw, unmodified attribute map straight off the LATERAL
// aggregate. The hardcoded columns above are populated from it for
// type-safety / clarity; dynamic ("extra") columns appended by the
// exporter use Attrs directly so a freshly-bound attribute_def gets a
// column with no code change.
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
	Attrs       map[string]json.RawMessage
}

// taskAttrCol carries one attribute_def bound (via the `edge` table)
// to the task card_type. Exporters enumerate these to drive their
// header / per-row value loops so adding a new attribute_def grows
// the export automatically.
type taskAttrCol struct {
	Name           string // attribute_def.name
	ValueType      string // 'text' | 'number' | 'bool' | 'date' | 'card_ref' | 'card_ref[]'
	TargetCardType string // card_type.name when ValueType is card_ref / card_ref[]; "" otherwise
	Ordering       int    // edge.ordering — drives column order in the export
}

// builtinExportAttrs lists the attribute names already covered by the
// hardcoded export columns. Any attribute_def NOT in this set gets a
// dynamic column appended at the tail of the export by the helpers
// below. Keep the membership in sync with the header literal at the
// top of handleSimpleCSV / handleSimpleXLSX.
var builtinExportAttrs = map[string]bool{
	"title":       true,
	"description": true,
	"sort_order":  true,
	"assignee":    true, // emitted as the assignee_email + assignee_name pair
	"milestone_ref": true,
	"component_ref": true,
	"tags":          true,
}

// loadTaskAttrCols returns every attribute_def bound (via the `edge`
// table) to the task card_type, ordered by edge.ordering so the
// emitted columns track the same visual order users see in the
// AttributeSidePanel.
func loadTaskAttrCols(ctx context.Context, pool *store.Pool) ([]taskAttrCol, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT ad.name, ad.value_type,
		       coalesce(target_ct.name, ''),
		       e.ordering
		FROM edge e
		JOIN card_type ct ON ct.id = e.card_type_id AND ct.name = 'task'
		JOIN attribute_def ad ON ad.id = e.attribute_def_id
		LEFT JOIN card_type target_ct ON target_ct.id = ad.target_card_type_id
		ORDER BY e.ordering, ad.name
	`)
	if err != nil {
		return nil, api.Internal(fmt.Errorf("load attr cols: %w", err))
	}
	defer rows.Close()
	var out []taskAttrCol
	for rows.Next() {
		var c taskAttrCol
		if err := rows.Scan(&c.Name, &c.ValueType, &c.TargetCardType, &c.Ordering); err != nil {
			return nil, api.Internal(fmt.Errorf("scan attr col: %w", err))
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// extraExportCols filters [cols] down to the subset NOT already
// covered by the hardcoded built-in columns. Returned slice preserves
// the input order (edge.ordering then name).
func extraExportCols(cols []taskAttrCol) []taskAttrCol {
	out := make([]taskAttrCol, 0, len(cols))
	for _, c := range cols {
		if builtinExportAttrs[c.Name] {
			continue
		}
		out = append(out, c)
	}
	return out
}

// collectExtraRefIDs walks the loaded tasks and collects every card
// id referenced by an extra (non-built-in) card_ref / card_ref[]
// attribute. Returned as a sorted slice so the SQL ANY($1) lookup is
// deterministic.
func collectExtraRefIDs(tasks []taskRow, extras []taskAttrCol) []int64 {
	set := map[int64]struct{}{}
	for _, t := range tasks {
		for _, c := range extras {
			switch c.ValueType {
			case "card_ref":
				if id := jsonAsCardID(t.Attrs[c.Name]); id != 0 {
					set[id] = struct{}{}
				}
			case "card_ref[]":
				for _, id := range jsonAsCardIDArray(t.Attrs[c.Name]) {
					if id != 0 {
						set[id] = struct{}{}
					}
				}
			}
		}
	}
	return keys(set)
}

// renderExtraCell renders one task's value for one extra column,
// resolving card_ref / card_ref[] to titles via [titleLookup]. Scalar
// attributes (text / number / date / bool) round-trip through
// jsonAsText, which strips the JSON quoting and stringifies the
// underlying value.
func renderExtraCell(c taskAttrCol, raw json.RawMessage, titleLookup map[int64]string) string {
	if len(raw) == 0 {
		return ""
	}
	switch c.ValueType {
	case "card_ref":
		id := jsonAsCardID(raw)
		if id == 0 {
			return ""
		}
		return titleLookup[id]
	case "card_ref[]":
		ids := jsonAsCardIDArray(raw)
		parts := make([]string, 0, len(ids))
		for _, id := range ids {
			if t := titleLookup[id]; t != "" {
				parts = append(parts, t)
			}
		}
		return strings.Join(parts, ", ")
	default:
		return jsonAsText(raw)
	}
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
		return "", api.Internal(fmt.Errorf("lookup project: %w", err))
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
//
// When `tree` is non-nil, it's compiled through card.CompileTree (the
// same predicate compiler the dispatcher uses) and ANDed into the
// WHERE clause — so the export matches whatever the user's screen
// filter is showing. A read-only transaction wraps the call because
// CompileTree consults the live schema snapshot and may dereference
// `snippet` leaves via a SELECT on predicate_snippet cards.
func loadTaskRows(ctx context.Context, pool *store.Pool, projectID int64, includeDeleted bool, tree *card.CardWhereGroup) ([]taskRow, error) {
	tx, err := pool.P.Begin(ctx)
	if err != nil {
		return nil, api.Internal(fmt.Errorf("begin tx: %w", err))
	}
	defer tx.Rollback(ctx)

	b := named.New()
	b.Set("project_id", projectID)
	b.Set("include_deleted", includeDeleted)

	extraClause := ""
	if tree != nil {
		snap, sErr := schema.Load(ctx, tx)
		if sErr != nil {
			return nil, api.Internal(fmt.Errorf("schema load: %w", sErr))
		}
		clause, cErr := card.CompileTree(ctx, tx, *tree, b.Bind, snap)
		if cErr != nil {
			return nil, httpError(http.StatusBadRequest, "bad filter: "+cErr.Error())
		}
		extraClause = " AND (" + clause + ")"
	}

	sql, args, err := b.Compile(`
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
		WHERE ct.name = 'task' AND c.parent_card_id = :project_id
		  AND (:include_deleted OR c.deleted_at IS NULL)` + extraClause + `
		ORDER BY c.id
	`)
	if err != nil {
		return nil, api.Internal(fmt.Errorf("load tasks: compile: %w", err))
	}
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, api.Internal(fmt.Errorf("load tasks: %w", err))
	}
	defer rows.Close()

	var out []taskRow
	for rows.Next() {
		var t taskRow
		var attrsRaw []byte
		if err := rows.Scan(&t.ID, &t.CreatedAt, &t.DeletedAt, &attrsRaw); err != nil {
			return nil, api.Internal(fmt.Errorf("scan task: %w", err))
		}
		attrs := map[string]json.RawMessage{}
		if len(attrsRaw) > 0 {
			if err := json.Unmarshal(attrsRaw, &attrs); err != nil {
				return nil, api.Internal(fmt.Errorf("decode attrs: %w", err))
			}
		}
		t.Title = jsonAsText(attrs["title"])
		t.Description = jsonAsText(attrs["description"])
		t.SortOrder = jsonAsNumberText(attrs["sort_order"])
		t.AssigneeID = jsonAsCardID(attrs["assignee"])
		t.MilestoneID = jsonAsCardID(attrs["milestone_ref"])
		t.ComponentID = jsonAsCardID(attrs["component_ref"])
		t.TagIDs = jsonAsCardIDArray(attrs["tags"])
		// Retain the raw attrs so the export can drive dynamic
		// (non-builtin) columns without an extra round-trip per task.
		t.Attrs = attrs
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
		return nil, api.Internal(fmt.Errorf("load persons: %w", err))
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var title, email *string
		if err := rows.Scan(&id, &title, &email); err != nil {
			return nil, api.Internal(fmt.Errorf("scan person: %w", err))
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
		return nil, api.Internal(fmt.Errorf("load titles: %w", err))
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var title *string
		if err := rows.Scan(&id, &title); err != nil {
			return nil, api.Internal(fmt.Errorf("scan title: %w", err))
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
		return nil, api.Internal(fmt.Errorf("load tag paths: %w", err))
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var path *string
		if err := rows.Scan(&id, &path); err != nil {
			return nil, api.Internal(fmt.Errorf("scan tag path: %w", err))
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
		return nil, api.Internal(fmt.Errorf("load comments: %w", err))
	}
	defer rows.Close()
	for rows.Next() {
		var cardID int64
		var body string
		if err := rows.Scan(&cardID, &body); err != nil {
			return nil, api.Internal(fmt.Errorf("scan comment: %w", err))
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

// parseTreeParam decodes the optional `tree` query parameter into a
// CardWhereGroup. Empty input → nil (no filter). Malformed input
// returns a 400 so the client knows to fix the request rather than
// silently exporting unfiltered rows.
func parseTreeParam(raw string) (*card.CardWhereGroup, error) {
	if raw == "" {
		return nil, nil
	}
	var g card.CardWhereGroup
	if err := json.Unmarshal([]byte(raw), &g); err != nil {
		return nil, httpError(http.StatusBadRequest, "invalid tree: "+err.Error())
	}
	if g.Connective == "" {
		// Bare-leaf shape ({attr, op, values}) — wrap in a single-leaf AND
		// so the compiler's entry point (compileTree on a group) accepts it.
		var leaf card.CardWhereTreeNode
		if err := json.Unmarshal([]byte(raw), &leaf); err != nil {
			return nil, httpError(http.StatusBadRequest, "invalid tree: "+err.Error())
		}
		g = card.CardWhereGroup{
			Connective: "and",
			Children:   []card.CardWhereTreeNode{leaf},
		}
	}
	return &g, nil
}

// httpError adapts the previous package-local helper to the apiRouter
// contract: returns an *api.HTTPError so the router's writeErr maps
// it to the wire response. Centralising here lets the rest of the
// package keep its call shape `return httpError(http.StatusFoo, "…")`
// while the router owns logging + JSON encoding.
func httpError(status int, msg string) error {
	return &api.HTTPError{
		Status:  status,
		Code:    codeForStatus(status),
		Message: msg,
	}
}

func codeForStatus(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "validation"
	case http.StatusUnauthorized:
		return "unauthenticated"
	case http.StatusForbidden:
		return "forbidden"
	case http.StatusNotFound:
		return "not_found"
	case http.StatusConflict:
		return "conflict"
	case http.StatusRequestEntityTooLarge:
		return "request_too_large"
	default:
		return "internal"
	}
}
