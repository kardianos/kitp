# Pages layout

The **Pages** screen lists the project's pages — the content a project publishes to portals. A page's child pages are its section, so the page tree is the site tree.

Each page has a **title**, a **body** (markdown), a **slug** (its path segment on the site; the title is used when empty) and a sort order. Open a page to edit it and move it through its status flow:

| Status    | Phase    | Typical portals |
| --------- | -------- | --------------- |
| Draft     | triage   | none |
| In review | active   | QA |
| Published | active   | QA, PROD |
| Archived  | terminal | removed from all |

Which portals a status publishes to is set in **Values → statuses** (*Publishes to*). The page's **Published on** section lists where it is live, whether that copy matches your latest edits, and a preview link.

## Placeholders

Page bodies can use placeholders, expanded when a portal is built:

| Placeholder | Becomes |
| ----------- | ------- |
| `{{< children >}}` | a list of this page's child pages |
| `{{< nav >}}` | the whole site tree |
| `{{< toc >}}` | this page's headings |
| `{{< ref "guide/install" >}}` | the link to another page, by path |
| `{{< ref 42 >}}` | the link to page #42 |

A link to a page that isn't on that portal yet becomes `#`, and the portal's build lists a warning.
