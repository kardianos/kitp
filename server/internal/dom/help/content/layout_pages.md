# Pages layout

The **Pages** screen lists the project's pages — the content a project publishes to portals. A page's child pages are its section, so the page tree is the site tree.

Each page has a **title**, a **body** (markdown), a **slug** (its path segment on the site; the title is used when empty) and a sort order. Open a page to edit it and move it through its status flow:

| Status    | Phase    | Typical portals |
| --------- | -------- | --------------- |
| Draft     | triage   | none: **Unpublish** takes the page off every portal |
| In review | active   | QA |
| Published | active   | QA, PROD |
| Archived  | terminal | removed from all |

Which portals a status publishes to is set in **Values → statuses** (*Publishes to*). The page's **Published on** section lists where it is live, whether that copy matches your latest edits, and a preview link.

## Place in site

A page's **Place in site** section shows the pages above it and lets you:

- move it under another page (or to the top of the project) with **Under**;
- put its child pages in order with ↑ and ↓, and add one with **+ Child page**;
- **Hide from navigation**: the page and everything under it stay out of the site's menus and automatic page lists. It is still published, reachable by its address, by links, and by `{{< children >}}` on its parent.
- **Hide child pages from navigation**: the page stays in the menus, its child pages don't (a changelog without its hundred entries).

Like any edit, these reach a site when the page is published again.

## Pictures

Attach a picture to a page and use it in the body (`![Chart](/api/v1/attachment/12/view)`): it is published with the page. A picture attached to anything other than a page on that portal isn't published, and the build lists a warning.

## Links to other pages

Select the text and choose **Link**. Paste a URL, or type a few words of a page's title (or its parent's, or its number) and pick it from the list. Pages whose own title matches come first, and if many match, keep typing to narrow the list. The link becomes `ref:` plus the page's number, which keeps working when the page is renamed or moved. You can also type a `ref:` link yourself:

| Link target | Points at |
| ----------- | --------- |
| `ref:guide/install` | the page at that path |
| `ref:42` | page #42 |
| `ref:` | the home page |
| `ref:guide#setup` | a heading on another page |

A link to a page that isn't on that portal yet becomes `#`, and the portal's build lists a warning. Inside kitp these links don't go anywhere; they work on the published site.

## Placeholders

Page bodies can use placeholders, expanded when a portal is built. While editing a page, choose **Insert** in the editor's toolbar to add one on a line of its own:

| Placeholder | Becomes |
| ----------- | ------- |
| `{{< children >}}` | a list of this page's child pages |
| `{{< nav >}}` | the whole site tree |
| `{{< toc >}}` | this page's headings |

Put a placeholder in backticks (as code) to show it as written instead.

A box under the page body lists placeholder mistakes as you type: a misspelt name (`{{< chidren >}}`), braces written another way (`{{ children }}`), or the old `{{< ref >}}`. A published site shows a mistaken placeholder as typed, so fix these before publishing.
