// File projectimport/commit.go: irrevocable import pass.
//
// The handler runs inside the dispatcher's transaction, so a returned
// error rolls back every INSERT issued from here — matches the plan's
// "every commit is one transaction" requirement.
//
// Pipeline:
//
//  1. Load job + mapping + resolution (all already persisted by the
//     earlier steps).
//  2. Decode CSV bytes; build per-row decisions using the same logic
//     the preview pass uses. Fail the whole commit on any row error.
//  3. Auto-create persons / milestones / components / tags as the
//     resolution config dictates. Each kind goes through card.insert
//     so the runtime emits the same card_create + attr_update
//     activities a hand-written card would.
//  4. Insert every task via card.insert with the resolved attribute
//     map. card.insert handles its own scope validation, so any
//     stray cross-project ref will surface here.
//  5. Mark the job 'completed' + record the summary.
//
// Idempotency: the dispatcher's existing Idempotency-Key middleware
// caches the response keyed by (user, key). A replay with the same
// key returns the cached output without re-running step 4; a replay
// against an already-'completed' job hard-errors with
// 'already_committed'.
package projectimport

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/dom/card"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func runCommit(p *store.Pool) func(context.Context, pgx.Tx, []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(CommitInput)
			if in.JobID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.import.commit: job_id is required"}
			}
			out, err := commitOne(ctx, tx, in.JobID)
			if err != nil {
				return nil, err
			}
			outs[i] = out
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

func commitOne(ctx context.Context, tx pgx.Tx, jobID int64) (CommitOutput, error) {
	// 1. Load job, mapping, resolution.
	job, err := loadJobFull(ctx, tx, jobID)
	if err != nil {
		return CommitOutput{}, err
	}
	switch job.Status {
	case "completed":
		return CommitOutput{}, &reg.HandlerError{Code: "already_committed",
			Message: fmt.Sprintf("import_job %d is already completed; re-upload to re-run", jobID)}
	case "running":
		return CommitOutput{}, &reg.HandlerError{Code: "already_committed",
			Message: fmt.Sprintf("import_job %d is already running (replay via Idempotency-Key if you intended a retry)", jobID)}
	}
	if job.Mapping == nil {
		return CommitOutput{}, &reg.HandlerError{Code: "no_mapping",
			Message: "project.import.commit: job has no mapping; call set_mapping first"}
	}

	// 2. Read CSV + lookups.
	body, err := readFileBytes(ctx, tx, job.FileID)
	if err != nil {
		return CommitOutput{}, &reg.HandlerError{Code: "csv_read", Message: err.Error()}
	}
	header, rows, err := readAllCSV(body)
	if err != nil {
		return CommitOutput{}, &reg.HandlerError{Code: "csv_parse", Message: err.Error()}
	}
	lk, err := loadLookups(ctx, tx, job.ProjectID)
	if err != nil {
		return CommitOutput{}, err
	}

	// 3. Two-pass: collect what needs creating; abort on any row error.
	plan, planErrs := planCommit(header, rows, job.Mapping, job.Resolution, lk)
	if len(planErrs) > 0 {
		return CommitOutput{}, &reg.HandlerError{Code: "import_validation",
			Message: fmt.Sprintf("import has %d row error(s); commit aborted (first: %s)",
				len(planErrs), planErrs[0].Message)}
	}

	// 4. Auto-create cards (persons → milestones → components → tags).
	if err := createAutoCards(ctx, tx, job.ProjectID, plan, lk); err != nil {
		return CommitOutput{}, err
	}

	// 5. Insert tasks. card.insert emits one card_create + N
	//    attr_update activities per task — that's the audit trail.
	created, err := insertTasks(ctx, tx, job.ProjectID, plan, lk)
	if err != nil {
		return CommitOutput{}, err
	}

	out := CommitOutput{
		Created: WouldCreate{
			Tasks:      created,
			Persons:    len(plan.newPersons),
			Milestones: len(plan.newMilestones),
			Components: len(plan.newComponents),
			Tags:       len(plan.newTags),
		},
		Errors:        []PreviewError{},
		Status:        "completed",
		SkippedRows:   plan.skippedRows,
		ProcessedRows: plan.processedRows,
	}

	// 6. Mark the job completed.
	if err := persistSuccess(ctx, tx, jobID, out); err != nil {
		return CommitOutput{}, err
	}
	return out, nil
}

/* -------------------------------------------------------------------------- */
/* Job loader                                                                 */
/* -------------------------------------------------------------------------- */

type fullJob struct {
	ID         int64
	ProjectID  int64
	FileID     int64
	Status     string
	Mapping    map[string]string
	Resolution ResolutionConfig
}

func loadJobFull(ctx context.Context, tx pgx.Tx, jobID int64) (*fullJob, error) {
	var (
		j      fullJob
		mapb   []byte
		resb   []byte
	)
	err := tx.QueryRow(ctx, `
		SELECT id, project_id, file_id, status,
		       COALESCE(mapping,    'null'::jsonb),
		       COALESCE(resolution, 'null'::jsonb)
		FROM import_job WHERE id = $1
	`, jobID).Scan(&j.ID, &j.ProjectID, &j.FileID, &j.Status, &mapb, &resb)
	if err != nil {
		return nil, &reg.HandlerError{Code: "job_not_found",
			Message: fmt.Sprintf("import_job %d not found: %v", jobID, err)}
	}
	if len(mapb) > 0 && string(mapb) != "null" {
		j.Mapping = map[string]string{}
		if err := json.Unmarshal(mapb, &j.Mapping); err != nil {
			return nil, fmt.Errorf("decode mapping: %w", err)
		}
	}
	if len(resb) > 0 && string(resb) != "null" {
		if err := json.Unmarshal(resb, &j.Resolution); err != nil {
			return nil, fmt.Errorf("decode resolution: %w", err)
		}
	}
	return &j, nil
}

/* -------------------------------------------------------------------------- */
/* Plan                                                                       */
/* -------------------------------------------------------------------------- */

// taskPlan is one row's worth of decisions: either skip, or insert
// a task with the captured attribute slots. Ref-typed attributes
// (milestoneTitle / componentTitle / tagPaths / assigneeEmail) carry
// the normalised value so the second pass can look them up in `lk`
// after auto-create has run.
type taskPlan struct {
	Skip            bool
	Title           string
	Description     string
	SortOrder       string
	AssigneeEmail   string // normalised; "" when blank
	AssigneeName    string // raw — used when auto-creating a person
	MilestoneTitle  string // normalised; "" when blank or leave_blank
	ComponentTitle  string // normalised; "" when blank or leave_blank
	TagPaths        []string // normalised; nil when blank or leave_blank
}

type commitPlan struct {
	tasks          []taskPlan
	skippedRows    int
	processedRows  int
	// Auto-create sets — dedup by normalised key.
	newPersons     map[string]string // email -> display name (for the auto-created person)
	newMilestones  map[string]string // normalised -> display title (preserve case for the new card)
	newComponents  map[string]string
	newTags        map[string]string
}

// planCommit replays the same row-walking logic as the preview pass
// but builds the per-row task plan plus the auto-create sets. Returns
// a non-nil error log when any row has a fatal problem; the caller
// turns that into a tx-abort failure.
func planCommit(header []string, rows [][]string, mapping map[string]string, res ResolutionConfig, lk *lookups) (commitPlan, []PreviewError) {
	plan := commitPlan{
		newPersons:    map[string]string{},
		newMilestones: map[string]string{},
		newComponents: map[string]string{},
		newTags:       map[string]string{},
	}
	colIdxByAttr := map[string]int{}
	for i, h := range header {
		target := mapping[h]
		if target == "" || target == IgnoreColumnSentinel {
			continue
		}
		if _, supported := supportedTargetAttrs[target]; supported {
			colIdxByAttr[target] = i
		}
	}

	var rowErrors []PreviewError
	for ri, row := range rows {
		rowNum := ri + 2 // CSV row 1 is the header.
		var tp taskPlan
		errs := []PreviewError{}

		// title (required)
		if idx, ok := colIdxByAttr["title"]; ok {
			tp.Title = strings.TrimSpace(cell(row, idx))
		}
		if tp.Title == "" {
			errs = append(errs, PreviewError{Row: rowNum, Column: "title",
				Message: "title is required"})
		}

		// milestone (lookup by title)
		if idx, ok := colIdxByAttr["milestone"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				norm := normalize(v)
				if _, known := lk.milestonesByTitle[norm]; known {
					tp.MilestoneTitle = norm
				} else {
					sk, perr := decideRefMode("milestone", v, res.Milestones, rowNum)
					if sk {
						tp.Skip = true
					}
					if perr != nil {
						errs = append(errs, *perr)
					}
					if res.Milestones == ModeAutoCreate {
						plan.newMilestones[norm] = v
						tp.MilestoneTitle = norm
					}
				}
			}
		}

		// component (lookup by title)
		if idx, ok := colIdxByAttr["component"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				norm := normalize(v)
				if _, known := lk.componentsByTitle[norm]; known {
					tp.ComponentTitle = norm
				} else {
					sk, perr := decideRefMode("component", v, res.Components, rowNum)
					if sk {
						tp.Skip = true
					}
					if perr != nil {
						errs = append(errs, *perr)
					}
					if res.Components == ModeAutoCreate {
						plan.newComponents[norm] = v
						tp.ComponentTitle = norm
					}
				}
			}
		}

		// tags (CSV cell, comma-separated paths)
		if idx, ok := colIdxByAttr["tags"]; ok {
			for raw := range strings.SplitSeq(cell(row, idx), ",") {
				v := strings.TrimSpace(raw)
				if v == "" {
					continue
				}
				norm := normalize(v)
				if _, known := lk.tagsByPath[norm]; known {
					tp.TagPaths = append(tp.TagPaths, norm)
					continue
				}
				sk, perr := decideRefMode("tag", v, res.Tags, rowNum)
				if sk {
					tp.Skip = true
				}
				if perr != nil {
					errs = append(errs, *perr)
				}
				if res.Tags == ModeAutoCreate {
					plan.newTags[norm] = v
					tp.TagPaths = append(tp.TagPaths, norm)
				}
			}
		}

		// assignee (lookup person by email)
		if idx, ok := colIdxByAttr["assignee_email"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				norm := normalize(v)
				if _, known := lk.personsByEmail[norm]; known {
					tp.AssigneeEmail = norm
				} else {
					sk, perr := decideRefMode("person", v, res.Persons, rowNum)
					if sk {
						tp.Skip = true
					}
					if perr != nil {
						errs = append(errs, *perr)
					}
					if res.Persons == ModeAutoCreate {
						// Capture the display name from the same row,
						// fall back to the email's local-part.
						name := ""
						if nameIdx, ok := colIdxByAttr["assignee_name"]; ok {
							name = strings.TrimSpace(cell(row, nameIdx))
						}
						if name == "" {
							name = personNameFromEmail(v)
						}
						plan.newPersons[norm] = name
						tp.AssigneeEmail = norm
						tp.AssigneeName = name
					}
				}
			}
		}

		// description (free text)
		if idx, ok := colIdxByAttr["description"]; ok {
			tp.Description = cell(row, idx)
		}

		// sort_order (number)
		if idx, ok := colIdxByAttr["sort_order"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				if _, perr := strconv.ParseFloat(v, 64); perr != nil {
					errs = append(errs, PreviewError{Row: rowNum, Column: "sort_order",
						Message: fmt.Sprintf("sort_order %q is not numeric", v)})
				}
				tp.SortOrder = v
			}
		}

		if tp.Skip {
			plan.skippedRows++
			continue
		}
		rowErrors = append(rowErrors, errs...)
		plan.processedRows++
		plan.tasks = append(plan.tasks, tp)
	}
	return plan, rowErrors
}

// decideRefMode is the same skip/auto-create/match decision used by
// the preview pass — kept identical so the dry-run accurately
// predicts the commit's behaviour.
func decideRefMode(category, value, mode string, rowNum int) (bool, *PreviewError) {
	switch mode {
	case ModeSkip:
		return true, nil
	case ModeAutoCreate, ModeLeaveBlank:
		return false, nil
	default:
		return false, &PreviewError{Row: rowNum, Column: category,
			Message: fmt.Sprintf("unknown %s %q (no resolution mode set)", category, value)}
	}
}

/* -------------------------------------------------------------------------- */
/* Auto-create + insert                                                       */
/* -------------------------------------------------------------------------- */

// createAutoCards inserts every queued person / milestone / component /
// tag through card.insert and updates `lk` with the new ids. Each
// category is one batched card.insert call regardless of count.
func createAutoCards(ctx context.Context, tx pgx.Tx, projectID int64, plan commitPlan, lk *lookups) error {
	// Persons (global; no parent).
	if len(plan.newPersons) > 0 {
		ins := make([]any, 0, len(plan.newPersons))
		emails := make([]string, 0, len(plan.newPersons))
		for email, name := range plan.newPersons {
			emailJSON, _ := json.Marshal(email)
			ins = append(ins, card.InsertInput{
				CardTypeName: "person",
				Title:        name,
				Attributes:   map[string]json.RawMessage{"email": emailJSON},
			})
			emails = append(emails, email)
		}
		outs, err := callCardInsert(ctx, tx, ins)
		if err != nil {
			return fmt.Errorf("auto-create persons: %w", err)
		}
		for i, o := range outs {
			lk.personsByEmail[emails[i]] = o.ID
		}
	}

	// Milestones / components are parented under the project; both share
	// the same shape (title-only attribute).
	if err := createValueCards(ctx, tx, "milestone", projectID, plan.newMilestones, lk.milestonesByTitle); err != nil {
		return err
	}
	if err := createValueCards(ctx, tx, "component", projectID, plan.newComponents, lk.componentsByTitle); err != nil {
		return err
	}

	// Tags carry an extra `path` attribute.
	if len(plan.newTags) > 0 {
		ins := make([]any, 0, len(plan.newTags))
		paths := make([]string, 0, len(plan.newTags))
		for norm, raw := range plan.newTags {
			pathJSON, _ := json.Marshal(raw)
			ins = append(ins, card.InsertInput{
				CardTypeName: "tag",
				ParentCardID: &projectID,
				Title:        raw,
				Attributes:   map[string]json.RawMessage{"path": pathJSON},
			})
			paths = append(paths, norm)
		}
		outs, err := callCardInsert(ctx, tx, ins)
		if err != nil {
			return fmt.Errorf("auto-create tags: %w", err)
		}
		for i, o := range outs {
			lk.tagsByPath[paths[i]] = o.ID
		}
	}
	return nil
}

// createValueCards is the shared shape for milestone / component
// auto-creates — title-only, parented under the project.
func createValueCards(ctx context.Context, tx pgx.Tx, typeName string, projectID int64, queue map[string]string, into map[string]int64) error {
	if len(queue) == 0 {
		return nil
	}
	ins := make([]any, 0, len(queue))
	keys := make([]string, 0, len(queue))
	for norm, raw := range queue {
		ins = append(ins, card.InsertInput{
			CardTypeName: typeName,
			ParentCardID: &projectID,
			Title:        raw,
		})
		keys = append(keys, norm)
	}
	outs, err := callCardInsert(ctx, tx, ins)
	if err != nil {
		return fmt.Errorf("auto-create %ss: %w", typeName, err)
	}
	for i, o := range outs {
		into[keys[i]] = o.ID
	}
	return nil
}

// insertTasks runs the final pass: one batched card.insert with every
// task in the plan. Each task carries its resolved attribute map.
// Returns the number of tasks created.
func insertTasks(ctx context.Context, tx pgx.Tx, projectID int64, plan commitPlan, lk *lookups) (int, error) {
	if len(plan.tasks) == 0 {
		return 0, nil
	}
	ins := make([]any, 0, len(plan.tasks))
	for _, tp := range plan.tasks {
		attrs := map[string]json.RawMessage{}
		if tp.Description != "" {
			b, _ := json.Marshal(tp.Description)
			attrs["description"] = b
		}
		if tp.SortOrder != "" {
			// sort_order is numeric in the schema; the validator
			// rejected non-numeric values during planCommit, so a
			// raw write is safe here.
			attrs["sort_order"] = json.RawMessage(tp.SortOrder)
		}
		if id, ok := lk.milestonesByTitle[tp.MilestoneTitle]; ok && tp.MilestoneTitle != "" {
			attrs["milestone_ref"] = json.RawMessage(strconv.FormatInt(id, 10))
		}
		if id, ok := lk.componentsByTitle[tp.ComponentTitle]; ok && tp.ComponentTitle != "" {
			attrs["component_ref"] = json.RawMessage(strconv.FormatInt(id, 10))
		}
		if len(tp.TagPaths) > 0 {
			tagIDs := make([]int64, 0, len(tp.TagPaths))
			for _, p := range tp.TagPaths {
				if id, ok := lk.tagsByPath[p]; ok {
					tagIDs = append(tagIDs, id)
				}
			}
			if len(tagIDs) > 0 {
				b, _ := json.Marshal(tagIDs)
				attrs["tags"] = b
			}
		}
		if tp.AssigneeEmail != "" {
			if id, ok := lk.personsByEmail[tp.AssigneeEmail]; ok {
				attrs["assignee"] = json.RawMessage(strconv.FormatInt(id, 10))
			}
		}
		ins = append(ins, card.InsertInput{
			CardTypeName: "task",
			ParentCardID: &projectID,
			Title:        tp.Title,
			Attributes:   attrs,
		})
	}
	if _, err := callCardInsert(ctx, tx, ins); err != nil {
		return 0, fmt.Errorf("insert tasks: %w", err)
	}
	return len(ins), nil
}

// callCardInsert is the typed wrapper around reg.Lookup("card",
// "insert"). The dispatcher invokes Run with the same signature; we
// piggy-back on it so the import emits the runtime's card_create +
// attr_update activities without duplicating the SQL.
func callCardInsert(ctx context.Context, tx pgx.Tx, ins []any) ([]card.InsertOutput, error) {
	h, ok := reg.Lookup("card", "insert")
	if !ok {
		return nil, fmt.Errorf("card.insert not registered")
	}
	rawOuts, err := h.Run(ctx, tx, ins)
	if err != nil {
		return nil, err
	}
	outs := make([]card.InsertOutput, len(rawOuts))
	for i, o := range rawOuts {
		outs[i] = o.(card.InsertOutput)
	}
	return outs, nil
}

/* -------------------------------------------------------------------------- */
/* Persistence                                                                */
/* -------------------------------------------------------------------------- */

// persistSuccess marks the job 'completed' and writes the summary. We
// run it inside the same tx as the inserts so the row's status is
// committed exactly when the data is.
func persistSuccess(ctx context.Context, tx pgx.Tx, jobID int64, out CommitOutput) error {
	summary, err := json.Marshal(out)
	if err != nil {
		return fmt.Errorf("encode summary: %w", err)
	}
	_, err = tx.Exec(ctx, `
		UPDATE import_job
		   SET status = 'completed',
		       summary = $1::jsonb,
		       completed_at = now()
		 WHERE id = $2
	`, summary, jobID)
	if err != nil {
		return fmt.Errorf("persist commit success: %w", err)
	}
	return nil
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

// personNameFromEmail extracts the local-part of an email address as
// a fallback display name. "alice.smith@example" -> "alice.smith".
func personNameFromEmail(email string) string {
	at := strings.IndexByte(email, '@')
	if at <= 0 {
		return email
	}
	return email[:at]
}
