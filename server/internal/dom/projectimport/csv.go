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
	"fmt"
	"io"

	"github.com/jackc/pgx/v5"
)

// readFileBytes assembles every chunk for fileID into one byte slice.
// CSVs are typically small (kilobytes); we don't try to stream.
//
// The query orders by file_chunk.seq so the reassembled bytes match
// what file.create stored.
func readFileBytes(ctx context.Context, tx pgx.Tx, fileID int64) ([]byte, error) {
	rows, err := tx.Query(ctx, `
		SELECT b.data
		FROM file_chunk fc
		JOIN cas_blob_data b ON b.address = fc.cas_address
		WHERE fc.file_id = $1
		ORDER BY fc.seq
	`, fileID)
	if err != nil {
		return nil, fmt.Errorf("read file: %w", err)
	}
	defer rows.Close()
	var buf bytes.Buffer
	for rows.Next() {
		var chunk []byte
		if err := rows.Scan(&chunk); err != nil {
			return nil, err
		}
		buf.Write(chunk)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if buf.Len() == 0 {
		return nil, fmt.Errorf("file %d is empty (no chunks)", fileID)
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
			out.PreviewRows = append(out.PreviewRows, row)
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
		rows = append(rows, row)
	}
	return header, rows, nil
}
