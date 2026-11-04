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

	"github.com/kitp/kitp/server/internal/csvsafe"
	"github.com/kitp/kitp/server/internal/named"
	"github.com/kitp/kitp/server/internal/store"
)

// errNoFile: the file doesn't exist, has no bytes, or isn't one the caller
// may read. One answer for all three, so ids can't be probed.
var errNoFile = errors.New("file not found")

// readFileBytes assembles every chunk for fileID into one byte slice.
// CSVs are typically small (kilobytes); we don't try to stream.
//
// The query orders by file_chunk.seq so the reassembled bytes match
// what file.create stored.
//
// reader, when non-zero, must be allowed the file by the rule
// attachment.create uses: they uploaded it, or it is attached to a card
// they can see. Without that any worker could read any stored file —
// another project's attachments, saved emails — through an import's
// preview (review 2026-11-03 #5). Other failures are wrapped for the log;
// their text never reaches the caller.
func readFileBytes(ctx context.Context, tx store.Querier, reader, fileID int64) ([]byte, error) {
	b := named.New()
	b.Set("file", fileID)
	b.Set("reader", reader)
	q, args, err := b.Compile(`
		SELECT bd.data
		FROM file f
		JOIN file_chunk fc ON fc.file_id = f.id
		JOIN cas_blob_data bd ON bd.address = fc.cas_address
		WHERE f.id = :file
		  AND (:reader::bigint = 0
		       OR f.created_by = :reader::bigint
		       OR EXISTS (SELECT 1 FROM attachment a
		                  WHERE a.file_id = f.id AND a.deleted_at IS NULL
		                    AND card_visible_to(:reader::bigint, a.card_id)))
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
		return parsedCSV{}, fmt.Errorf("csv is empty")
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
		return nil, nil, fmt.Errorf("csv is empty")
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
