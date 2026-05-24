# People

Every person card in one place: contacts (email-only correspondents), assignees (real members of the team), and users (assignees who can also sign in). Contacts get created automatically when an unknown email shows up in a comm; this screen is where you reclassify them when the time comes.

## The three tiers

Every person card is one of:

| Tier         | `person_kind` | `user_account_person` link | Visible in assignee dropdowns | Can sign in |
| ------------ | ------------- | -------------------------- | ----------------------------- | ----------- |
| **Contact**  | `contact`     | —                          | No                            | No          |
| **Assignee** (member, no login) | `member` | —              | Yes                           | No          |
| **User**     | `member`      | present                    | Yes                           | Yes (OIDC)  |

The hierarchy is `user ⊆ assignee ⊆ contact` — every user is also a valid assignee and a valid contact, every assignee is also a valid contact, but a contact-only card is none of the above for assignment / login purposes.

This screen owns the **contact ↔ assignee** flip and the **user → assignee** unlink. The **assignee → user** promotion lives on **Admin · Users** because creating a login requires an OIDC subject (or invite flow), not a one-click action.

## Tier chips

The top of the page shows four chips: **all / user / assignee / contact**. The count next to each is the live total across the system. Click a chip to narrow the table.

## Actions per row

The action button depends on the row's current tier (containment is `user ⊆ assignee ⊆ contact`, so every action steps the tier by exactly one):

- **Contact → Promote to assignee** — flips `person_kind` to `member`. The card now appears in assignee dropdowns project-wide.
- **Assignee → Demote to contact** — flips `person_kind` back to `contact`. They drop out of assignee dropdowns; existing assignments + history stay intact. Refused for rows that have a login link — unlink first.
- **User → Demote to assignee** — drops the `user_account_person` link. The user_account row itself stays on **Admin · Users** (their sign-in history, role grants, etc. all preserved), but the person card is no longer marked as "logs in as". From there, demoting to contact is another click.

## Why contacts exist at all

The comm flow needs a stable handle for every email address it sees (so future replies from the same address thread correctly), but most of those addresses aren't team members — they're customers, vendors, one-off senders. Contacts give those a card without polluting the assignee picker.

## Related admin pages

- **Users** — anyone with a sign-in. Promoting an assignee to a user happens there.
- **Comm channels** — where contacts get auto-materialised from inbound mail.
