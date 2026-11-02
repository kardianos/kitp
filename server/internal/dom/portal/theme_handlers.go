package portal

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/kitp/kitp/server/internal/cas"
	"github.com/kitp/kitp/server/internal/reg"
	"github.com/kitp/kitp/server/internal/store"
)

// ThemeSetInput creates (no id) or updates a theme. Pointer fields: absent
// = leave unchanged.
type ThemeSetInput struct {
	ID     int64   `json:"id,string,omitempty" mcp:"desc=theme card id to update; omit to create a theme"`
	Title  *string `json:"title,omitempty" mcp:"desc=theme name (required when creating)"`
	Base   *string `json:"base,omitempty" mcp:"desc=built-in theme it starts from (theme.bases), e.g. 'sidebar' or 'newspaper' (required when creating)"`
	Nav    *string `json:"nav,omitempty" mcp:"desc=navigation mode: full, section, collapsible; '' = the base theme's"`
	Accent *string `json:"accent,omitempty" mcp:"desc=accent colour as #rrggbb; '' = the base theme's"`
	Footer *string `json:"footer,omitempty" mcp:"desc=markdown shown at the foot of every page; '' = none"`
}

// ThemeSetOutput reports the theme and what the call did.
type ThemeSetOutput struct {
	ID      int64 `json:"id,string" mcp:"desc=theme card id"`
	Created bool  `json:"created" mcp:"desc=true when this call created the theme"`
	Changed bool  `json:"changed" mcp:"desc=true when anything was written"`
}

// ThemeListInput takes no arguments.
type ThemeListInput struct{}

// ThemeFileInfo is one of a theme card's own files.
type ThemeFileInfo struct {
	Path      string `json:"path" mcp:"desc=file path within the theme, e.g. 'page.html', 'custom.css', 'logo.png'"`
	MimeType  string `json:"mime_type" mcp:"desc=type the file is served as"`
	SizeBytes int64  `json:"size_bytes" mcp:"desc=size in bytes"`
	UpdatedAt string `json:"updated_at" mcp:"desc=RFC3339 time it was last saved"`
}

// ThemeRow is one theme.
type ThemeRow struct {
	ID       int64           `json:"id,string" mcp:"desc=theme card id"`
	Title    string          `json:"title" mcp:"desc=theme name"`
	Base     string          `json:"base" mcp:"desc=built-in theme it starts from"`
	BaseName string          `json:"base_name" mcp:"desc=the base theme's display name ('Newspaper')"`
	Nav      string          `json:"nav" mcp:"desc=navigation mode; '' = the base theme's"`
	Accent   string          `json:"accent" mcp:"desc=accent colour; '' = the base theme's"`
	Footer   string          `json:"footer" mcp:"desc=footer markdown"`
	Files    []ThemeFileInfo `json:"files" mcp:"desc=files the theme adds to or overrides in its base"`
	Portals  []string        `json:"portals" mcp:"desc=titles of the portals using the theme"`
}

// ThemeListOutput wraps the rows.
type ThemeListOutput struct {
	Rows []ThemeRow `json:"rows" mcp:"desc=live themes, by title"`
}

// ThemeBasesInput takes no arguments.
type ThemeBasesInput struct{}

// ThemeBaseFile is one file of a built-in theme.
type ThemeBaseFile struct {
	Path      string `json:"path" mcp:"desc=file path, e.g. 'page.html'"`
	MimeType  string `json:"mime_type" mcp:"desc=type the file is served as"`
	SizeBytes int64  `json:"size_bytes" mcp:"desc=size in bytes"`
	IsText    bool   `json:"is_text" mcp:"desc=a text file (template, stylesheet, JSON)"`
}

// ThemeBase is a built-in theme.
type ThemeBase struct {
	Key         string          `json:"key" mcp:"desc=key a theme card names as its base"`
	Name        string          `json:"name" mcp:"desc=display name"`
	Description string          `json:"description" mcp:"desc=what it looks like"`
	Nav         string          `json:"nav" mcp:"desc=default navigation mode"`
	Paginate    int             `json:"paginate" mcp:"desc=child pages listed per page; 0 = all"`
	Order       string          `json:"order" mcp:"desc=order child pages are listed in: site or newest"`
	Files       []ThemeBaseFile `json:"files" mcp:"desc=its files, read-only (theme.base_file)"`
}

// ThemeBasesOutput wraps the built-in themes.
type ThemeBasesOutput struct {
	Rows []ThemeBase `json:"rows" mcp:"desc=built-in themes, in display order"`
}

// ThemeBaseFileInput names a built-in theme's file.
type ThemeBaseFileInput struct {
	Key  string `json:"key" mcp:"required,desc=built-in theme key"`
	Path string `json:"path" mcp:"required,desc=file path"`
}

// ThemeFileContent is a file's content: Text for text files, else
// ContentBase64.
type ThemeFileContent struct {
	Path          string `json:"path" mcp:"desc=file path"`
	MimeType      string `json:"mime_type" mcp:"desc=type the file is served as"`
	SizeBytes     int64  `json:"size_bytes" mcp:"desc=size in bytes"`
	IsText        bool   `json:"is_text" mcp:"desc=true: Text holds the content; false: ContentBase64 does"`
	Text          string `json:"text,omitempty" mcp:"desc=the content of a text file"`
	ContentBase64 string `json:"content_base64,omitempty" mcp:"desc=the content of a binary file, base64"`
	CASAddress    string `json:"cas_address,omitempty" mcp:"desc=internal; always empty on the wire"`
}

// ThemeFileGetInput names one of a theme card's own files.
type ThemeFileGetInput struct {
	ThemeID int64  `json:"theme_id,string" mcp:"required,desc=theme card id"`
	Path    string `json:"path" mcp:"required,desc=file path"`
}

// ThemeFilePutInput adds or replaces one of a theme's files. Give Text for
// a text file or ContentBase64 for any file.
type ThemeFilePutInput struct {
	ThemeID       int64   `json:"theme_id,string" mcp:"required,desc=theme card id"`
	Path          string  `json:"path" mcp:"required,desc=file path within the theme: lower-case letters, digits, '-', '_', '.', '/' (e.g. 'custom.css', 'page.html', 'logo.png', 'fonts/inter.woff2')"`
	Text          *string `json:"text,omitempty" mcp:"desc=the content of a text file"`
	ContentBase64 *string `json:"content_base64,omitempty" mcp:"desc=the content, base64 (any file)"`
}

// ThemeFilePutOutput reports the write.
type ThemeFilePutOutput struct {
	ThemeID   int64  `json:"theme_id,string" mcp:"desc=theme card id"`
	Path      string `json:"path" mcp:"desc=file path"`
	SizeBytes int64  `json:"size_bytes" mcp:"desc=size in bytes"`
	Changed   bool   `json:"changed" mcp:"desc=false when the file already held these bytes"`
}

// ThemeFileDeleteInput names one of a theme's files.
type ThemeFileDeleteInput struct {
	ThemeID int64  `json:"theme_id,string" mcp:"required,desc=theme card id"`
	Path    string `json:"path" mcp:"required,desc=file path"`
}

// ThemeFileDeleteOutput reports the delete.
type ThemeFileDeleteOutput struct {
	Deleted bool `json:"deleted" mcp:"desc=false when the theme had no such file"`
}

// registerThemes installs theme.bases / theme.base_file / theme.list /
// theme.set / theme.file_get / theme.file_put / theme.file_delete. All are
// admin only: a theme decides what every portal using it looks like.
func registerThemes(storage *cas.Storage) {
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "bases",
		Doc:          "List the built-in themes (Side menu, Top menu, Newspaper, …) with their files. A theme card starts from one of them. Admin only.",
		InputType:    reflect.TypeFor[ThemeBasesInput](),
		OutputType:   reflect.TypeFor[ThemeBasesOutput](),
		AllowedRoles: []string{"admin"},
		// Reads the themes compiled into the server; no database.
		Run: runThemeBases,
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "base_file",
		Doc:          "Read one file of a built-in theme (read-only), e.g. to start a theme's own page.html or custom.css from it. Admin only.",
		InputType:    reflect.TypeFor[ThemeBaseFileInput](),
		OutputType:   reflect.TypeFor[ThemeFileContent](),
		AllowedRoles: []string{"admin"},
		// Reads the themes compiled into the server; no database.
		Run: runThemeBaseFile,
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "list",
		Doc:          "List the themes: settings, the files each adds to or overrides in its base, and the portals using it. Admin only.",
		InputType:    reflect.TypeFor[ThemeListInput](),
		OutputType:   reflect.TypeFor[ThemeListOutput](),
		AllowedRoles: []string{"admin"},
		IsRead:       true,
		SQLFunc:      "theme_list_batch",
		PostRun:      postRunThemeList,
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "set",
		Doc:          "Create or update a theme: its name, built-in base theme, navigation mode (full, section, collapsible), accent colour and footer. Rebuilds the portals using it. Admin only.",
		InputType:    reflect.TypeFor[ThemeSetInput](),
		OutputType:   reflect.TypeFor[ThemeSetOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "theme_set_batch",
		PreRun:       preRunThemeSet,
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "file_get",
		Doc:          "Read one of a theme's own files. Admin only.",
		InputType:    reflect.TypeFor[ThemeFileGetInput](),
		OutputType:   reflect.TypeFor[ThemeFileContent](),
		AllowedRoles: []string{"admin"},
		IsRead:       true,
		SQLFunc:      "theme_file_get_batch",
		PostRun:      postRunThemeFileGet(storage),
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "file_put",
		Doc:          "Add or replace one of a theme's files: a template (page.html, or a file of {{define}} blocks), custom.css, theme.json, logo.* / favicon.*, a font or an image. A template is checked by rendering a sample site with it. Rebuilds the portals using the theme. Admin only.",
		InputType:    reflect.TypeFor[ThemeFilePutInput](),
		OutputType:   reflect.TypeFor[ThemeFilePutOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "theme_file_put_batch",
		PreRun:       preRunThemeFilePut(storage),
	})
	reg.Register(reg.Handler{
		Endpoint:     "theme",
		Action:       "file_delete",
		Doc:          "Remove one of a theme's files, so its base theme's file of that name (if any) applies again. Rebuilds the portals using the theme. Admin only.",
		InputType:    reflect.TypeFor[ThemeFileDeleteInput](),
		OutputType:   reflect.TypeFor[ThemeFileDeleteOutput](),
		AllowedRoles: []string{"admin"},
		SQLFunc:      "theme_file_delete_batch",
		PreRun:       preRunThemeFileDelete(storage),
	})
}

func runThemeBases(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
	var rows []ThemeBase
	for _, b := range BaseThemes() {
		row := ThemeBase{Key: b.Key, Name: b.Name, Description: b.Description, Nav: b.Nav, Paginate: b.Paginate, Order: b.Order}
		for _, p := range b.FilePaths() {
			row.Files = append(row.Files, ThemeBaseFile{
				Path: p, MimeType: mimeFor(p), SizeBytes: int64(len(b.Files[p])), IsText: IsTextThemeFile(p),
			})
		}
		rows = append(rows, row)
	}
	outs := make([]any, len(ins))
	for i := range ins {
		outs[i] = ThemeBasesOutput{Rows: rows}
	}
	return outs, nil
}

func runThemeBaseFile(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
	outs := make([]any, len(ins))
	for i, raw := range ins {
		in := raw.(ThemeBaseFileInput)
		b := LookupBaseTheme(in.Key)
		if b == nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "theme_not_found",
				Message: fmt.Sprintf("theme.base_file: there's no built-in theme %q", in.Key)}
		}
		data, ok := b.Files[in.Path]
		if !ok {
			return nil, &reg.HandlerError{InputIndex: i, Code: "file_not_found",
				Message: fmt.Sprintf("theme.base_file: the %s theme has no file %q", b.Name, in.Path)}
		}
		outs[i] = fileContent(in.Path, mimeFor(in.Path), data)
	}
	return outs, nil
}

// fileContent is a file's content as text (a text file in UTF-8) or base64.
func fileContent(p, mimeType string, data []byte) ThemeFileContent {
	out := ThemeFileContent{Path: p, MimeType: mimeType, SizeBytes: int64(len(data))}
	if IsTextThemeFile(p) && utf8.Valid(data) {
		out.IsText = true
		out.Text = string(data)
	} else {
		out.ContentBase64 = base64.StdEncoding.EncodeToString(data)
	}
	return out
}

// postRunThemeList names each theme's base (the names live with the
// built-in themes, not in the database).
func postRunThemeList(_ context.Context, _ store.Querier, _ []any, outs []any) error {
	for i := range outs {
		out, ok := outs[i].(ThemeListOutput)
		if !ok {
			continue
		}
		for j := range out.Rows {
			if b := LookupBaseTheme(out.Rows[j].Base); b != nil {
				out.Rows[j].BaseName = b.Name
			} else {
				out.Rows[j].BaseName = out.Rows[j].Base
			}
		}
		outs[i] = out
	}
	return nil
}

// preRunThemeSet checks a base theme key against the built-in themes.
func preRunThemeSet(_ context.Context, _ store.Querier, ins []any) ([]any, error) {
	for i, raw := range ins {
		in := raw.(ThemeSetInput)
		if in.Base != nil && strings.TrimSpace(*in.Base) != "" && LookupBaseTheme(strings.TrimSpace(*in.Base)) == nil {
			return nil, &reg.HandlerError{InputIndex: i, Code: "bad_base",
				Message: fmt.Sprintf("theme.set: %q isn't a built-in theme (see theme.bases)", *in.Base)}
		}
	}
	return ins, nil
}

// postRunThemeFileGet reads the bytes of each file theme_file_get_batch
// found and returns them as text or base64.
func postRunThemeFileGet(storage *cas.Storage) func(context.Context, store.Querier, []any, []any) error {
	return func(ctx context.Context, _ store.Querier, _ []any, outs []any) error {
		for i := range outs {
			out, ok := outs[i].(ThemeFileContent)
			if !ok || out.CASAddress == "" {
				continue
			}
			data, err := readBlob(ctx, storage, out.CASAddress)
			if err != nil {
				return fmt.Errorf("theme.file_get %s: %w", out.Path, err)
			}
			c := fileContent(out.Path, out.MimeType, data)
			outs[i] = c
		}
		return nil
	}
}

func readBlob(ctx context.Context, storage *cas.Storage, addr string) ([]byte, error) {
	if storage == nil {
		return nil, errors.New("no file storage configured")
	}
	var buf strings.Builder
	if err := storage.GetAll(ctx, []string{addr}, &buf); err != nil {
		return nil, err
	}
	return []byte(buf.String()), nil
}

// themeFilePutSQL is what theme_file_put_batch receives.
type themeFilePutSQL struct {
	ThemeID    string `json:"theme_id"`
	Path       string `json:"path"`
	CASAddress string `json:"cas_address"`
	MimeType   string `json:"mime_type"`
	SizeBytes  int64  `json:"size_bytes"`
}

// preRunThemeFilePut checks the path and size, checks a template /
// theme.json by resolving the theme with it and rendering a sample site,
// and stores the bytes in CAS.
func preRunThemeFilePut(storage *cas.Storage) func(context.Context, store.Querier, []any) ([]any, error) {
	return func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
		out := make([]any, len(ins))
		for i, raw := range ins {
			in := raw.(ThemeFilePutInput)
			fail := func(code, format string, a ...any) error {
				return &reg.HandlerError{InputIndex: i, Code: code, Message: "theme.file_put: " + fmt.Sprintf(format, a...)}
			}
			if msg := ThemePathError(in.Path); msg != "" {
				return nil, fail("bad_path", "%q: %s", in.Path, msg)
			}
			var data []byte
			switch {
			case in.Text != nil:
				data = []byte(*in.Text)
			case in.ContentBase64 != nil:
				d, err := base64.StdEncoding.DecodeString(*in.ContentBase64)
				if err != nil {
					return nil, fail("validation", "content_base64 isn't valid base64")
				}
				data = d
			default:
				return nil, fail("validation", "give the file's text or content_base64")
			}
			if len(data) > MaxThemeFileBytes {
				return nil, fail("too_large", "%s is %d KB; a theme file can be at most %d MB", in.Path, len(data)>>10, MaxThemeFileBytes>>20)
			}
			if needsData(in.Path) && !utf8.Valid(data) {
				return nil, fail("validation", "%s isn't UTF-8 text", in.Path)
			}
			if in.Path == "theme.json" || strings.HasSuffix(in.Path, ".html") {
				if err := checkThemeWith(ctx, tx, storage, in.ThemeID, in.Path, data); err != nil {
					return nil, fail("template_error", "%s", err.Error())
				}
			}
			if storage == nil {
				return nil, errors.New("theme.file_put: no file storage configured")
			}
			addr, err := storage.Put(ctx, mimeFor(in.Path), data)
			if err != nil {
				return nil, fmt.Errorf("theme.file_put: store %s: %w", in.Path, err)
			}
			out[i] = themeFilePutSQL{
				ThemeID: strconv.FormatInt(in.ThemeID, 10), Path: in.Path,
				CASAddress: addr, MimeType: mimeFor(in.Path), SizeBytes: int64(len(data)),
			}
		}
		return out, nil
	}
}

// preRunThemeFileDelete checks the theme still renders without the file
// (a page.html override can lean on a template file of its own).
func preRunThemeFileDelete(storage *cas.Storage) func(context.Context, store.Querier, []any) ([]any, error) {
	return func(ctx context.Context, tx store.Querier, ins []any) ([]any, error) {
		for i, raw := range ins {
			in := raw.(ThemeFileDeleteInput)
			if in.Path != "theme.json" && !strings.HasSuffix(in.Path, ".html") {
				continue
			}
			if err := checkThemeWith(ctx, tx, storage, in.ThemeID, in.Path, nil); err != nil {
				return nil, &reg.HandlerError{InputIndex: i, Code: "template_error",
					Message: "theme.file_delete: without " + in.Path + ", " + err.Error()}
			}
		}
		return ins, nil
	}
}

// checkThemeWith resolves theme card themeID with file p replaced by data
// (nil = removed) and renders a sample site with it. A missing theme card
// is left for the SQL function to report.
func checkThemeWith(ctx context.Context, tx store.Querier, storage *cas.Storage, themeID int64, p string, data []byte) error {
	set, own, found, err := loadThemeCard(ctx, tx, storage, themeID)
	if err != nil {
		return fmt.Errorf("reading the theme: %w", err)
	}
	if !found {
		return nil
	}
	var files []ThemeFile
	for _, f := range own {
		if f.Path != p {
			files = append(files, f)
		}
	}
	if data != nil {
		files = append(files, ThemeFile{Path: p, MIME: mimeFor(p), Data: data})
	}
	t, err := ResolveTheme(set, files)
	if err != nil && t == nil {
		return err
	}
	if _, err := Render(sampleSite(t)); err != nil {
		return err
	}
	return nil
}

// sampleSite is a small site exercising every part of the template data:
// nested sections, a hidden page, a list long enough to be paged, dates,
// headings, images and the toc placeholder.
func sampleSite(t *Theme) Site {
	day := time.Date(2026, 1, 15, 9, 0, 0, 0, time.UTC)
	pages := []Page{
		{ID: 1, Title: "Home", Body: "Welcome to the **sample** site.\n\n{{< children >}}", PublishedAt: day},
		{ID: 2, ParentID: 1, Title: "Guide", Sort: 1, Body: "{{< toc >}}\n\n## Setup\n\nSet it up.\n\n### Details\n\n![chart](https://example.com/chart.png)\n\nMore.", PublishedAt: day},
		{ID: 3, ParentID: 2, Title: "Install", Sort: 1, Body: "Install it. Back to [the guide](ref:2).", PublishedAt: day},
		{ID: 4, ParentID: 1, Title: "News", Sort: 2, Body: "The latest.", PublishedAt: day, NavHideChildren: true},
		{ID: 5, ParentID: 1, Title: "Hidden", Sort: 3, Body: "Not in the menus.", NavHidden: true, PublishedAt: day},
	}
	for i := range 12 {
		pages = append(pages, Page{
			ID: int64(100 + i), ParentID: 4, Title: fmt.Sprintf("Story %d", i+1), Sort: float64(i),
			Body: "The story so far.", PublishedAt: day.AddDate(0, 0, i),
		})
	}
	return Site{Title: "Sample", RootID: 1, Pages: pages, Theme: t}
}
