# Email Communication

## Blocked by

FLOW and screen kernel

## Description.

It should be possible to specify email inboxes to query for new mail (IMAP) and use to send outgoing email.

This is a per project configuration. You can specify the intake values assigned to new messages (status, etc). Default to triage state.

Subject -> Title
Body -> Description
Attachments -> Attachments

Need to decode mime types such as html or text. If HTML, try to convert to markdown.

Need a dedicated screen to handle issues with message communication attached to them. There are two types of comments: internal and reply comments. Status updates are picked up and communicated to the communication.

Email is one form of communication and can be bi-directional.
There could be others, and be intake only, or updates only.

Updates should be batched, so if a comment is made and other changes are made, so long as they are done within 5 minutes of each other, they will be updated in a single communication. That wait time should be configurable.

So there could be a Comms screen (similar to inbox style, but with filters set to has comms), that allows editing the comms header, replying to user.

Actually, all comms should be explicit for now. So comms (replying and sending a reply) happens on the comms screen with explicit actions to send communication back. Other screens just leave internal comments. But the objects themselves (tasks) are common for all things. Other screens can attach a comm record to a task, then have it appear on the comm screen, then reply from the comm screen. That should keep concerns separate. A comm may have a separate status, as a closed issue will show up on the comms screen, and then when the comms has been resolved, you can close the comm down.

Replies can thread with a short ID in the body/subject/header, look for them, first one wins to associate reply.
Short, ID as in xInfdU385 type short, but still unique enough and random so not be predictable.
