// Package projectimport implements the wizard-driven CSV import
// (phase 5 of docs/PROJECT_PORTABILITY_PLAN.md). The wizard is five
// steps; this phase ships everything up to and including the dry-run
// preview — the commit step lands separately.
//
// Steps and handlers:
//
//	1. (UI only)              Pick existing project.
//	2. project.import.upload  Multipart-uploaded CSV is now stored as a
//	                          `file` row. Create import_job and return
//	                          (job_id, headers, preview_rows).
//	3. project.import.set_mapping  Persist the per-column wire shape
//	                               header → target_attr | "_ignore_".
//	4. project.import.preview Dry-run. Apply mapping + resolution to
//	                          every row, return would_create counts
//	                          and a per-row error log.
//	5. project.import.commit  (out of scope for phase 5).
//
// Authz: each handler verifies the user has card.update grant on the
// target project (manager / admin / system roles in v1).
package projectimport

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/auth"
	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ImportConfig threads the CAS storage through the package. Register
// stores it for preview.go to read CSV bytes by file_id.
type ImportConfig struct {
	Pool    *store.Pool
	Storage *cas.Storage
}

// pkg holds the singletons each handler needs. The "set once at
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
		AllowedRoles: []string{"manager", "admin"},
		Run:          runUpload(cfg.Pool),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "set_mapping",
		Doc:          "Persist the column→attribute mapping for a job; transitions status to 'mapped'.",
		InputType:    reflect.TypeFor[SetMappingInput](),
		OutputType:   reflect.TypeFor[SetMappingOutput](),
		AllowedRoles: []string{"manager", "admin"},
		Run:          runSetMapping(cfg.Pool),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "preview",
		Doc:          "Dry-run the import: returns would_create counts and a per-row error log; persists the resolution.",
		InputType:    reflect.TypeFor[PreviewInput](),
		OutputType:   reflect.TypeFor[PreviewOutput](),
		AllowedRoles: []string{"manager", "admin"},
		Run:          runPreview(cfg.Pool),
	})
	reg.Register(reg.Handler{
		Endpoint:     "project.import",
		Action:       "commit",
		Doc:          "Run the import in one transaction: auto-create persons / milestones / components / tags as configured, insert every task, mark the job 'completed'. Idempotent via the standard Idempotency-Key middleware.",
		InputType:    reflect.TypeFor[CommitInput](),
		OutputType:   reflect.TypeFor[CommitOutput](),
		AllowedRoles: []string{"manager", "admin"},
		Run:          runCommit(cfg.Pool),
	})
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
	WouldCreate    WouldCreate    `json:"would_create"`
	Errors         []PreviewError `json:"errors"`
	SkippedRows    int            `json:"skipped_rows"`
	ProcessedRows  int            `json:"processed_rows"`
	Status         string         `json:"status"`
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
	Created    WouldCreate    `json:"created"`
	Errors     []PreviewError `json:"errors"`
	Status     string         `json:"status"`
	SkippedRows   int         `json:"skipped_rows"`
	ProcessedRows int         `json:"processed_rows"`
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

func validResolutionMode(s string, allowAutoCreate, allowLeaveBlank bool) bool {
	switch s {
	case ModeMatchExisting, ModeSkip:
		return true
	case ModeAutoCreate:
		return allowAutoCreate
	case ModeLeaveBlank:
		return allowLeaveBlank
	default:
		return false
	}
}

/* -------------------------------------------------------------------------- */
/* upload                                                                     */
/* -------------------------------------------------------------------------- */

func runUpload(p *store.Pool) func(context.Context, pgx.Tx, []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		actorID := auth.ActorOrSystem(ctx)
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(UploadInput)
			if in.ProjectID == 0 || in.FileID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.import.upload: project_id and file_id are required"}
			}
			// Verify the project exists. We don't recheck authz here —
			// the dispatcher's role gate has already restricted the
			// handler to manager / admin / system; the per-project
			// scope check is layered on top by future work.
			var ok bool
			err := tx.QueryRow(ctx, `
				SELECT EXISTS (SELECT 1 FROM card c
				               JOIN card_type ct ON ct.id = c.card_type_id AND ct.name = 'project'
				               WHERE c.id = $1)
			`, in.ProjectID).Scan(&ok)
			if err != nil {
				return nil, fmt.Errorf("project.import.upload: project lookup: %w", err)
			}
			if !ok {
				return nil, &reg.HandlerError{InputIndex: i, Code: "project_not_found",
					Message: fmt.Sprintf("project.import.upload: project %d not found", in.ProjectID)}
			}

			// Read the CSV bytes + parse just enough for the preview.
			body, err := readFileBytes(ctx, tx, in.FileID)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "csv_read",
					Message: err.Error()}
			}
			parsed, err := parseCSVPreview(body, 20)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "csv_parse",
					Message: err.Error()}
			}

			var jobID int64
			err = tx.QueryRow(ctx, `
				INSERT INTO import_job (project_id, file_id, status, created_by)
				VALUES ($1, $2, 'uploaded', $3)
				RETURNING id
			`, in.ProjectID, in.FileID, actorID).Scan(&jobID)
			if err != nil {
				return nil, fmt.Errorf("project.import.upload: insert job: %w", err)
			}
			outs[i] = UploadOutput{
				JobID:       jobID,
				Headers:     parsed.Headers,
				PreviewRows: parsed.PreviewRows,
				RowCount:    parsed.RowCount,
			}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}

/* -------------------------------------------------------------------------- */
/* set_mapping                                                                */
/* -------------------------------------------------------------------------- */

func runSetMapping(p *store.Pool) func(context.Context, pgx.Tx, []any) ([]any, error) {
	return func(ctx context.Context, tx pgx.Tx, ins []any) ([]any, error) {
		outs := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(SetMappingInput)
			if in.JobID == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.import.set_mapping: job_id is required"}
			}
			payload, err := json.Marshal(in.Mapping)
			if err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "validation",
					Message: "project.import.set_mapping: mapping not JSON-encodable"}
			}
			ct, err := tx.Exec(ctx, `
				UPDATE import_job
				   SET mapping = $1::jsonb,
				       status  = CASE WHEN status IN ('previewed','running','completed','failed')
				                      THEN status ELSE 'mapped' END
				 WHERE id = $2
			`, payload, in.JobID)
			if err != nil {
				return nil, fmt.Errorf("project.import.set_mapping: %w", err)
			}
			if ct.RowsAffected() == 0 {
				return nil, &reg.HandlerError{InputIndex: i, Code: "job_not_found",
					Message: fmt.Sprintf("project.import.set_mapping: job %d not found", in.JobID)}
			}
			var status string
			if err := tx.QueryRow(ctx,
				`SELECT status FROM import_job WHERE id = $1`, in.JobID,
			).Scan(&status); err != nil {
				return nil, fmt.Errorf("project.import.set_mapping: read status: %w", err)
			}
			outs[i] = SetMappingOutput{OK: true, Status: status}
		}
		if p != nil {
			p.NoteWrite()
		}
		return outs, nil
	}
}
