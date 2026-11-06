package portal

import (
	"context"
	"errors"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Review 2026-11-06 round 8 #7: the text caps count markdown, so a page
// that is small as text but large as what goldmark makes of it (a wide
// table, a {{< toc >}} repeated) froze a portal or took kitpd down.

// tableBomb is a GFM table of cols columns and rows one-word rows: goldmark
// pads each row to the header's width.
func tableBomb(cols, rows int) string {
	return strings.Repeat("|a", cols) + "|\n" + strings.Repeat("|-", cols) + "|\n" + strings.Repeat("a\n", rows)
}

// peakHeap runs f and returns the most heap it held above the start.
func peakHeap(f func()) uint64 {
	runtime.GC()
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	base := ms.HeapAlloc
	var top atomic.Uint64
	done := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		tk := time.NewTicker(2 * time.Millisecond)
		defer tk.Stop()
		for {
			select {
			case <-done:
				return
			case <-tk.C:
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				if m.HeapAlloc > top.Load() {
					top.Store(m.HeapAlloc)
				}
			}
		}
	}()
	f()
	close(done)
	<-stopped
	if top.Load() < base {
		return 0
	}
	return top.Load() - base
}

func onePage(body string) Site {
	return Site{Title: "Docs", RootID: 1, Pages: []Page{
		{ID: 1, Title: "Home", Body: "hi"},
		{ID: 2, ParentID: 1, Title: "Bomb", Slug: "bomb", Body: body},
	}}
}

func pageHTML(res Result, id int64) string {
	for _, f := range res.Files {
		if f.CardID == id {
			return string(f.Data)
		}
	}
	return ""
}

// TestATableTooLargeShowsAsText: a table past the column or cell limits
// isn't made a table (it shows as its text, with a warning), costs little,
// and the build goes through; tables within them are tables.
func TestATableTooLargeShowsAsText(t *testing.T) {
	for _, c := range []struct {
		name       string
		body       string
		wantTable  bool
		maxHeapMiB uint64
	}{
		{"1000 columns, 1000 rows (5 KB)", tableBomb(1000, 1000), false, 64},
		{"2000 columns, 4000 rows (15 KB)", tableBomb(2000, 4000), false, 64},
		{"60 columns, 2000 rows", tableBomb(60, 2000), false, 64},
		{"in a quote", "> " + strings.ReplaceAll(tableBomb(1000, 1000), "\n", "\n> "), false, 64},
		{"10 columns, 100 rows", tableBomb(10, 100), true, 64},
		{"64 columns, 10 rows", tableBomb(64, 10), true, 64},
	} {
		t.Run(c.name, func(t *testing.T) {
			var res Result
			var err error
			peak := peakHeap(func() { res, err = Render(context.Background(), onePage(c.body)) })
			if err != nil {
				t.Fatalf("Render: %v", err)
			}
			html := pageHTML(res, 2)
			if got := strings.Contains(html, "<table>"); got != c.wantTable {
				t.Errorf("a table: %v, want %v", got, c.wantTable)
			}
			warned := strings.Contains(strings.Join(res.Warnings, "\n"), "table too large")
			if warned == c.wantTable {
				t.Errorf("warned %v; warnings %q", warned, res.Warnings)
			}
			if peak>>20 > c.maxHeapMiB {
				t.Errorf("peak heap +%d MiB, want at most %d", peak>>20, c.maxHeapMiB)
			}
		})
	}
}

// TestTablesShareOnePagesCells: the cell limit is for the page, not each
// table.
func TestTablesShareOnePagesCells(t *testing.T) {
	one := tableBomb(50, 600) // 50 × 602 cells or so: under the limit alone
	res, err := Render(context.Background(), onePage(one+"\n\n"+one))
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(pageHTML(res, 2), "<table>"); n != 1 {
		t.Errorf("%d tables made, want 1 (the second passes the page's cells)", n)
	}
}

// TestRepeatedTOCIsCapped: every {{< toc >}} is the page's whole list of
// headings; a page of many of both is published without its text instead
// of being built to gigabytes.
func TestRepeatedTOCIsCapped(t *testing.T) {
	body := strings.Repeat("## h\n\n", 20_000) + strings.Repeat("{{< toc >}}\n\n", 20_000)
	var res Result
	var err error
	peak := peakHeap(func() { res, err = Render(context.Background(), onePage(body)) })
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "too large to publish (over 4 MB as HTML)") {
		t.Errorf("warnings %q, want the page named as too large", res.Warnings)
	}
	if strings.Contains(pageHTML(res, 2), `class="toc"`) {
		t.Error("the page kept its text")
	}
	if peak>>20 > 256 {
		t.Errorf("peak heap +%d MiB", peak>>20)
	}
}

// TestTextTooLargeAsHTMLIsLeftOut: a body under the text cap whose HTML
// passes 4 MB ('"' is six bytes out) is published without its text.
func TestTextTooLargeAsHTMLIsLeftOut(t *testing.T) {
	res, err := Render(context.Background(), onePage(strings.Repeat(`"`, 900<<10)))
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), "as HTML); published without its text") {
		t.Errorf("warnings %q", res.Warnings)
	}
	if html := pageHTML(res, 2); html == "" || strings.Contains(html, "&quot;&quot;") {
		t.Errorf("the page: %d bytes, with its text %v", len(html), strings.Contains(html, "&quot;&quot;"))
	}
}

// TestTheSitesTextIsCapped: past the site's budget, pages go out without
// their text.
func TestTheSitesTextIsCapped(t *testing.T) {
	defer func(v int) { maxSiteTextBytes = v }(maxSiteTextBytes)
	maxSiteTextBytes = 100 << 10
	s := Site{Title: "Docs", RootID: 1, Pages: []Page{
		{ID: 1, Title: "Home", Body: "hi"},
		{ID: 2, ParentID: 1, Title: "A", Slug: "a", Sort: 1, Body: strings.Repeat("word ", 12<<10)}, // ~60 KB
		{ID: 3, ParentID: 1, Title: "B", Slug: "b", Sort: 2, Body: strings.Repeat("word ", 12<<10)},
	}}
	res, err := Render(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(pageHTML(res, 2), "word word") || strings.Contains(pageHTML(res, 3), "word word") {
		t.Error("want A with its text and B without")
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), `"B": was published without its text`) {
		t.Errorf("warnings %q", res.Warnings)
	}
}

// TestAPageTooLargeGoesOutWithoutItsText: a page whose own text takes it
// past the page cap is published without it; one too large even then (the
// theme's doing) still fails the build.
func TestAPageTooLargeGoesOutWithoutItsText(t *testing.T) {
	defer func(v int) { maxPageBytes = v }(maxPageBytes)
	maxPageBytes = 64 << 10
	res, err := Render(context.Background(), onePage(strings.Repeat("word ", 30<<10)))
	if err != nil {
		t.Fatalf("Render: %v", err)
	}
	if html := pageHTML(res, 2); html == "" || strings.Contains(html, "word word") {
		t.Errorf("the page: %d bytes, with its text %v", len(html), strings.Contains(html, "word word"))
	}
	if !strings.Contains(strings.Join(res.Warnings, "\n"), `"Bomb" came out larger than`) {
		t.Errorf("warnings %q", res.Warnings)
	}
	maxPageBytes = 100 // the empty page can't fit either
	if _, err := Render(context.Background(), onePage("x")); !errors.Is(err, errTooLarge) {
		t.Errorf("a page too large without its text: %v, want the build to fail", err)
	}
}

// TestRenderStopsWhenItsContextIsDone: the build's deadline stops Render.
func TestRenderStopsWhenItsContextIsDone(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Render(ctx, onePage("x")); !errors.Is(err, context.Canceled) {
		t.Errorf("Render on a done context: %v, want context.Canceled", err)
	}
}
