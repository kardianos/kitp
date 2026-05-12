// File projectimport/preview.go: dry-run pass.
//
// The preview reads the CSV bytes plus the persisted mapping, walks
// every data row, resolves each cell into the target column type
// (text / enum / card-ref), and tallies:
//
//   - WouldCreate counts per category (tasks always count by one;
//     persons / milestones / components / tags count by `auto_create`
//     hits on values that don't already exist).
//   - SkippedRows for rows the resolution says to drop.
//   - Errors with (row, column, message) for cells that fail (e.g.
//     status maps to nothing and the mode isn't `skip`).
//
// The handler stores resolution + summary on the import_job row and
// marks status='previewed' so the wizard can resume from this step
// after a refresh.
package projectimport

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

func runPreview(p *store.Pool) func(context.Context, pgx.Tx, []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(PreviewInput)
			if in.JobID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.import.preview: job_id is required"}
			}
			if err := validateResolution(in.Resolution); err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: err.Error()}
			}

			// 1. Load the job + its mapping.
			job, err := loadJob(ctx, tx, in.JobID)
			if err != nil {
				return nil, err
			}
			if job.Mapping == nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "no_mapping",
					Message: "project.import.preview: job has no mapping; call set_mapping first"}
			}

			// 2. Load CSV bytes + parse.
			body, err := readFileBytes(ctx, tx, job.FileID)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "csv_read",
					Message: err.Error()}
			}
			header, rows, err := readAllCSV(body)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "csv_parse",
					Message: err.Error()}
			}

			// 3. Pre-load the per-project lookup tables: existing
			//    milestones (title -> id), components, tags (path -> id),
			//    persons (email -> id), and status enum options.
			lookup, err := loadLookups(ctx, tx, job.ProjectID)
			if err != nil {
				return nil, err
			}

			// 4. Walk rows.
			out := dryRun(header, rows, job.Mapping, in.Resolution, lookup)
			out.Status = "previewed"

			// 5. Persist resolution + summary.
			resPayload, err := json.Marshal(in.Resolution)
			if err != nil {
				return nil, fmt.Errorf("encode resolution: %w", err)
			}
			summary, err := json.Marshal(out)
			if err != nil {
				return nil, fmt.Errorf("encode summary: %w", err)
			}
			ct, err := tx.Exec(ctx, `
				UPDATE import_job
				   SET resolution = $1::jsonb,
				       summary    = $2::jsonb,
				       status     = 'previewed'
				 WHERE id = $3
			`, resPayload, summary, in.JobID)
			if err != nil {
				return nil, fmt.Errorf("project.import.preview: persist: %w", err)
			}
			if ct.RowsAffected() == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "job_not_found",
					Message: fmt.Sprintf("project.import.preview: job %d not found", in.JobID)}
			}
			outs[i] = out
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

// validateResolution rejects invalid resolution modes.
func validateResolution(r ResolutionConfig) error {
	check := func(label, mode string, allowAutoCreate, allowLeaveBlank bool) error {
		if mode == "" {
			return nil // unset → defaults to match_existing at apply-time
		}
		if !validResolutionMode(mode, allowAutoCreate, allowLeaveBlank) {
			return fmt.Errorf("resolution.%s: %q not allowed", label, mode)
		}
		return nil
	}
	if err := check("persons", r.Persons, true, true); err != nil {
		return err
	}
	if err := check("milestones", r.Milestones, true, true); err != nil {
		return err
	}
	if err := check("components", r.Components, true, true); err != nil {
		return err
	}
	if err := check("tags", r.Tags, true, true); err != nil {
		return err
	}
	return nil
}

/* -------------------------------------------------------------------------- */
/* Job + lookup loaders                                                       */
/* -------------------------------------------------------------------------- */

// importJob mirrors the row.
type importJob struct {
	ID        int64
	ProjectID int64
	FileID    int64
	Status    string
	Mapping   map[string]string
}

func loadJob(ctx context.Context, tx pgx.Tx, jobID int64) (*importJob, error) {
	var (
		j    importJob
		mapb []byte
	)
	err := tx.QueryRow(ctx, `
		SELECT id, project_id, file_id, status, COALESCE(mapping, 'null'::jsonb)
		FROM import_job WHERE id = $1
	`, jobID).Scan(&j.ID, &j.ProjectID, &j.FileID, &j.Status, &mapb)
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
	return &j, nil
}

// lookups bundles every per-project (and global, for persons) table we
// need to resolve unknown ids during the dry-run.
type lookups struct {
	milestonesByTitle map[string]int64
	componentsByTitle map[string]int64
	tagsByPath        map[string]int64
	personsByEmail    map[string]int64
}

func loadLookups(ctx context.Context, tx pgx.Tx, projectID int64) (*lookups, error) {
	out := &lookups{
		milestonesByTitle: map[string]int64{},
		componentsByTitle: map[string]int64{},
		tagsByPath:        map[string]int64{},
		personsByEmail:    map[string]int64{},
	}

	const valueQuery = `
		SELECT c.id, COALESCE(av.value #>> '{}', '')
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = $1
		LEFT JOIN attribute_value av
		  JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = $2
		  ON av.card_id = c.id
		WHERE c.parent_card_id = $3 AND c.deleted_at IS NULL
	`
	scan := func(typeName, attrName string, into map[string]int64) error {
		rows, err := tx.Query(ctx, valueQuery, typeName, attrName, projectID)
		if err != nil {
			return fmt.Errorf("load %s: %w", typeName, err)
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			var v string
			if err := rows.Scan(&id, &v); err != nil {
				return err
			}
			if v != "" {
				into[normalize(v)] = id
			}
		}
		return rows.Err()
	}
	if err := scan("milestone", "title", out.milestonesByTitle); err != nil {
		return nil, err
	}
	if err := scan("component", "title", out.componentsByTitle); err != nil {
		return nil, err
	}
	if err := scan("tag", "path", out.tagsByPath); err != nil {
		return nil, err
	}

	// Persons are global — no parent_card_id filter.
	rows, err := tx.Query(ctx, `
		SELECT c.id, COALESCE(av.value #>> '{}', '')
		FROM card c
		JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'person'
		LEFT JOIN attribute_value av
		  JOIN attribute_def ad ON ad.id = av.attribute_def_id AND ad.name = 'email'
		  ON av.card_id = c.id
		WHERE c.deleted_at IS NULL
	`)
	if err != nil {
		return nil, fmt.Errorf("load persons: %w", err)
	}
	for rows.Next() {
		var id int64
		var email string
		if err := rows.Scan(&id, &email); err != nil {
			rows.Close()
			return nil, err
		}
		if email != "" {
			out.personsByEmail[normalize(email)] = id
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

/* -------------------------------------------------------------------------- */
/* Dry-run                                                                    */
/* -------------------------------------------------------------------------- */

// Recognised target attribute names. Anything outside this set is
// flagged at preview time so the wizard catches typos in the mapping.
var supportedTargetAttrs = map[string]struct{}{
	"id":             {},
	"title":          {},
	"assignee_email": {},
	"assignee_name":  {},
	"milestone":      {},
	"component":      {},
	"tags":           {},
	"description":    {},
	"sort_order":     {},
}

// dryRun applies mapping + resolution to every row and returns a
// PreviewOutput suitable to surface in the wizard. The pass never
// mutates the database — auto-create counts here are the *would*
// numbers; the commit step (phase 6) actually creates the rows.
func dryRun(header []string, rows [][]string, mapping map[string]string, res ResolutionConfig, lk *lookups) PreviewOutput {
	out := PreviewOutput{Errors: []PreviewError{}}

	// Build a per-row column index: target_attr → csv column index.
	// Headers that aren't in the mapping default to ignore.
	colIdxByAttr := map[string]int{}
	unknownTargets := map[string]bool{}
	for i, h := range header {
		target, ok := mapping[h]
		if !ok || target == "" || target == IgnoreColumnSentinel {
			continue
		}
		if _, supported := supportedTargetAttrs[target]; !supported {
			unknownTargets[target] = true
			continue
		}
		colIdxByAttr[target] = i
	}
	for t := range unknownTargets {
		out.Errors = append(out.Errors, PreviewError{
			Row: 0, Column: t,
			Message: fmt.Sprintf("mapping target %q is not a known task column", t),
		})
	}

	// Auto-create counts are de-duplicated across rows: if 12 rows
	// reference the same unknown milestone "M-new", we only count one
	// would-create. The sets below track which values would be created.
	wouldCreate := struct {
		persons    map[string]struct{}
		milestones map[string]struct{}
		components map[string]struct{}
		tags       map[string]struct{}
	}{
		persons:    map[string]struct{}{},
		milestones: map[string]struct{}{},
		components: map[string]struct{}{},
		tags:       map[string]struct{}{},
	}

	tasksKept := 0
rowLoop:
	for i, row := range rows {
		rowNum := i + 2 // 1-indexed; header is row 1.
		skip := false
		rowErrors := []PreviewError{}

		// Required-ish columns: title.
		if titleIdx, ok := colIdxByAttr["title"]; ok {
			if cell(row, titleIdx) == "" {
				rowErrors = append(rowErrors, PreviewError{
					Row: rowNum, Column: "title",
					Message: "title is required",
				})
			}
		}

		// Milestone (lookup by title).
		if idx, ok := colIdxByAttr["milestone"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				if _, known := lk.milestonesByTitle[normalize(v)]; !known {
					sk, err := applyRefResolution("milestone", v, res.Milestones, rowNum)
					if sk {
						skip = true
					}
					if err != nil {
						rowErrors = append(rowErrors, *err)
					} else if res.Milestones == ModeAutoCreate {
						wouldCreate.milestones[normalize(v)] = struct{}{}
					}
				}
			}
		}

		// Component (lookup by title).
		if idx, ok := colIdxByAttr["component"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				if _, known := lk.componentsByTitle[normalize(v)]; !known {
					sk, err := applyRefResolution("component", v, res.Components, rowNum)
					if sk {
						skip = true
					}
					if err != nil {
						rowErrors = append(rowErrors, *err)
					} else if res.Components == ModeAutoCreate {
						wouldCreate.components[normalize(v)] = struct{}{}
					}
				}
			}
		}

		// Tags (comma-separated list of paths).
		if idx, ok := colIdxByAttr["tags"]; ok {
			for raw := range strings.SplitSeq(cell(row, idx), ",") {
				v := strings.TrimSpace(raw)
				if v == "" {
					continue
				}
				if _, known := lk.tagsByPath[normalize(v)]; !known {
					sk, err := applyRefResolution("tag", v, res.Tags, rowNum)
					if sk {
						skip = true
					}
					if err != nil {
						rowErrors = append(rowErrors, *err)
					} else if res.Tags == ModeAutoCreate {
						wouldCreate.tags[normalize(v)] = struct{}{}
					}
				}
			}
		}

		// Assignee — match by email; auto-create uses both email + name.
		if idx, ok := colIdxByAttr["assignee_email"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				if _, known := lk.personsByEmail[normalize(v)]; !known {
					sk, err := applyRefResolution("person", v, res.Persons, rowNum)
					if sk {
						skip = true
					}
					if err != nil {
						rowErrors = append(rowErrors, *err)
					} else if res.Persons == ModeAutoCreate {
						wouldCreate.persons[normalize(v)] = struct{}{}
					}
				}
			}
		}

		// sort_order: must parse as a number when present.
		if idx, ok := colIdxByAttr["sort_order"]; ok {
			v := strings.TrimSpace(cell(row, idx))
			if v != "" {
				if _, err := strconv.ParseFloat(v, 64); err != nil {
					rowErrors = append(rowErrors, PreviewError{
						Row: rowNum, Column: "sort_order",
						Message: fmt.Sprintf("sort_order %q is not numeric", v),
					})
				}
			}
		}

		if skip {
			out.SkippedRows++
			continue rowLoop
		}
		out.Errors = append(out.Errors, rowErrors...)
		if len(rowErrors) == 0 {
			tasksKept++
		}
		out.ProcessedRows++
	}
	out.WouldCreate = WouldCreate{
		Tasks:      tasksKept,
		Persons:    len(wouldCreate.persons),
		Milestones: len(wouldCreate.milestones),
		Components: len(wouldCreate.components),
		Tags:       len(wouldCreate.tags),
	}
	return out
}

// applyRefResolution returns (skipRow, error). The error is non-nil
// only when the mode is `match_existing` (default) — every other mode
// either accepts the row (auto_create, leave_blank) or skips it.
func applyRefResolution(category, value, mode string, rowNum int) (bool, *PreviewError) {
	switch mode {
	case ModeSkip:
		return true, nil
	case ModeAutoCreate, ModeLeaveBlank:
		return false, nil
	default: // "" or match_existing
		return false, &PreviewError{
			Row: rowNum, Column: category,
			Message: fmt.Sprintf("unknown %s %q (no resolution mode set)", category, value),
		}
	}
}

func cell(row []string, idx int) string {
	if idx < 0 || idx >= len(row) {
		return ""
	}
	return row[idx]
}

// normalize lowercases + trims spaces so case mismatches don't cause
// a spurious "unknown" classification. Persons match on lowercased
// email; milestones / components on lowercased title.
func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
