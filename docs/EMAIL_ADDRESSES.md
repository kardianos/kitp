# A person's email addresses

A person with a login can have several email addresses. One is the
**primary**: the person card's `email`, which is what kitp uses for them.
That covers mail sent to them, digests and notifications, thread recipients,
and the address shown in kitp. Their other addresses are kept in the
`person_email` table, each with where it came from and whether it is
verified.

## Where addresses come from

- **A sign-in.** Each OIDC sign-in whose email kitp trusts
  (`KITP_OIDC_TRUST_UNVERIFIED_EMAIL`, README) adds that email, verified
  (`source = signin`; `person_email_note_signin`). When the identity
  provider renames someone, their next sign-in brings the new address.
  Migration 0041 adds the email each signed-in login held.
- **The person.** On Account → Email addresses they add an address, and
  kitp mails it a code (`person_email.add`). The code is 10 symbols,
  XXXXX-XXXXX, and works for 24 hours. Entering it verifies the address
  (`person_email.verify`). Adding a pending address again sends a new
  code. A person has at most 20 addresses and gets at most 5 codes an hour.
  An agent can't add addresses; its owner adds their own.

A verified address belongs to one person: adding or verifying one that is
verified on someone else is refused (`in_use`), and a sign-in doesn't take
it either.

## The primary

- The person chooses it among their verified addresses
  (`person_email.set_primary`).
- A sign-in with a new email moves the primary to it only when the primary
  was the login's previous email (or empty). After a rename the person keeps
  getting mail at the address the identity provider now uses, unless they
  chose another address themselves, which stays.
- The primary can't be removed while it is the primary; choose another first.
- `attribute.update` doesn't write a user's `email`: it is theirs to choose.
  A contact's email (a person without a login) stays ordinary card data.

## Mail from any verified address

Incoming mail is matched to a person by any of their verified addresses, the
primary first (`comm.upsertPersonByEmail`, `person.upsert_by_email`). Mail
from someone's old or second address files as them instead of making a new
contact. An address still waiting for its code matches nobody.

## The mail account that sends codes

kitp has no workspace-wide outgoing mail. All mail goes out through a mail
account (a `comm_channel`) of some project. An admin chooses the one for
account emails in People ("Account emails from"; `account_mail.set`), from
the mail accounts with an outgoing server and a From address. Until one is
chosen, adding an address isn't offered.

The code mail is marked as a notification (its Message-ID and
`X-Kitp-Notification: verify`), so a reply to it is dropped rather than
filed. Each code sent or failed is in that account's Comm log (`notify_ok`,
`notify_fail`). With `KITP_COMM_SMTP_DRY_RUN=1` nothing is sent.

## Who sees and changes what

| | The person | A workspace admin | Anyone else |
| --- | --- | --- | --- |
| See the list | yes (Account page) | yes (People → Addresses) | no |
| Add / verify | yes | no | no |
| Choose the primary | yes | no | no |
| Remove one (not the primary) | yes | yes | no |
| Choose the account-mail account | no | yes | no |

## What stays on the login

`user_account.email` is still the identity provider's address. Admin
recovery (`KITP_INIT_ADMIN_EMAIL`), attaching a first sign-in to an account
an admin set up, and blocking a revoked login's email all match on it. An
address a person adds never feeds those.
