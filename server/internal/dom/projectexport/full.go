// File projectexport/full.go: the streamed-ZIP exporter
// (`GET /api/v1/project/{id}/export.zip`). Builds a self-contained
// archive — project / tasks / comments / milestones / components /
// tags / persons CSVs, plus optional activity.csv and an
// attachments/ folder fed straight from CAS.
//
// Streaming notes:
//   - archive/zip writes the central directory at Close(); everything
//     up to that point is appended sequentially, so wrapping
//     http.ResponseWriter works without buffering.
//   - Once headers are flushed (status 200 + Content-Type), any
//     mid-stream failure leaves a truncated body. We log via cfg.Logger
//     and return nil so writeErr doesn't try to write a second status.
package projectexport

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"slices"
	"strconv"
	"time"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/store"
)

// fullExportOptions bundles the three toggles the endpoint exposes.
type fullExportOptions struct {
	IncludeDeleted     bool
	IncludeAttachments bool
	IncludeActivity    bool
}

// handleFullZip orchestrates the streamed ZIP build. Same authz
// contract as handleSimpleCSV — card.update on the project, plus a
// valid login.
func handleFullZip(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config) error {
	user, ok := auth.FromContext(ctx)
	if !ok || user == nil || user.ID == 0 {
		return httpError(http.StatusUnauthorized, "login required")
	}

	idStr := r.PathValue("id")
	projectID, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil || projectID <= 0 {
		return httpError(http.StatusBadRequest, "invalid project id")
	}
	opts := fullExportOptions{
		IncludeDeleted:     r.URL.Query().Get("include_deleted") == "1",
		IncludeAttachments: r.URL.Query().Get("include_attachments") == "1",
		IncludeActivity:    r.URL.Query().Get("include_activity") == "1",
	}
	if opts.IncludeAttachments && cfg.Storage == nil {
		return httpError(http.StatusInternalServerError,
			"export: include_attachments=1 requires a configured CAS storage")
	}

	projectTitle, err := loadProjectTitle(ctx, cfg.Pool, projectID)
	if err != nil {
		return err
	}
	authOK, err := isAuthorized(ctx, cfg.Pool, user.ID, projectID)
	if err != nil {
		return httpError(http.StatusInternalServerError, "authz: "+err.Error())
	}
	if !authOK {
		return httpError(http.StatusForbidden, "not authorized to export this project")
	}

	// Resolve every dataset up-front so a query failure surfaces as a
	// clean 5xx before any ZIP bytes are written. After we set the
	// 200 + Content-Type we can no longer signal an error to the
	// client cleanly — the stream just truncates.
	bundle, err := loadFullBundle(ctx, cfg.Pool, projectID, opts)
	if err != nil {
		return err
	}

	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`,
			fmt.Sprintf("project-%s-%d.zip", slugify(projectTitle), projectID)))

	zw := zip.NewWriter(w)
	defer zw.Close()

	if err := writeProjectCSV(zw, projectID, projectTitle, bundle); err != nil {
		logStream(cfg.Logger, "project.csv", err)
		return nil
	}
	if err := writeTasksCSV(zw, bundle); err != nil {
		logStream(cfg.Logger, "tasks.csv", err)
		return nil
	}
	if err := writeCommentsCSV(zw, bundle); err != nil {
		logStream(cfg.Logger, "comments.csv", err)
		return nil
	}
	if err := writeValueCardCSV(zw, "milestones.csv", []string{"id", "title", "is_active"},
		bundle.milestones, milestoneRow); err != nil {
		logStream(cfg.Logger, "milestones.csv", err)
		return nil
	}
	if err := writeValueCardCSV(zw, "components.csv", []string{"id", "title", "is_active"},
		bundle.components, componentRow); err != nil {
		logStream(cfg.Logger, "components.csv", err)
		return nil
	}
	if err := writeValueCardCSV(zw, "tags.csv",
		[]string{"id", "title", "path", "root_exclusive_at", "is_active"},
		bundle.tags, tagRow); err != nil {
		logStream(cfg.Logger, "tags.csv", err)
		return nil
	}
	if err := writePersonsCSV(zw, bundle); err != nil {
		logStream(cfg.Logger, "persons.csv", err)
		return nil
	}
	if opts.IncludeActivity {
		if err := writeActivityCSV(zw, bundle); err != nil {
			logStream(cfg.Logger, "activity.csv", err)
			return nil
		}
	}
	// Attachments: emit the CSV first (cheap, deterministic) then
	// stream bytes for every attachment if the toggle is on. Computing
	// each file's sha256 as we stream lets us populate the CSV column
	// only when the bytes are actually exported.
	digests := map[int64]string{}
	if opts.IncludeAttachments {
		var err error
		digests, err = streamAttachments(ctx, cfg, zw, bundle)
		if err != nil {
			logStream(cfg.Logger, "attachments", err)
			return nil
		}
	}
	if err := writeAttachmentsCSV(zw, bundle, digests); err != nil {
		logStream(cfg.Logger, "attachments.csv", err)
		return nil
	}
	return nil
}

// fullBundle is every dataset the ZIP emits. Loaded up-front so a
// query error happens before any zip bytes are flushed.
type fullBundle struct {
	project     map[string]json.RawMessage
	createdAt   *time.Time
	deletedAt   *time.Time
	tasks       []taskRow
	comments    []commentRow
	milestones  []valueCardRow
	components  []valueCardRow
	tags        []valueCardRow
	persons     []personRow
	personLink  map[int64]bool // person_card_id -> has_login
	activity    []activityRow  // only populated when IncludeActivity
	attachments []attachmentRow
	// Per-person email + title — convenience for fields that need them.
	personEmail map[int64]string
	personTitle map[int64]string
	titles      map[int64]string // milestones + components combined
	tagPaths    map[int64]string
	userEmails  map[int64]string // user_account.id -> email
}

type valueCardRow struct {
	ID         int64
	Attributes map[string]json.RawMessage
}

type personRow struct {
	ID         int64
	Attributes map[string]json.RawMessage
}

type commentRow struct {
	TaskID      int64
	AuthorEmail string
	Body        string
	CreatedAt   time.Time
}

type activityRow struct {
	ID             int64
	CardID         int64
	Kind           string
	AttributeName  string
	ValueOld       json.RawMessage
	ValueNew       json.RawMessage
	ActorEmail     string
	CreatedAt      time.Time
}

type attachmentRow struct {
	ID             int64
	TaskID         int64
	Filename       string
	SizeBytes      int64
	MimeType       string
	CreatedAt      time.Time
	CreatedByEmail string
	ThumbFileID    int64
	ChunkAddresses []string
}

// loadFullBundle issues one read per resource. Most of the joins are
// straight `c.parent_card_id = $project_id` filters; the global tables
// (persons, user_accounts) are loaded as wide lookup maps and trimmed
// to referenced ids inside their emitters.
func loadFullBundle(ctx context.Context, pool *store.Pool, projectID int64, opts fullExportOptions) (*fullBundle, error) {
	b := &fullBundle{
		personEmail: map[int64]string{},
		personTitle: map[int64]string{},
		titles:      map[int64]string{},
		tagPaths:    map[int64]string{},
		userEmails:  map[int64]string{},
		personLink:  map[int64]bool{},
	}

	// 1. The project's own row + attributes.
	proj, projCreated, projDeleted, err := loadProjectFull(ctx, pool, projectID)
	if err != nil {
		return nil, err
	}
	b.project = proj
	b.createdAt = projCreated
	b.deletedAt = projDeleted

	// 2. Tasks (with attrs flattened — reuse the simple-export helper).
	tasks, err := loadTaskRows(ctx, pool, projectID, opts.IncludeDeleted)
	if err != nil {
		return nil, err
	}
	b.tasks = tasks

	// 3. Comments — load both the comment body and the actor's email
	//    in one query so we don't re-walk activity per row.
	cmts, err := loadCommentRows(ctx, pool, taskIDsOf(tasks))
	if err != nil {
		return nil, err
	}
	b.comments = cmts

	// 4. Per-type value cards under the project.
	b.milestones, err = loadValueCards(ctx, pool, "milestone", projectID)
	if err != nil {
		return nil, err
	}
	b.components, err = loadValueCards(ctx, pool, "component", projectID)
	if err != nil {
		return nil, err
	}
	b.tags, err = loadValueCards(ctx, pool, "tag", projectID)
	if err != nil {
		return nil, err
	}

	// 5. Persons referenced as assignees in this project. Global
	//    cards, so we filter by referenced ids only.
	personIDs := []int64{}
	for _, t := range tasks {
		if t.AssigneeID != 0 {
			personIDs = append(personIDs, t.AssigneeID)
		}
	}
	personIDs = dedupSorted(personIDs)
	b.persons, b.personLink, err = loadPersons(ctx, pool, personIDs)
	if err != nil {
		return nil, err
	}
	for _, p := range b.persons {
		b.personTitle[p.ID] = jsonAsText(p.Attributes["title"])
		b.personEmail[p.ID] = jsonAsText(p.Attributes["email"])
	}

	// 6. Title lookup for milestones + components (used by tasks.csv).
	for _, m := range b.milestones {
		b.titles[m.ID] = jsonAsText(m.Attributes["title"])
	}
	for _, c := range b.components {
		b.titles[c.ID] = jsonAsText(c.Attributes["title"])
	}
	// Tag paths for tasks.csv "tags" column.
	for _, tg := range b.tags {
		b.tagPaths[tg.ID] = jsonAsText(tg.Attributes["path"])
	}

	// 7. Activity (optional, can dwarf the rest on a busy project).
	if opts.IncludeActivity {
		// Activity needs every actor's email. We pull it from
		// user_account directly (the rows live forever, even if a
		// person card has been re-linked).
		acts, emails, err := loadActivityRows(ctx, pool, projectID, opts.IncludeDeleted)
		if err != nil {
			return nil, err
		}
		b.activity = acts
		maps.Copy(b.userEmails, emails)
	}

	// 8. Attachments — always list metadata; bytes only flow when the
	//    include_attachments toggle is on, handled by the caller.
	atts, attEmails, err := loadAttachmentRows(ctx, pool, taskIDsOf(tasks))
	if err != nil {
		return nil, err
	}
	b.attachments = atts
	maps.Copy(b.userEmails, attEmails)
	return b, nil
}

// loadProjectFull fetches the project's own attribute map + timestamps.
// Returns an error wrapped as httpError so callers can propagate the
// status code directly.
func loadProjectFull(ctx context.Context, pool *store.Pool, projectID int64) (map[string]json.RawMessage, *time.Time, *time.Time, error) {
	var (
		createdAt time.Time
		deletedAt *time.Time
		attrsRaw  []byte
	)
	err := pool.P.QueryRow(ctx, `
		SELECT c.created_at, c.deleted_at,
		       coalesce(attrs.values, '{}'::jsonb)
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
		LEFT JOIN LATERAL (
			SELECT jsonb_object_agg(ad.name, av.value) AS values
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
		) attrs ON TRUE
		WHERE c.id = $1
	`, projectID).Scan(&createdAt, &deletedAt, &attrsRaw)
	if err != nil {
		return nil, nil, nil, httpError(http.StatusInternalServerError, "load project: "+err.Error())
	}
	out := map[string]json.RawMessage{}
	if len(attrsRaw) > 0 {
		if err := json.Unmarshal(attrsRaw, &out); err != nil {
			return nil, nil, nil, httpError(http.StatusInternalServerError, "decode project attrs: "+err.Error())
		}
	}
	return out, &createdAt, deletedAt, nil
}

// loadValueCards pulls every (non-deleted) card of a given type under
// projectID with its attribute map. Used for milestones / components /
// tags — they all share the same shape (parent_card_id = project).
func loadValueCards(ctx context.Context, pool *store.Pool, typeName string, projectID int64) ([]valueCardRow, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT c.id, coalesce(attrs.values, '{}'::jsonb)
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = $1
		LEFT JOIN LATERAL (
			SELECT jsonb_object_agg(ad.name, av.value) AS values
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
		) attrs ON TRUE
		WHERE c.parent_card_id = $2 AND c.deleted_at IS NULL
		ORDER BY c.id
	`, typeName, projectID)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load "+typeName+": "+err.Error())
	}
	defer rows.Close()
	var out []valueCardRow
	for rows.Next() {
		var v valueCardRow
		var raw []byte
		if err := rows.Scan(&v.ID, &raw); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan "+typeName+": "+err.Error())
		}
		v.Attributes = map[string]json.RawMessage{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &v.Attributes); err != nil {
				return nil, httpError(http.StatusInternalServerError, "decode "+typeName+": "+err.Error())
			}
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// loadPersons fetches person cards + their link to a user_account
// (has_login flag).
func loadPersons(ctx context.Context, pool *store.Pool, ids []int64) ([]personRow, map[int64]bool, error) {
	hasLogin := map[int64]bool{}
	if len(ids) == 0 {
		return nil, hasLogin, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT c.id,
		       coalesce(attrs.values, '{}'::jsonb),
		       EXISTS (SELECT 1 FROM user_account_person uap WHERE uap.person_card_id = c.id) AS has_login
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'person'
		LEFT JOIN LATERAL (
			SELECT jsonb_object_agg(ad.name, av.value) AS values
			FROM attribute_value av
			JOIN attribute_def ad ON ad.id = av.attribute_def_id
			WHERE av.card_id = c.id
		) attrs ON TRUE
		WHERE c.id = ANY($1::bigint[])
		ORDER BY c.id
	`, ids)
	if err != nil {
		return nil, nil, httpError(http.StatusInternalServerError, "load persons: "+err.Error())
	}
	defer rows.Close()
	var out []personRow
	for rows.Next() {
		var p personRow
		var raw []byte
		var hl bool
		if err := rows.Scan(&p.ID, &raw, &hl); err != nil {
			return nil, nil, httpError(http.StatusInternalServerError, "scan person: "+err.Error())
		}
		p.Attributes = map[string]json.RawMessage{}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &p.Attributes); err != nil {
				return nil, nil, httpError(http.StatusInternalServerError, "decode person: "+err.Error())
			}
		}
		out = append(out, p)
		hasLogin[p.ID] = hl
	}
	return out, hasLogin, rows.Err()
}

// loadCommentRows: every comment activity on the given task ids,
// with the actor's email pre-resolved.
func loadCommentRows(ctx context.Context, pool *store.Pool, taskIDs []int64) ([]commentRow, error) {
	if len(taskIDs) == 0 {
		return nil, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT a.card_id, cb.body, a.created_at,
		       COALESCE(u.email, '') AS author_email
		FROM activity a
		JOIN comment_body cb ON cb.id = (a.value_new ->> 'comment_body_id')::bigint
		LEFT JOIN user_account u ON u.id = a.actor_id
		WHERE a.kind = 'comment' AND a.card_id = ANY($1::bigint[])
		ORDER BY a.card_id, a.created_at, a.id
	`, taskIDs)
	if err != nil {
		return nil, httpError(http.StatusInternalServerError, "load comments: "+err.Error())
	}
	defer rows.Close()
	var out []commentRow
	for rows.Next() {
		var c commentRow
		if err := rows.Scan(&c.TaskID, &c.Body, &c.CreatedAt, &c.AuthorEmail); err != nil {
			return nil, httpError(http.StatusInternalServerError, "scan comment: "+err.Error())
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// loadActivityRows pulls the full event stream for every card under
// projectID. We include comment + attr_update + card_create + tag_apply
// rows — every kind currently emitted by the runtime.
func loadActivityRows(ctx context.Context, pool *store.Pool, projectID int64, includeDeleted bool) ([]activityRow, map[int64]string, error) {
	rows, err := pool.P.Query(ctx, `
		SELECT a.id, a.card_id, a.kind,
		       COALESCE(ad.name, '') AS attribute_name,
		       a.value_old, a.value_new,
		       COALESCE(u.email, '') AS actor_email, a.actor_id,
		       a.created_at
		FROM activity a
		JOIN card c ON c.id = a.card_id
		LEFT JOIN attribute_def ad ON ad.id = a.attribute_def_id
		LEFT JOIN user_account u  ON u.id = a.actor_id
		WHERE (c.id = $1 OR c.parent_card_id = $1)
		  AND ($2 OR c.deleted_at IS NULL)
		ORDER BY a.id
	`, projectID, includeDeleted)
	if err != nil {
		return nil, nil, httpError(http.StatusInternalServerError, "load activity: "+err.Error())
	}
	defer rows.Close()
	var out []activityRow
	emails := map[int64]string{}
	for rows.Next() {
		var a activityRow
		var actorID int64
		var oldRaw, newRaw []byte
		if err := rows.Scan(&a.ID, &a.CardID, &a.Kind, &a.AttributeName,
			&oldRaw, &newRaw, &a.ActorEmail, &actorID, &a.CreatedAt); err != nil {
			return nil, nil, httpError(http.StatusInternalServerError, "scan activity: "+err.Error())
		}
		a.ValueOld = oldRaw
		a.ValueNew = newRaw
		out = append(out, a)
		emails[actorID] = a.ActorEmail
	}
	return out, emails, rows.Err()
}

// loadAttachmentRows pulls one row per attachment that hangs off any
// of the given task ids, plus the ordered CAS chunk list so the byte
// stream can walk addresses without a second query per attachment.
func loadAttachmentRows(ctx context.Context, pool *store.Pool, taskIDs []int64) ([]attachmentRow, map[int64]string, error) {
	emails := map[int64]string{}
	if len(taskIDs) == 0 {
		return nil, emails, nil
	}
	rows, err := pool.P.Query(ctx, `
		SELECT
			a.id, a.card_id, a.created_at, a.thumb_file_id,
			f.filename, f.size_bytes, f.mime_type,
			COALESCE(u.email, '') AS created_by_email,
			u.id AS created_by_id,
			COALESCE(addrs.list, ARRAY[]::text[]) AS chunks
		FROM attachment a
		JOIN file f ON f.id = a.file_id
		LEFT JOIN user_account u ON u.id = f.created_by
		LEFT JOIN LATERAL (
			SELECT array_agg(fc.cas_address ORDER BY fc.seq) AS list
			FROM file_chunk fc
			WHERE fc.file_id = f.id
		) addrs ON TRUE
		WHERE a.deleted_at IS NULL AND a.card_id = ANY($1::bigint[])
		ORDER BY a.id
	`, taskIDs)
	if err != nil {
		return nil, nil, httpError(http.StatusInternalServerError, "load attachments: "+err.Error())
	}
	defer rows.Close()
	var out []attachmentRow
	for rows.Next() {
		var r attachmentRow
		var createdByID *int64
		var thumb *int64
		if err := rows.Scan(&r.ID, &r.TaskID, &r.CreatedAt, &thumb,
			&r.Filename, &r.SizeBytes, &r.MimeType, &r.CreatedByEmail,
			&createdByID, &r.ChunkAddresses); err != nil {
			return nil, nil, httpError(http.StatusInternalServerError, "scan attachment: "+err.Error())
		}
		if thumb != nil {
			r.ThumbFileID = *thumb
		}
		out = append(out, r)
		if createdByID != nil {
			emails[*createdByID] = r.CreatedByEmail
		}
	}
	return out, emails, rows.Err()
}

/* -------------------------------------------------------------------------- */
/* CSV emitters                                                                */
/* -------------------------------------------------------------------------- */

// withCSV creates a zip entry and hands the caller a buffered csv.Writer.
// Flushes (and reports errors) on every entry close.
func withCSV(zw *zip.Writer, name string, fn func(*csv.Writer) error) error {
	w, err := zw.Create(name)
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	cw := csv.NewWriter(w)
	if err := fn(cw); err != nil {
		return err
	}
	cw.Flush()
	return cw.Error()
}

func writeProjectCSV(zw *zip.Writer, id int64, title string, b *fullBundle) error {
	_ = title // explicit param keeps the call site symmetric with handleSimpleCSV.
	return withCSV(zw, "project.csv", func(cw *csv.Writer) error {
		if err := cw.Write([]string{"id", "title", "description", "created_at", "deleted_at"}); err != nil {
			return err
		}
		return cw.Write([]string{
			strconv.FormatInt(id, 10),
			jsonAsText(b.project["title"]),
			jsonAsText(b.project["description"]),
			isoOrEmpty(b.createdAt),
			isoOrEmpty(b.deletedAt),
		})
	})
}

// tasksHeader is reused so the simple-csv test can cross-check column
// order if it ever needs to.
var tasksHeader = []string{
	"id", "title", "assignee_email", "assignee_name",
	"milestone", "component", "tags", "description", "sort_order",
	"created_at", "deleted_at",
}

func writeTasksCSV(zw *zip.Writer, b *fullBundle) error {
	return withCSV(zw, "tasks.csv", func(cw *csv.Writer) error {
		if err := cw.Write(tasksHeader); err != nil {
			return err
		}
		for _, t := range b.tasks {
			row := []string{
				strconv.FormatInt(t.ID, 10),
				t.Title,
				b.personEmail[t.AssigneeID],
				b.personTitle[t.AssigneeID],
				b.titles[t.MilestoneID],
				b.titles[t.ComponentID],
				joinTagPaths(t.TagIDs, b.tagPaths),
				t.Description,
				t.SortOrder,
				isoOrEmpty(t.CreatedAt),
				isoOrEmpty(t.DeletedAt),
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		return nil
	})
}

func writeCommentsCSV(zw *zip.Writer, b *fullBundle) error {
	return withCSV(zw, "comments.csv", func(cw *csv.Writer) error {
		if err := cw.Write([]string{"task_id", "author_email", "body", "created_at"}); err != nil {
			return err
		}
		for _, c := range b.comments {
			row := []string{
				strconv.FormatInt(c.TaskID, 10),
				c.AuthorEmail,
				c.Body,
				c.CreatedAt.UTC().Format(time.RFC3339),
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		return nil
	})
}

// writeValueCardCSV is the shape shared by milestones / components /
// tags — every row is `(id, …attributes resolved through a callback)`.
func writeValueCardCSV(zw *zip.Writer, name string, header []string,
	rows []valueCardRow, project func(v valueCardRow) []string) error {
	return withCSV(zw, name, func(cw *csv.Writer) error {
		if err := cw.Write(header); err != nil {
			return err
		}
		for _, r := range rows {
			if err := cw.Write(project(r)); err != nil {
				return err
			}
		}
		return nil
	})
}

func milestoneRow(v valueCardRow) []string {
	return []string{
		strconv.FormatInt(v.ID, 10),
		jsonAsText(v.Attributes["title"]),
		boolOrEmpty(v.Attributes["is_active"]),
	}
}

func componentRow(v valueCardRow) []string {
	return []string{
		strconv.FormatInt(v.ID, 10),
		jsonAsText(v.Attributes["title"]),
		boolOrEmpty(v.Attributes["is_active"]),
	}
}

func tagRow(v valueCardRow) []string {
	return []string{
		strconv.FormatInt(v.ID, 10),
		jsonAsText(v.Attributes["title"]),
		jsonAsText(v.Attributes["path"]),
		jsonAsText(v.Attributes["root_exclusive_at"]),
		boolOrEmpty(v.Attributes["is_active"]),
	}
}

func writePersonsCSV(zw *zip.Writer, b *fullBundle) error {
	return withCSV(zw, "persons.csv", func(cw *csv.Writer) error {
		if err := cw.Write([]string{"id", "title", "email", "has_login"}); err != nil {
			return err
		}
		for _, p := range b.persons {
			row := []string{
				strconv.FormatInt(p.ID, 10),
				jsonAsText(p.Attributes["title"]),
				jsonAsText(p.Attributes["email"]),
				strconv.FormatBool(b.personLink[p.ID]),
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		return nil
	})
}

func writeActivityCSV(zw *zip.Writer, b *fullBundle) error {
	return withCSV(zw, "activity.csv", func(cw *csv.Writer) error {
		if err := cw.Write([]string{
			"id", "card_id", "kind", "attribute_name",
			"value_old", "value_new", "actor_email", "created_at",
		}); err != nil {
			return err
		}
		for _, a := range b.activity {
			row := []string{
				strconv.FormatInt(a.ID, 10),
				strconv.FormatInt(a.CardID, 10),
				a.Kind,
				a.AttributeName,
				rawOrEmpty(a.ValueOld),
				rawOrEmpty(a.ValueNew),
				a.ActorEmail,
				a.CreatedAt.UTC().Format(time.RFC3339),
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		return nil
	})
}

func writeAttachmentsCSV(zw *zip.Writer, b *fullBundle, digests map[int64]string) error {
	return withCSV(zw, "attachments.csv", func(cw *csv.Writer) error {
		if err := cw.Write([]string{
			"attachment_id", "task_id", "filename", "sha256",
			"size_bytes", "mime_type", "created_at", "created_by_email",
			"thumb_path",
		}); err != nil {
			return err
		}
		for _, a := range b.attachments {
			thumb := ""
			if a.ThumbFileID != 0 {
				thumb = fmt.Sprintf("attachments/%d-thumb-%s", a.ID, a.Filename)
			}
			row := []string{
				strconv.FormatInt(a.ID, 10),
				strconv.FormatInt(a.TaskID, 10),
				a.Filename,
				digests[a.ID],
				strconv.FormatInt(a.SizeBytes, 10),
				a.MimeType,
				a.CreatedAt.UTC().Format(time.RFC3339),
				a.CreatedByEmail,
				thumb,
			}
			if err := cw.Write(row); err != nil {
				return err
			}
		}
		return nil
	})
}

// streamAttachments copies every attachment's bytes into the zip and
// returns id -> hex-sha256 of the combined chunk bytes. Chunks are
// pulled from CAS in order; we tee through sha256.New() so we don't
// re-read the bytes after writing.
func streamAttachments(ctx context.Context, cfg Config, zw *zip.Writer, b *fullBundle) (map[int64]string, error) {
	out := map[int64]string{}
	for _, a := range b.attachments {
		path := fmt.Sprintf("attachments/%d-%s", a.ID, a.Filename)
		w, err := zw.Create(path)
		if err != nil {
			return nil, fmt.Errorf("zip create %s: %w", path, err)
		}
		h := sha256.New()
		for _, addr := range a.ChunkAddresses {
			rc, err := cfg.Storage.Get(ctx, addr)
			if err != nil {
				return nil, fmt.Errorf("cas %s: %w", addr, err)
			}
			if _, err := io.Copy(io.MultiWriter(w, h), rc); err != nil {
				rc.Close()
				return nil, fmt.Errorf("copy %s: %w", path, err)
			}
			rc.Close()
		}
		out[a.ID] = hex.EncodeToString(h.Sum(nil))
	}
	return out, nil
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

func logStream(logger *slog.Logger, name string, err error) {
	l := logger
	if l == nil {
		l = slog.Default()
	}
	l.LogAttrs(context.Background(), slog.LevelError, "project export stream",
		slog.String("entry", name), slog.String("err", err.Error()))
}

func dedupSorted(in []int64) []int64 {
	if len(in) == 0 {
		return nil
	}
	cp := slices.Clone(in)
	slices.Sort(cp)
	return slices.Compact(cp)
}

// boolOrEmpty renders a boolean JSON value as "true"/"false"; null and
// non-bool values render empty.
func boolOrEmpty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	b, ok := v.(bool)
	if !ok {
		return ""
	}
	return strconv.FormatBool(b)
}

// rawOrEmpty returns the raw JSON string, or "" when nil/empty.
func rawOrEmpty(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	return string(raw)
}
