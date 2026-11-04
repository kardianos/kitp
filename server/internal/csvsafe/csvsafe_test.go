package csvsafe

import "testing"

func TestCellRoundTrip(t *testing.T) {
	for _, c := range []struct{ in, out string }{
		{`=HYPERLINK("http://evil","x")`, `'=HYPERLINK("http://evil","x")`},
		{"+1", "'+1"},
		{"-2+3", "'-2+3"},
		{"@SUM(A1)", "'@SUM(A1)"},
		{"\tx", "'\tx"},
		{"-5", "-5"},
		{"12.5", "12.5"},
		{"plain", "plain"},
		{"", ""},
		{"'already", "'already"},
	} {
		if got := Cell(c.in); got != c.out {
			t.Errorf("Cell(%q) = %q, want %q", c.in, got, c.out)
		}
		if back := Uncell(Cell(c.in)); back != c.in {
			t.Errorf("Uncell(Cell(%q)) = %q", c.in, back)
		}
	}
}
