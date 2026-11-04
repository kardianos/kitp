// Package csvsafe keeps spreadsheet formulas out of the CSV files kitp
// writes (review 2026-11-03 #29). A cell that starts with = + - @ or a tab /
// carriage return — a task titled `=HYPERLINK(…)`, an inbound mail's
// subject — runs as a formula when someone opens the file in a spreadsheet;
// Cell prefixes it with an apostrophe so it opens as text. Uncell undoes
// that on the way back in (project import), so an export re-imports as it
// was. A plain number ("-5", "12.5") is left alone.
package csvsafe

import "regexp"

var plainNumber = regexp.MustCompile(`^-?\d+(\.\d+)?$`)

func risky(s string) bool {
	if s == "" {
		return false
	}
	switch s[0] {
	case '=', '+', '-', '@', '\t', '\r':
		return !plainNumber.MatchString(s)
	}
	return false
}

// Cell is s as a CSV cell a spreadsheet won't run.
func Cell(s string) string {
	if risky(s) {
		return "'" + s
	}
	return s
}

// Row applies Cell to every cell (in place) and returns the row.
func Row(row []string) []string {
	for i, c := range row {
		row[i] = Cell(c)
	}
	return row
}

// Uncell undoes Cell: an apostrophe in front of what Cell would have
// guarded is dropped.
func Uncell(s string) string {
	if len(s) > 1 && s[0] == '\'' && risky(s[1:]) {
		return s[1:]
	}
	return s
}
