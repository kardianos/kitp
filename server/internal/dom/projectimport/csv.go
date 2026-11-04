// File projectimport/csv.go: CSV ingestion helpers.
//
// Reads file bytes by walking the file → file_chunk → cas_blob_data
// chain one chunk at a time, and parses the CSV as it is read. encoding/csv handles the quoting rules
// the export emits, so a round-trip (export → import) is exact.
package projectimport

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/csvsafe"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
	"github.com/kitp/kitp/server/internal/textnorm"
)

// errNoFile: the file doesn't exist, has no bytes, or isn't one the caller
// may read. One answer for all three, so ids can't be probed.
var errNoFile = errors.New("file not found")

// errTooLarge: the file is over MaxImportBytes.
var errTooLarge = errors.New("file too large to import")

// MaxImportBytes caps a CSV import's file (review 2026-11-03 round 2 #11).
// The file is read a chunk at a time and its rows stored as they parse
// (round 4 #3); the cap bounds one import's work. 16 MB is a few hundred
// thousand tasks.
const MaxImportBytes = 16 << 20

// MaxImportRows caps the data rows of one import.
const MaxImportRows = 100000

var errTooManyRows = fmt.Errorf("more than %d rows", MaxImportRows)

// csvParseMessage is what the caller is told about a CSV that doesn't
// parse: which line and column broke and why, in encoding/csv's own short
// words — never a Go error chain (CLAUDE.md "Error returns"; review
// 2026-11-03 round 2 #20).
func csvParseMessage(err error) string {
	var pe *csv.ParseError
	switch {
	case errors.As(err, &pe):
		return fmt.Sprintf("line %d, column %d: %v", pe.Line, pe.Column, pe.Err)
	case errors.Is(err, errTooManyRows):
		return fmt.Sprintf("the file has more than %d rows; split it", MaxImportRows)
	case errors.Is(err, errEmptyCSV):
		return "the file is empty"
	}
	return "the file isn't a readable CSV"
}

var errEmptyCSV = errors.New("csv is empty")

// openFile returns a reader over fileID's bytes that loads one stored
// chunk at a time, so an import never holds its file whole (review
// 2026-11-03 round 4 #3). The query orders the chunks by file_chunk.seq so
// the bytes match what file.create stored. No cursor stays open between
// chunks, so the caller may write to the same transaction while it reads.
//
// reader must be allowed the file by the rule attachment.create uses
// (file_readable_by: they uploaded it, or may download it where it is
// attached). Without that any worker could read any stored file — another
// project's attachments, saved emails — through an import's preview
// (review 2026-11-03 #5, round 2 #10). A file over MaxImportBytes is
// errTooLarge before a byte is read. Other failures are wrapped for the
// log; their text never reaches the caller.
func openFile(ctx context.Context, tx store.Querier, reader, fileID int64) (*chunkReader, error) {
	sb := named.New()
	sb.Set("file", fileID)
	sb.Set("reader", reader)
	sq, sargs, err := sb.Compile(`
		SELECT f.size_bytes FROM file f
		WHERE f.id = :file AND file_readable_by(:reader::bigint, f.id)
	`)
	if err != nil {
		return nil, fmt.Errorf("read file: compile: %w", err)
	}
	var size int64
	if err := tx.QueryRow(ctx, sq, sargs...).Scan(&size); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, errNoFile
		}
		return nil, fmt.Errorf("read file: %w", err)
	}
	if size > MaxImportBytes {
		return nil, errTooLarge
	}
	b := named.New()
	b.Set("file", fileID)
	q, args, err := b.Compile(`SELECT cas_address FROM file_chunk WHERE file_id = :file ORDER BY seq`)
	if err != nil {
		return nil, fmt.Errorf("read file: compile: %w", err)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	var addrs []string
	for rows.Next() {
		var a string
		if err := rows.Scan(&a); err != nil {
			rows.Close()
			return nil, fmt.Errorf("read file: %w", err)
		}
		addrs = append(addrs, a)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if len(addrs) == 0 || size == 0 {
		return nil, errNoFile
	}
	return &chunkReader{ctx: ctx, tx: tx, addrs: addrs}, nil
}

// chunkReader reads a stored file one chunk at a time. Its first failure
// is kept in err (a csv.Reader may report it wrapped, or as a parse error).
type chunkReader struct {
	ctx   context.Context
	tx    store.Querier
	addrs []string
	cur   []byte
	total int64
	err   error
}

func (c *chunkReader) Read(p []byte) (int, error) {
	for len(c.cur) == 0 {
		if c.err != nil {
			return 0, c.err
		}
		if len(c.addrs) == 0 {
			return 0, io.EOF
		}
		b := named.New()
		b.Set("address", c.addrs[0])
		q, args, err := b.Compile(`SELECT data FROM cas_blob_data WHERE address = :address`)
		if err != nil {
			c.err = fmt.Errorf("read file: compile: %w", err)
			return 0, c.err
		}
		var data []byte
		if err := c.tx.QueryRow(c.ctx, q, args...).Scan(&data); err != nil {
			c.err = fmt.Errorf("read file chunk: %w", err)
			return 0, c.err
		}
		c.addrs = c.addrs[1:]
		c.total += int64(len(data))
		if c.total > MaxImportBytes {
			c.err = errTooLarge
			return 0, c.err
		}
		c.cur = data
	}
	n := copy(p, c.cur)
	c.cur = c.cur[n:]
	return n, nil
}

// parsedCSV holds enough of the CSV for the upload step's response.
type parsedCSV struct {
	Headers     []string
	PreviewRows [][]string
	RowCount    int
}

// newCSVReader reads CSV the way every import step does. We accept ragged
// rows — encoding/csv's `FieldsPerRecord=-1` lets a trailing-comma or
// short row pass without error so the mapping UI can show "you have 12
// columns; row 4 has 11."
func newCSVReader(r io.Reader) *csv.Reader {
	cr := csv.NewReader(r)
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true
	cr.ReuseRecord = false
	return cr
}

// parseCSVPreview pulls the header row + the first `limit` data rows out
// of r, read as a stream. RowCount is the total data-row count (no
// header).
func parseCSVPreview(r io.Reader, limit int) (parsedCSV, error) {
	cr := newCSVReader(r)
	header, err := cr.Read()
	if errors.Is(err, io.EOF) {
		return parsedCSV{}, errEmptyCSV
	}
	if err != nil {
		return parsedCSV{}, fmt.Errorf("read header: %w", err)
	}
	out := parsedCSV{Headers: header}
	for {
		row, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return parsedCSV{}, fmt.Errorf("read row %d: %w", out.RowCount+1, err)
		}
		out.RowCount++
		if out.RowCount > MaxImportRows {
			return parsedCSV{}, errTooManyRows
		}
		if len(out.PreviewRows) < limit {
			out.PreviewRows = append(out.PreviewRows, uncellRow(row))
		}
	}
	return out, nil
}

// rowBatch is how many parsed rows go to the database per insert.
const rowBatch = 1000

// streamRows parses the CSV in r as it is read and stores its data rows
// in import_job_row for jobID (numbered from 1, the header not counted),
// rowBatch at a time; the preview and commit functions read them from
// there. It returns the header. Before, every row was parsed into memory
// and sent as one jsonb argument (review 2026-11-03 round 4 #3).
func streamRows(ctx context.Context, tx store.Querier, jobID int64, r io.Reader) ([]string, error) {
	if err := clearRows(ctx, tx, jobID); err != nil {
		return nil, err
	}
	cr := newCSVReader(r)
	header, err := cr.Read()
	if errors.Is(err, io.EOF) {
		return nil, errEmptyCSV
	}
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}
	batch := make([][]string, 0, rowBatch)
	n := 0
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		raw, err := json.Marshal(batch)
		if err != nil {
			return fmt.Errorf("import rows: marshal: %w", err)
		}
		b := named.New()
		b.Set("job", jobID)
		b.Set("base", n-len(batch))
		b.Set("rows", string(raw))
		q, args, err := b.Compile(`
			INSERT INTO import_job_row (job_id, n, cells)
			SELECT :job, :base::int + e.ord::int,
			       ARRAY(SELECT c FROM jsonb_array_elements_text(e.v) WITH ORDINALITY AS x(c, o) ORDER BY x.o)
			FROM jsonb_array_elements(:rows::jsonb) WITH ORDINALITY AS e(v, ord)
		`)
		if err != nil {
			return fmt.Errorf("import rows: compile: %w", err)
		}
		if _, err := tx.Exec(ctx, q, args...); err != nil {
			return fmt.Errorf("import rows: %w", err)
		}
		batch = batch[:0]
		return nil
	}
	for {
		row, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("read row %d: %w", n+1, err)
		}
		if n >= MaxImportRows {
			return nil, errTooManyRows
		}
		n++
		batch = append(batch, uncellRow(row))
		if len(batch) == rowBatch {
			if err := flush(); err != nil {
				return nil, err
			}
		}
	}
	if err := flush(); err != nil {
		return nil, err
	}
	return header, nil
}

// clearRows drops what an earlier step stored for jobID (a request that
// failed rolls its rows back; one that succeeded deletes them).
func clearRows(ctx context.Context, tx store.Querier, jobID int64) error {
	b := named.New()
	b.Set("job", jobID)
	q, args, err := b.Compile(`DELETE FROM import_job_row WHERE job_id = :job`)
	if err != nil {
		return fmt.Errorf("import rows: compile: %w", err)
	}
	if _, err := tx.Exec(ctx, q, args...); err != nil {
		return fmt.Errorf("import rows: clear: %w", err)
	}
	return nil
}

// uncellRow undoes csvsafe's formula guard on an exported file's cells, so
// an export re-imports exactly, and makes each cell storable (valid UTF-8,
// no NUL), which Postgres text needs.
func uncellRow(row []string) []string {
	for i, c := range row {
		row[i] = textnorm.Storable(csvsafe.Uncell(c))
	}
	return row
}
