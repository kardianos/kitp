// File projectexport/xlsx.go: single-sheet Excel export.
//
// Same data shape as handleSimpleCSV (one task per row, same column
// set, same `tree` filter wiring) but emitted as an .xlsx workbook
// through `github.com/xuri/excelize/v2`. Power users who pipe the
// export into Excel / Sheets get native formatting (frozen header,
// numeric column types) instead of the lossy CSV round-trip.
package projectexport

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"

	"github.com/kitp/kitp/server/internal/api"
	"github.com/kitp/kitp/server/internal/auth"
)

// handleSimpleXLSX is the .xlsx mirror of handleSimpleCSV. Same authz,
// same row-loading helpers, same Content-Disposition contract — only
// the encoder changes.
func handleSimpleXLSX(ctx context.Context, w http.ResponseWriter, r *http.Request, cfg Config, user *auth.UserCtx) error {
	idStr := r.PathValue("id")
	projectID, perr := strconv.ParseInt(idStr, 10, 64)
	if perr != nil || projectID <= 0 {
		return httpError(http.StatusBadRequest, "invalid project id")
	}
	includeDeleted := r.URL.Query().Get("include_deleted") == "1"
	tree, terr := parseTreeParam(r.URL.Query().Get("tree"))
	if terr != nil {
		return terr
	}
	var err error

	projectTitle, err := loadProjectTitle(ctx, cfg.Pool, projectID)
	if err != nil {
		return err
	}
	authOK, aErr := isAuthorized(ctx, cfg.Pool, user.ID, projectID)
	if aErr != nil {
		return api.Internal(fmt.Errorf("authz: %w", aErr))
	}
	if !authOK {
		return httpError(http.StatusForbidden, "not authorized to export this project")
	}

	tasks, err := loadTaskRows(ctx, cfg.Pool, projectID, includeDeleted, tree)
	if err != nil {
		return err
	}
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

	// Dynamic columns. See handleSimpleCSV for the why; same shape
	// reused so a new attribute_def gets the same column in both
	// exporters automatically.
	attrCols, err := loadTaskAttrCols(ctx, cfg.Pool)
	if err != nil {
		return err
	}
	extraCols := extraExportCols(attrCols)
	extraTitles, err := loadTitleLookup(ctx, cfg.Pool, collectExtraRefIDs(tasks, extraCols))
	if err != nil {
		return err
	}

	f := excelize.NewFile()
	defer func() { _ = f.Close() }()
	const sheet = "Tasks"
	idx, err := f.NewSheet(sheet)
	if err != nil {
		return api.Internal(fmt.Errorf("xlsx new sheet: %w", err))
	}
	f.SetActiveSheet(idx)
	// Remove the default Sheet1 left over from NewFile so the workbook
	// ships with only the "Tasks" sheet.
	_ = f.DeleteSheet("Sheet1")

	header := []string{
		"id", "title", "assignee_email", "assignee_name",
		"milestone", "component", "tags", "description", "sort_order",
		"created_at", "deleted_at", "comments",
	}
	// Lower-bound width per column (in Excel character units) so
	// short-content columns don't collapse to the default narrow
	// "8.43" that crowds the header label. Tuned for the column's
	// expected content kind, not the data — even an empty
	// description column should be wide enough to read.
	minWidths := []float64{
		6,  // id
		32, // title
		24, // assignee_email
		18, // assignee_name
		14, // milestone
		14, // component
		18, // tags
		40, // description
		8,  // sort_order
		20, // created_at (ISO 8601)
		20, // deleted_at
		40, // comments
	}
	// Append dynamic-attribute columns to the header. Their min-width
	// floor is a generic 16 chars — wide enough for most refs (titles
	// average ~12–15 chars) and dates (10 chars).
	for _, c := range extraCols {
		header = append(header, c.Name)
		minWidths = append(minWidths, 16)
	}
	// Upper-bound width so a multi-paragraph description / comment
	// doesn't blow the column past readability. Word-wrap (enabled
	// below for those columns) handles the overflow.
	const maxWidth = 80.0

	for col, label := range header {
		cell, _ := excelize.CoordinatesToCellName(col+1, 1)
		_ = f.SetCellValue(sheet, cell, label)
	}
	// Bold + filter the header row.
	if headStyle, err := f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
	}); err == nil {
		lastCol, _ := excelize.ColumnNumberToName(len(header))
		_ = f.SetCellStyle(sheet, "A1", lastCol+"1", headStyle)
		_ = f.AutoFilter(sheet, "A1:"+lastCol+"1", []excelize.AutoFilterOptions{})
	}
	// Freeze the header row so scrolling a long export keeps the
	// column labels visible.
	_ = f.SetPanes(sheet, &excelize.Panes{
		Freeze:      true,
		YSplit:      1,
		TopLeftCell: "A2",
		ActivePane:  "bottomLeft",
	})

	// Track the widest visible character count per column (longest
	// line in a multi-line cell, not the total string length — Excel
	// wraps long text so column width should match line width, not
	// total length).
	widths := make([]float64, len(header))
	for i, h := range header {
		widths[i] = float64(utf8.RuneCountInString(h))
	}

	for i, t := range tasks {
		row := i + 2 // 1-indexed; row 1 is the header
		vals := []any{
			t.ID,
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
			vals = append(vals, renderExtraCell(c, t.Attrs[c.Name], extraTitles))
		}
		for col, v := range vals {
			cell, _ := excelize.CoordinatesToCellName(col+1, row)
			if err := f.SetCellValue(sheet, cell, v); err != nil {
				return api.Internal(fmt.Errorf("xlsx set cell (%d, %d): %w", col+1, row, err))
			}
			// Update the running width estimate. Render the value as
			// the same string Excel would display so the width matches
			// what the user sees.
			str := stringForWidth(v)
			for _, line := range strings.Split(str, "\n") {
				if w := float64(utf8.RuneCountInString(line)); w > widths[col] {
					widths[col] = w
				}
			}
		}
	}

	// Wrap text on description + comments so long-text columns clamp
	// at the max width and continue vertically rather than expanding
	// the column off-screen. Column 8 is description, 12 is comments.
	if wrapStyle, err := f.NewStyle(&excelize.Style{
		Alignment: &excelize.Alignment{WrapText: true, Vertical: "top"},
	}); err == nil {
		_ = f.SetColStyle(sheet, "H", wrapStyle)
		_ = f.SetColStyle(sheet, "L", wrapStyle)
	}

	// Apply the computed widths with a small buffer and per-column
	// floors / cap. Excel's character-unit widths aren't an exact
	// pixel measure, but +2 covers the inner padding on most fonts.
	for i := range header {
		w := widths[i] + 2
		if i < len(minWidths) && w < minWidths[i] {
			w = minWidths[i]
		}
		if w > maxWidth {
			w = maxWidth
		}
		colLetter, _ := excelize.ColumnNumberToName(i + 1)
		_ = f.SetColWidth(sheet, colLetter, colLetter, w)
	}

	filename := fmt.Sprintf("project-%s-%d.xlsx", slugify(projectTitle), projectID)
	w.Header().Set("Content-Type",
		"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf(`attachment; filename="%s"`, filename))
	if err := f.Write(w); err != nil {
		return api.Internal(fmt.Errorf("xlsx write: %w", err))
	}
	return nil
}

// stringForWidth renders [v] the way Excel will display it so the
// column-width estimator measures real on-screen length. Booleans,
// times, and integers / floats all reach SetCellValue as their typed
// forms; we mirror the formatter Excel uses for the default cell
// format ("General") here.
func stringForWidth(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case int64:
		return strconv.FormatInt(t, 10)
	case bool:
		return strconv.FormatBool(t)
	default:
		return fmt.Sprint(v)
	}
}
