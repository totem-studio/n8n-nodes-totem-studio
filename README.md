# n8n-nodes-totem-studio

Candidate **1.0.0-rc.1** is prepared locally and has not been published. Stable
1.0 acceptance still requires regional canaries and retirement of the old business path.

Connect n8n workflows and AI tools to the [Totem Studio API](https://totemstudio.ai/developers).
The **Totem Studio** action node and **Totem Studio Events** polling trigger use
one reusable **Totem Studio Public API** credential.

## Install

For self-hosted n8n, open **Settings → Community nodes → Install** and enter
`n8n-nodes-totem-studio`. Your n8n administrator must allow community packages.
This package does not claim a verified n8n Cloud catalog listing.

The next public release supports Node.js `>=24.18.0` on your n8n host. Its
artifact is tested on Node 24.18 and Node 26.12.1, including the loader/runtime
components of n8n 2.45.7. The published `0.13.0` archive retains its original
Node 24 engine requirement until that new release is published. Maintainer
builds and repository checks still use the separate Node 24 development policy.

## Connect

1. In Totem Studio, open **Settings → Developers** and create an integration key
   with the workspaces and permissions this workflow needs. Your account needs
   Totem API access.
2. In n8n, create a **Totem Studio Public API** credential and paste the `tsk_live_…`
   key into **API Key**. The connection test calls `GET /v1/me`.
3. Add **Totem Studio**, select your resource and operation, and choose an
   authorized workspace when the operation requires one.

Select that same saved credential on every node that shares the connection.
Updating its key once updates future executions of all nodes referencing its
credential ID. The key is stored in n8n's credential store, never in workflow
parameters or example files. Revoke the integration in Totem to disable it.

## Operations

| Resource | Operations |
| --- | --- |
| Connection | Validate Connection |
| Knowledge | Search |
| Team | Get, Get Many |
| Lead | Find by Phone, Find by Email, Get, Get Many, Get Activities, Create or Resolve, Update, Archive, Get Notes, Add Note, Update Note, Delete Note, Get Custom Values, Update Custom Values |
| Board | Get Many |
| Call | Get, Get Many, Options, Start, Transcript, Recording, Update Analysis (system analyzer only) |
| Conversation | Get, Get Many, Messages |
| Booking | Get, Get Many, Availability, Inspect, For Lead, Create, Cancel, Reschedule, Update Analysis (system analyzer only) |
| Booking Payment | Get, Send Link |
| CRM | Context, Schedule Contact, Handoff |
| Message | Channels, Send, Prepare First Reply, Queue Staff-Configured Information |
| Library | Get Many, Get, Prepared, Send |
| Attachment | Resolve |
| Catalog | Search, Send |
| Member | Get Many |
| Booking Service | Get Many, Options |
| Assistant | Options, Run |
| Quote | Record Outcome |
| Referral | Create |
| Knowledge | Search |
| Notification | Create, Get, Get Many |
| Task | Create, Complete |
| Operation | Get, Cancel |
| Sync | Get Changes |

Phone and email searches retain every match. `found` means at least one match;
`ambiguous` means more than one. `lead` is populated only for exactly one match.
Resolve ambiguity before choosing a record for a later action.

Lists and the changes feed return one page with `data`, `has_more` and
`next_cursor`. Apply a page durably before saving its next cursor; use the same
endpoint and workspace when requesting the next page. A `resync_required`
response means the workflow must start a new synchronization bootstrap.

The node uses the fixed `https://api.totemstudio.ai/v1` endpoint. Totem checks
your integration's current workspace access, permissions and revocation on
every request. The public API's documented data boundaries still apply.

The current v1 candidate adds current-source CRM context, messaging, calendar,
Library and Catalog actions. These additions await their API rollout and package
publication; they are not part of the published `0.13.0` archive.

## CRM writes and notes

Enable the **CRM write** API profile for an integration that needs writes;
existing read connections remain read-only. Lead and note writes require `crm:write`.
Reading note content requires the separate `crm:notes:read` permission and an
explicit note-content grant. Adding or editing a note returns metadata only.
The changes feed includes note content only when that grant is present.

Custom values use separate `crm:custom_values:read` and
`crm:custom_values:write` scopes. Reading their content needs its own explicit
grant. **Get Custom Values** returns the exact named strings and an `etag`;
**Update Custom Values** accepts targeted `set` and `remove` arrays in
**Fields (JSON)**. Supply that custom snapshot's quoted `"lcv_…"` value in
**If-Match**. A lead or note ETag cannot authorize custom-value changes.
Omitted names remain unchanged, an empty string is a stored value, and `remove`
deletes that exact name, including old copies. The receipt contains counts only.

**Knowledge → Search** is in the current v1 candidate, pending publication and
API rollout. It requires the separate `knowledge:read` content grant; existing
keys and CRM/note grants do not gain knowledge access. Enter a question of up
to 1,000 characters and a maximum of 1–8 passages (default 4). The operation
returns `ready` or `indexing` and bounded passage text, title, section, page and
score. An empty `ready` result means no retained match; `indexing` means the
index is still being prepared. Provider IDs, source URLs and private lead
files are excluded; provider deletion discovery is eventual. The request is a
read despite using POST, with no idempotency key. The action node and AI tool
use the same saved API credential and executor.

Task and notification actions require `tasks:write` and `notifications:write`
respectively. Notification creation requires a `note` and optionally accepts
`title`, `lead_id`, `department_id`, `notify` and initial `status`. Totem controls
source identity and recipient routing. These actions return a durable operation
without polling. Use **Operation → Get** to observe its status; **Cancel** can
only stop work before its effect starts. Keep the same idempotency key to
reconcile an unknown outcome. Successful cancellation of already completed work
does not undo it, and accepting a notification does not promise delivery.

Use **Fields (JSON)** for the documented operation fields. For example, **Create
or Resolve** with an authorized workspace can import a contact without starting
outreach:

```json
{"origin":"import","email":"alex@example.com","name":"Alex"}
```

`origin` is required. Use `inbound` only for a real, authorized inbound intake;
Totem applies the integration's inbound permission, consent and intake guards.
`validate_only: true` validates an upsert without applying it. Pipeline fields
are named `board` and `stage`. **Archive** requires a documented `reason` and
retains the lead. Notes use `{"body":"Customer requested a callback"}`;
**Delete Note** removes the selected note and returns `deleted: true`.

**Update**, **Archive**, **Update Note** and **Delete Note** require **If-Match**.
Copy the current response's `etag`, including its quotes. A lead validator looks
like `"lead_Example:7"`; a note validator uses that note's ID and `version`, such
as `"note_Example:2"`. Current-source CRM responses instead use opaque `"lrs1_…"`
lead and `"lns1_…"` note validators. Select **Notes View → Source** for current
note content; source mutation responses contain metadata only. Refresh and review a stale version before making a new
request. A lead ETag cannot authorize a note change.

The node generates an idempotency key per execution item and retains it across
retries of that item and identical request. The result includes `idempotencyKey`.
For a deliberate retry from another execution, set **Idempotency Key** to the
original value and send the identical operation and fields. Keep the original
**If-Match** on that retry. If the result is `outcome_unknown`, automatic repeats
stop: reconcile the resource or contact support with that key before taking
another action. Changing keys can duplicate a write.

## Current-source business actions (v1 candidate)

**Message → Channels** discovers opaque references for currently configured
senders. **Send** targets an authorized retained conversation, or an authorized
lead plus one of those sender references. Raw phone numbers, email addresses,
provider credentials and arbitrary URLs are not message targets. The server
applies each channel's consent and reply-window requirements. Reading message
bodies requires the new explicit `messages:content:read` permission; the older
`messages:read` permission covers metadata.

**Queue Staff-Configured Information** accepts the person's bounded `info`
(maximum 500 characters). Staff configuration chooses the approved WhatsApp
template or email design and the contact's retained recipient. The model cannot
choose a template, sender or destination. A `requested_info_receipt` means
`queued` or `already_queued`, with `delivery_confirmed: false` and the actual configured channel;
it never claims delivery. The existing reminder dispatcher sends the queued
request and applies provider, cap and billing policy.

**Booking → Availability** returns current opaque offers. **Create** accepts one
reviewed offer; **Inspect** returns the current `"bka_…"` management validator for
**Cancel** or **Reschedule**. **Booking Payment → Send Link** requires explicit
confirmed consent. A payment-required result does not confirm a booking or a
payment.

**Library** and **Catalog** use their own content permissions, current opaque
references and reviewed revisions. Delivery actions return a durable operation.
Use **Operation → Get** to inspect its result; accepting an operation does not
mean it was delivered. `outcome_unknown` requires reconciliation with the
original idempotency key before another attempt.

When a Library delivery reports `prepared`, the node reads its persisted parts
with **Library → Prepared** and resolves needed attachments using the same API
credential and execution context. The output includes
`visitorResponse: { version: 1, messages: [...] }`, with the retained order,
identities, timestamps, captions and media metadata. This is prepared visitor
output; no provider delivery is claimed. Attachment access needs its separate
permission. If a required read fails, no partial media response is returned.
Queued operations need an explicit later inspection; the node does not poll in
the background.

For trusted hosted assistants, default write keys follow the original signed
execution and stable node/item/operation slot across n8n execution retries.
Changing the payload for that same intent is refused. Ordinary API-key workflows
keep the execution-item behavior described above. Both use the same public
node, API and reusable credential.

## Lifecycle events (v1 candidate)

Add **Totem Studio Events** and select the same API credential and authorized
workspace. The key needs `events:read`. The trigger emits authorized metadata
for operation completion, calls and booking lifecycle changes. Content such as
message bodies or call transcripts requires its separate API read permission.
Hosted assistant service credentials cannot export this event feed.

**New Events Only** initializes at the current position and is the default;
it does not replay older automations. Choose **Replay Retained Events** only
when intentionally starting from retained history. Later polls resume the
opaque cursor. Each poll reads a bounded number of pages, validates the whole
batch, deduplicates stable event IDs and stages the cursor for n8n's successful
poll handoff. A failed request or invalid page leaves the prior cursor intact.
Changing the selected workspace or API principal initializes a separate feed.
Manual tests read a real retained page without advancing the production cursor.
If a saved cursor expires, increase **Advanced → Restart Counter** manually to
restart at the chosen **First Activation** position. Expiry never silently
replays older automations.

An operation acceptance and its eventual completion are separate facts. A
completion event is metadata for the referenced resource; inspect that resource
before taking a follow-up action. Keep downstream effects idempotent using the
stable event ID, because delivery can repeat after a consumer failure.

## Example

Import `examples/find-lead-by-phone.json` from the installed package, select your
own credential, and replace `team_REPLACE` and the example phone number. The
workflow is inactive and contains no credential values or stored credential IDs.
`examples/import-lead.json` is an inactive import example; connect your own
credential and replace its example workspace and contact before executing it.

## Support and license

API documentation: [totemstudio.ai/developers](https://totemstudio.ai/developers).
Support: [hello@totemstudio.ai](mailto:hello@totemstudio.ai).

MIT. See [LICENSE](LICENSE).

The same public action also exposes current calling bindings and consented call starts,
plus separately authorized transcript and recording reads. A call-start receipt means
provider acceptance; call completion is observed through the lifecycle event trigger.
CRM actions include confirmed delayed contact, configured family handoff and consented
referral to the fixed Totem intake. Their receipts describe saved work and human-review
state without claiming delivery. Delayed contact can carry the current source lead ETag
in **Source ETag (Optional)**. These writes preserve one idempotency key across retries;
uncertain acknowledgements must be reconciled before another effect.

WhatsApp call invitations use the same **Message → Send** action and API-key credential. Set `content.kind` to `whatsapp_call` with `action: send_call_button` (required `body_text`, optional `display_text` and `ttl_minutes`) or `action: request_permission` (optional `body_text`). The conversation selects its actual current number and recipient. A current calling route, customer reply window and permission limits remain required. A sent invitation acknowledges the message; it does not mean a call started or was answered.

## Build the public sources

The proposed public source repository is
[`totem-studio/n8n-nodes-totem-studio`](https://github.com/totem-studio/n8n-nodes-totem-studio).
Its creation and publisher setup remain separate release actions. The maintained
private repository exports a source snapshot; it does not publish its history.

Inside that exported source checkout, use Node 24.18.0 and run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run build
qa_host=/tmp/totem-public-qa-host-rc1
npm run qa:prepare -- "$qa_host"
npm ci --prefix "$qa_host" --ignore-scripts --no-audit --no-fund
npm run lint -- "$qa_host"
npm run pack:public
npm test -- .release/n8n-nodes-totem-studio-1.0.0-rc.1.tgz "$qa_host"
```

The public build has four exact development dependencies, including the real
`n8n-workflow` 2.45.4 types, and no overrides. The separate, explicitly declared
QA host retains its loader/CLI security patches and its own lock; choose an empty
directory outside the source checkout. Tests install the exact tarball in that
real host, check its shared peer identity and execute two loopback HTTP requests.
Lint runs the official CLI's unchanged default config over every exported public
source file. The runtime package has no extra dependencies or overrides.
A successful local build is not npm publication or verified n8n Cloud
approval. The public-repository workflow publishes only an approved version tag,
using provenance and npm trusted publishing after that trust is configured.
