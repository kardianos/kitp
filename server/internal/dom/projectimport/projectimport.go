// Package projectimport implements the wizard-driven CSV import
// (phase 5 of docs/PROJECT_PORTABILITY_PLAN.md). The wizard is five
// steps; the four batch handlers below cover upload + set_mapping +
// preview + commit.
//
// Steps and handlers:
//
//  1. (UI only)              Pick existing project.
//  2. project.import.upload  Multipart-uploaded CSV is now stored as a
//     `file` row. Create import_job and return
//     (job_id, headers, preview_rows).
//  3. project.import.set_mapping  Persist the per-column wire shape
//     header → target_attr | "_ignore_".
//  4. project.import.preview Dry-run. Apply mapping + resolution to
//     every row, return would_create counts
//     and a per-row error log.
//  5. project.import.commit  Apply the import irrevocably.
//
// All four are unified handlers (docs/UNIFIED_HANDLER_PLAN.md Phase 4):
// each is a thin Go wrapper around a PL/pgSQL function whose body
// lives in `db/schema/functions/project_import_*_batch.sql`. CSV
// parsing remains on the Go side via a `PreRun` hook that runs inside
// the dispatcher's tx — encoding/csv handles quoting + ragged rows
// cleanly, and porting that to PL/pgSQL adds risk without benefit.
// The hook reads file bytes by file_id, parses the CSV, and injects
// the structured `_parsed_header` / `_parsed_rows` / `_parsed_preview_rows`
// / `_parsed_row_count` fields into each input so the SQL function
// walks JSON arrays instead of bytes.
//
// Authz: each handler verifies the user has card.update grant on the
// target project (manager / admin / system roles in v1) via the
// standard CardTypeID + ProcessName route.
package projectimport

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/schema"
	"github.com/kitp/kitp/server/internal/store"
)

// ImportConfig threads the CAS storage through the package. Register
// stores it for the preview / commit hooks to read CSV bytes by
// file_id without standing up a separate channel.
type ImportConfig struct {
	Pool    *store.Pool
	Storage *cas.Storage
}

// pkg holds the singletons the PreRun hooks need. The "set once at
// Register, read in handlers" pattern matches what attachment does
// with SetThumbDeps; routing the storage through the registry would
// otherwise require a wide handler-signature change.
var pkg struct {
	pool    *store.Pool
	storage *cas.Storage
}

// Register installs every project.import.* handler.
func Register(cfg ImportConfig) {
	pkg.pool = cfg.Pool
	pkg.storage = cfg.Storage

	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "upload",
		Doc:          "Begin a CSV import: create the job row, parse the header + first 20 rows for preview.",
		InputType:    reflect.TypeFor[UploadInput](),
		OutputType:   reflect.TypeFor[UploadOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromUploadInput,
		// Input carries project_id, not card_id, so the per-row scope
		// pass needs an explicit walk-start: the project card itself
		// (BE-H3 / A2). Without it a project-scoped manager importing
		// into their own project would be denied.
		ScopeCardID: scopeCardFromUploadInput,
		SQLFunc:     "project_import_upload_batch",
		PreRun:      preRunUpload,
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "set_mapping",
		Doc:          "Persist the column→attribute mapping for a job; transitions status to 'mapped'.",
		InputType:    reflect.TypeFor[SetMappingInput](),
		OutputType:   reflect.TypeFor[SetMappingOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromJobID(func(in any) int64 { return in.(SetMappingInput).JobID }),
		ScopeCardID:  scopeCardFromJobID(func(in any) int64 { return in.(SetMappingInput).JobID }),
		SQLFunc:      "project_import_set_mapping_batch",
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "preview",
		Doc:          "Dry-run the import: returns would_create counts and a per-row error log; persists the resolution.",
		InputType:    reflect.TypeFor[PreviewInput](),
		OutputType:   reflect.TypeFor[PreviewOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromJobID(func(in any) int64 { return in.(PreviewInput).JobID }),
		ScopeCardID:  scopeCardFromJobID(func(in any) int64 { return in.(PreviewInput).JobID }),
		Timeout:      60 * time.Second, // scans every row of the CSV; per S1
		SQLFunc:      "project_import_preview_batch",
		PreRun:       preRunPreview,
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "commit",
		Doc:          "Run the import in one transaction: auto-create persons / milestones / components / tags as configured, insert every task, mark the job 'completed'. Idempotent via the standard Idempotency-Key middleware.",
		InputType:    reflect.TypeFor[CommitInput](),
		OutputType:   reflect.TypeFor[CommitOutput](),
		AllowedRoles: []string{"worker", "manager", "admin"},
		ProcessName:  "card.update",
		CardTypeID:   cardTypeFromJobID(func(in any) int64 { return in.(CommitInput).JobID }),
		ScopeCardID:  scopeCardFromJobID(func(in any) int64 { return in.(CommitInput).JobID }),
		Timeout:      60 * time.Second, // bulk insert path; per S1
		SQLFunc:      "project_import_commit_batch",
		PreRun:       preRunCommit,
	})
}

// cardTypeFromUploadInput resolves the target project's card_type so
// the dispatcher can scope-check the actor's `card.update` grant on
// that project.
func cardTypeFromUploadInput(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return schema.CardTypeIDByCardID(ctx, pool, raw.(UploadInput).ProjectID)
}

// scopeCardFromUploadInput returns the project card the per-row scope
// pass walks up from. The upload input's project_id IS the project
// card, so it's the right walk start (BE-H3 / A2).
func scopeCardFromUploadInput(_ context.Context, _ reg.ValidationPool, raw any) (int64, error) {
	return raw.(UploadInput).ProjectID, nil
}

// scopeCardFromJobID returns a ScopeCardID resolver that dereferences
// an import_job.id to its project card so the per-row scope pass can
// walk that card → project. The set_mapping / preview / commit inputs
// carry only a job_id, not a card_id, so without this a project-scoped
// manager would be denied (BE-H3 / A2). Returns (0, nil) on a missing
// job — the handler's own validation surfaces the not-found error.
func scopeCardFromJobID(jobIDOf func(any) int64) func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
		var projectCardID int64
		err := pool.QueryRow(ctx, `SELECT project_id FROM import_job WHERE id = $1`, jobIDOf(raw)).Scan(&projectCardID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, nil
			}
			return 0, fmt.Errorf("project.import: scope card lookup: %w", err)
		}
		return projectCardID, nil
	}
}

// cardTypeFromJobID returns an extractor that walks import_job.id →
// project_id → card.card_type_id. set_mapping / preview / commit
// only carry a job_id; resolve the project transitively so authz
// matches the actor's scoped grant on the same project upload was
// authorised for. Returns 0 (skip authz) on a missing job — the
// handler's own validation surfaces the proper not-found error.
func cardTypeFromJobID(jobIDOf func(any) int64) func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
	return func(ctx context.Context, pool reg.ValidationPool, raw any) (int64, error) {
		jobID := jobIDOf(raw)
		var cardTypeID int64
		err := pool.QueryRow(ctx, `
			SELECT c.card_type_id
			FROM import_job j
			JOIN card c ON c.id = j.project_id
			WHERE j.id = $1
		`, jobID).Scan(&cardTypeID)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return 0, nil
			}
			return 0, fmt.Errorf("project.import: card_type lookup: %w", err)
		}
		return cardTypeID, nil
	}
}

/* -------------------------------------------------------------------------- */
/* Wire shapes                                                                */
/* -------------------------------------------------------------------------- */

// UploadInput begins an import for an existing project.
type UploadInput struct {
	ProjectID int64 `json:"project_id,string" mcp:"required,desc=project id to import into"`
	FileID    int64 `json:"file_id,string"    mcp:"required,desc=id of the uploaded CSV file (from file.create)"`
}

// UploadOutput carries the job id plus enough of the CSV to drive the
// column-mapping UI without re-reading the file.
type UploadOutput struct {
	JobID       int64      `json:"job_id,string"  mcp:"desc=id of the import_job row"`
	Headers     []string   `json:"headers"        mcp:"desc=CSV header columns, in order"`
	PreviewRows [][]string `json:"preview_rows"   mcp:"desc=first 20 data rows, each row as a list of cells"`
	RowCount    int        `json:"row_count"      mcp:"desc=total data rows in the CSV"`
}

// SetMappingInput accepts a header → target-attribute map. The
// special value "_ignore_" drops a column from the import.
type SetMappingInput struct {
	JobID   int64             `json:"job_id,string" mcp:"required,desc=job id from project.import.upload"`
	Mapping map[string]string `json:"mapping"       mcp:"required,desc=csv header name to target attribute name; '_ignore_' drops a column"`
}

// SetMappingOutput is a sentinel ack; the canonical state lives in
// the import_job row.
type SetMappingOutput struct {
	OK     bool   `json:"ok"`
	Status string `json:"status" mcp:"desc=new job status (typically 'mapped')"`
}

// ResolutionConfig is the per-category instruction for unknown values
// surfaced during the preview. Each mode is one of:
//   - "match_existing" — fail rows whose value isn't an existing card.
//   - "auto_create"    — create a new card on the fly during commit.
//   - "skip"           — drop rows that reference an unknown value.
//   - "leave_blank"    — accept the row, clear the field.
type ResolutionConfig struct {
	Persons    string `json:"persons,omitempty"    mcp:"enum=match_existing|auto_create|skip|leave_blank"`
	Milestones string `json:"milestones,omitempty" mcp:"enum=match_existing|auto_create|skip|leave_blank"`
	Components string `json:"components,omitempty" mcp:"enum=match_existing|auto_create|skip|leave_blank"`
	Tags       string `json:"tags,omitempty"       mcp:"enum=match_existing|auto_create|skip|leave_blank"`
}

// PreviewInput is the dry-run trigger. The handler stores the
// resolution + summary on the job so the wizard can resume.
type PreviewInput struct {
	JobID      int64            `json:"job_id,string" mcp:"required,desc=job id"`
	Resolution ResolutionConfig `json:"resolution"    mcp:"required,desc=per-category instructions for unknown values"`
}

// WouldCreate counts the new rows that the commit would emit.
type WouldCreate struct {
	Tasks      int `json:"tasks"`
	Persons    int `json:"persons"`
	Milestones int `json:"milestones"`
	Components int `json:"components"`
	Tags       int `json:"tags"`
}

// PreviewError pins one row × one column to a diagnostic message.
type PreviewError struct {
	Row     int    `json:"row"`
	Column  string `json:"column,omitempty"`
	Message string `json:"message"`
}

// PreviewOutput is the dry-run summary.
type PreviewOutput struct {
	WouldCreate   WouldCreate    `json:"would_create"`
	Errors        []PreviewError `json:"errors"`
	SkippedRows   int            `json:"skipped_rows"`
	ProcessedRows int            `json:"processed_rows"`
	Status        string         `json:"status"`
}

// CommitInput triggers the irrevocable import. The handler reads the
// already-persisted mapping + resolution off the import_job row;
// callers don't pass them again.
type CommitInput struct {
	JobID int64 `json:"job_id,string" mcp:"required,desc=job id (must be in status 'previewed' or 'mapped')"`
}

// CommitOutput mirrors PreviewOutput so the wizard can render the
// same summary block on either branch. Created counts are real here
// (not 'would'); status is 'completed' on success, 'failed' if the
// transaction rolled back.
type CommitOutput struct {
	Created       WouldCreate    `json:"created"`
	Errors        []PreviewError `json:"errors"`
	Status        string         `json:"status"`
	SkippedRows   int            `json:"skipped_rows"`
	ProcessedRows int            `json:"processed_rows"`
}

/* -------------------------------------------------------------------------- */
/* Resolution mode constants                                                  */
/* -------------------------------------------------------------------------- */

const (
	ModeMatchExisting = "match_existing"
	ModeAutoCreate    = "auto_create"
	ModeSkip          = "skip"
	ModeLeaveBlank    = "leave_blank"

	IgnoreColumnSentinel = "_ignore_"
)

/* -------------------------------------------------------------------------- */
/* PreRun hooks: CSV parse + augment inputs                                   */
/* -------------------------------------------------------------------------- */

// preRunUpload reads the CSV bytes referenced by FileID, parses the
// header + first 20 data rows + total row count, and returns a slice
// of pre-augmented maps that the dispatcher marshals straight to the
// SQL function. The choice of `map[string]any` over a typed struct
// keeps the SQL contract decoupled from Go's exported field shape:
// the function reads from `_parsed_*` keys that don't appear on
// UploadInput, so wrapping each input in a generic map is the
// cleanest way to fit through the `[]any` channel.
func preRunUpload(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	out := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(UploadInput)
		if in.ProjectID == 0 || in.FileID == 0 {
			// Let the SQL function emit the canonical validation error;
			// pass an empty parse so the function still has the keys.
			out[i] = map[string]any{
				"project_id":           formatInt64(in.ProjectID),
				"file_id":              formatInt64(in.FileID),
				"_parsed_headers":      []string{},
				"_parsed_preview_rows": [][]string{},
				"_parsed_row_count":    0,
			}
			continue
		}
		body, err := readFileBytes(ctx, tx, in.FileID)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_read", Message: err.Error()}
		}
		parsed, err := parseCSVPreview(body, 20)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_parse", Message: err.Error()}
		}
		out[i] = map[string]any{
			"project_id":           formatInt64(in.ProjectID),
			"file_id":              formatInt64(in.FileID),
			"_parsed_headers":      parsed.Headers,
			"_parsed_preview_rows": parsed.PreviewRows,
			"_parsed_row_count":    parsed.RowCount,
		}
	}
	return out, nil
}

// preRunPreview reads the CSV bytes + parses every row (no preview
// truncation), then augments the input. The PL/pgSQL function walks
// `_parsed_header` + `_parsed_rows` directly.
func preRunPreview(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	out := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(PreviewInput)
		if in.JobID == 0 {
			// Let SQL handle validation.
			out[i] = map[string]any{
				"job_id":         "0",
				"resolution":     in.Resolution,
				"_parsed_header": []string{},
				"_parsed_rows":   [][]string{},
			}
			continue
		}
		fileID, err := lookupJobFileID(ctx, tx, in.JobID)
		if err != nil {
			return nil, err
		}
		body, err := readFileBytes(ctx, tx, fileID)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_read", Message: err.Error()}
		}
		header, rows, err := readAllCSV(body)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_parse", Message: err.Error()}
		}
		out[i] = map[string]any{
			"job_id":         formatInt64(in.JobID),
			"resolution":     in.Resolution,
			"_parsed_header": header,
			"_parsed_rows":   rows,
		}
	}
	return out, nil
}

// preRunCommit mirrors preRunPreview but for CommitInput.
func preRunCommit(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
	out := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(CommitInput)
		if in.JobID == 0 {
			out[i] = map[string]any{
				"job_id":         "0",
				"_parsed_header": []string{},
				"_parsed_rows":   [][]string{},
			}
			continue
		}
		fileID, err := lookupJobFileID(ctx, tx, in.JobID)
		if err != nil {
			return nil, err
		}
		body, err := readFileBytes(ctx, tx, fileID)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_read", Message: err.Error()}
		}
		header, rows, err := readAllCSV(body)
		if err != nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "csv_parse", Message: err.Error()}
		}
		out[i] = map[string]any{
			"job_id":         formatInt64(in.JobID),
			"_parsed_header": header,
			"_parsed_rows":   rows,
		}
	}
	return out, nil
}

// lookupJobFileID resolves the file_id for an import_job. Returns a
// `job_not_found` *reg.HandlerError when the row is missing — the
// SQL function would surface the same code on its own loop, but the
// PreRun hook needs to short-circuit the file read.
func lookupJobFileID(ctx context.Context, tx pgx.Tx, jobID int64) (int64, error) {
	var fileID int64
	err := tx.QueryRow(ctx, `SELECT file_id FROM import_job WHERE id = $1`, jobID).Scan(&fileID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, &reg.HandlerError{Code: "job_not_found",
				Message: fmt.Sprintf("import_job %d not found", jobID)}
		}
		return 0, fmt.Errorf("project.import: file_id lookup: %w", err)
	}
	return fileID, nil
}

// formatInt64 stringifies a bigint so the json tag `,string` round-trip
// preserves the value when we hand it through the map shape. The
// dispatcher's input encoding goes through json.Marshal on the slice,
// which writes maps verbatim — without the explicit string cast the
// SQL function's NULLIF(...,'')::bigint chain would fight a JSON number.
func formatInt64(v int64) string {
	if v == 0 {
		return "0"
	}
	return fmt.Sprintf("%d", v)
}

// (We retain the JSON struct definitions above purely for the
// dispatcher's reflection-based InputType machinery + the MCP tool
// surface; runtime payload assembly goes through the PreRun maps.)
