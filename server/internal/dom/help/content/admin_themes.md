# Themes

A **theme** decides what a portal's site looks like. Portals pick one in **Admin → Portals**; a portal without one uses **Side menu**. One theme can serve several portals, so QA and PROD look the same.

## Built-in themes

Every theme starts from a built-in one:

| Theme | Looks like |
| ----- | ---------- |
| Side menu | Documentation: the page tree down the left, previous / next at the foot. |
| Top menu | A menu bar with a drop-down per top-level page; section pages list what's in them. |
| Newspaper | A masthead and section bar. Pages with child pages are front pages: a lead story, the rest in columns, newest first, nine to a page. Story text flows in columns. |
| Book | One reading column, a numbered table of contents, previous / next chapter links. |
| Help center | A banner and a card per section on the home page; inside a section, its articles down the side. |
| Blog | Posts newest first with dates and opening lines, five to a page. |
| Reference | Three columns: collapsible navigation, the page, and "On this page". |

## Settings

| Setting | Meaning |
| ------- | ------- |
| Starts from | The built-in theme. Switching it keeps your own files. |
| Navigation | *Whole tree* (every branch open), *Top level, opened along the current page*, or *Whole tree, closed except along the current page* (readers open the rest). Blank uses the theme's own. |
| Accent colour | Links and highlights, as `#rrggbb`. Blank keeps the theme's colour. |
| Footer | Markdown shown at the foot of every page. |

## Files

The **Files** list shows the built-in theme's files (read-only) and your own:

- **View** a built-in file, or **Customize** it: a copy becomes yours and opens for editing. Save it, and it replaces the built-in one; **Revert** drops your copy.
- **Upload logo…** / **Upload favicon…** add `logo.png` (or .svg, .webp, .jpg, .gif) and `favicon.png` (or .svg, .ico).
- **New file** starts an empty text file; **Upload file…** adds any image or font.
- `custom.css` is loaded after the theme's stylesheet: the easiest way to change a few things. The accent colour is set there too, as `--accent`.
- `theme.json` sets `"nav"`, `"paginate"` (child pages per list page; 0 = all) and `"order"` (`"site"` or `"newest"`).

Every change rebuilds the portals using the theme. Scripts aren't allowed: a portal page runs no JavaScript.

## Templates

`page.html` is a Go `html/template` that renders every page, including the 404 page. Other `.html` files join the same template set, so a file of `{{define "footer"}}…{{end}}` blocks can replace a block of `page.html` without copying it. A template is test-rendered when you save it; one that fails is refused with its file and line, and the sites keep their last build.

What a template can use:

| Field | Holds |
| ----- | ----- |
| `.Site.Title`, `.Site.Logo`, `.Site.Icon`, `.Site.Footer` | The portal's name, logo and favicon URLs (empty when none), the footer as HTML. |
| `.Page.Title`, `.Page.IsHome`, `.Page.Kind`, `.Page.Published` | This page. `Kind` is `page`, `notfound` or `empty` (nothing published yet). |
| `.Base`, `.Theme` | The path to the site root, and to the theme's files (`{{.Theme}}site.css`, `{{.Theme}}custom.css`). |
| `.Root` | The home page: `.Title`, `.Href`, `.Current`. |
| `.Content` | The page body as HTML (empty on page 2 and later of a list). |
| `.Crumbs`, `.Parent` | The pages above this one: `.Title`, `.Href`. |
| `.Nav`, `.Section` | Navigation items, and the top-level one this page is under: `.Title`, `.Href`, `.Current`, `.InPath`, `.HasChildren`, `.Open`, `.Collapsible`, `.Children`. |
| `.Children`, `.Pager` | This page's child pages (`.Title`, `.Href`, `.Summary`, `.Image`, `.Published`, `.HasChildren`) and, for a long list, the pager (`.Page`, `.Pages`, `.Prev`, `.Next`, `.Links`). |
| `.Prev`, `.Next` | The neighbouring pages in reading order. |
| `.Headings` | The page's level-2 and level-3 headings: `.Level`, `.ID`, `.Text`. |

The Side menu theme's `page.html` starts with the same list; view it to start a template of your own.
