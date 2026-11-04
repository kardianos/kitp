// File projectimport/csv.go: CSV ingestion helpers.
//
// Reads file bytes by walking the file → file_chunk → cas_blob_data
// chain, then parses the CSV. encoding/csv handles the quoting rules
// the export emits, so a round-trip (export → import) is exact.
package projectimport

import (
	"bytes"
	"context"
	"encoding/csv"
	"errors"
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"

	"github.com/kitp/kitp/server/internal/csvsafe"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// errNoFile: the file doesn't exist, has no bytes, or isn't one the caller
// may read. One answer for all three, so ids can't be probed.
var errNoFile = errors.New("file not found")

// errTooLarge: the file is over MaxImportBytes.
var errTooLarge = errors.New("file too large to import")

// MaxImportBytes caps a CSV import's file. The whole file is read and
// parsed in memory, at many times its size (a 20 MB file took 333 MB), so
// one large upload could exhaust the server (review 2026-11-03 round 2
// #11). 16 MB is a few hundred thousand tasks.
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

// readFileBytes assembles every chunk for fileID into one byte slice.
// CSVs are typically small (kilobytes); we don't try to stream.
//
// The query orders by file_chunk.seq so the reassembled bytes match
// what file.create stored.
//
// reader must be allowed the file by the rule attachment.create uses
// (file_readable_by: they uploaded it, or may download it where it is
// attached). Without that any worker could read any stored file — another
// project's attachments, saved emails — through an import's preview
// (review 2026-11-03 #5, round 2 #10). A file over MaxImportBytes is
// errTooLarge before a byte is read. Other failures are wrapped for the
// log; their text never reaches the caller.
func readFileBytes(ctx context.Context, tx store.Querier, reader, fileID int64) ([]byte, error) {
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
	q, args, err := b.Compile(`
		SELECT bd.data
		FROM file_chunk fc
		JOIN cas_blob_data bd ON bd.address = fc.cas_address
		WHERE fc.file_id = :file
		ORDER BY fc.seq
	`)
	if err != nil {
		return nil, fmt.Errorf("read file: compile: %w", err)
	}
	rows, err := tx.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	defer rows.Close()
	var buf bytes.Buffer
	for rows.Next() {
		var chunk []byte
		if err := rows.Scan(&chunk); err != nil {
			return nil, fmt.Errorf("read file: %w", err)
		}
		if int64(buf.Len()+len(chunk)) > MaxImportBytes {
			return nil, errTooLarge
		}
		buf.Write(chunk)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	if buf.Len() == 0 {
		return nil, errNoFile
	}
	return buf.Bytes(), nil
}

// parsedCSV holds enough of the CSV for the upload step's response.
type parsedCSV struct {
	Headers     []string
	PreviewRows [][]string
	RowCount    int
}

// parseCSVPreview pulls the header row + the first `limit` data rows
// out of `body`. RowCount is the total data-row count (no header).
//
// We accept ragged rows — encoding/csv's `FieldsPerRecord=-1` lets a
// trailing-comma or short row pass without error so the mapping UI
// can show "you have 12 columns; row 4 has 11."
func parseCSVPreview(body []byte, limit int) (parsedCSV, error) {
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	header, err := cr.Read()
	if err == io.EOF {
		return parsedCSV{}, errEmptyCSV
	}
	if err != nil {
		return parsedCSV{}, fmt.Errorf("read header: %w", err)
	}
	out := parsedCSV{Headers: header}
	for {
		row, err := cr.Read()
		if err == io.EOF {
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

// readAllCSV returns every row (header + data) for the preview pass.
// We pull the rows up-front instead of streaming so the preview can
// build the would_create counts and the error log in one walk.
func readAllCSV(body []byte) ([]string, [][]string, error) {
	cr := csv.NewReader(bytes.NewReader(body))
	cr.FieldsPerRecord = -1
	cr.LazyQuotes = true

	header, err := cr.Read()
	if err == io.EOF {
		return nil, nil, errEmptyCSV
	}
	if err != nil {
		return nil, nil, fmt.Errorf("read header: %w", err)
	}
	var rows [][]string
	for {
		row, err := cr.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, fmt.Errorf("read row %d: %w", len(rows)+1, err)
		}
		if len(rows) >= MaxImportRows {
			return nil, nil, errTooManyRows
		}
		rows = append(rows, uncellRow(row))
	}
	return header, rows, nil
}

// uncellRow undoes csvsafe's formula guard on an exported file's cells, so
// an export re-imports exactly.
func uncellRow(row []string) []string {
	for i, c := range row {
		row[i] = csvsafe.Uncell(c)
	}
	return row
}
