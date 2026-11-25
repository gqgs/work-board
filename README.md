# work-board

Static Kanban UI for a private, Git-backed work queue.

**Board:** https://gqgs.github.io/work-board/

## Public UI, private tasks

- This public repository contains only the static UI, tests and setup instructions. It has fresh history, separate from the private task repository.
- `gqgs/work` remains private. Its `main` branch and `tasks/*.md` files remain the source of truth.
- The browser reads and writes tasks directly through `https://api.github.com/repos/gqgs/work`. Each create, edit or status move creates one commit in the private repository.
- No task files, task exports, private Git history or credentials belong in this repository. Task edits do not redeploy the UI.
- There is no backend, database, build step, dependency download or third-party script.

## Enable GitHub Pages

Open [Settings → Pages](https://github.com/gqgs/work-board/settings/pages), select **Deploy from a branch**, choose **main** and **/docs**, then save. After deployment, open [the board](https://gqgs.github.io/work-board/).

## Enter your token

1. Open the board and select **Connect GitHub**.
2. Paste your fine-grained personal access token into **GitHub access token** and select **Connect**.
3. The token must be limited to **gqgs/work** with **Contents: Read and write**. Metadata read access is included automatically. It does not need access to this public UI repository.

Enter the token only in the board's connection dialog. Do not put it in source code, a URL, chat, repository secrets, or a GitHub Actions variable. No server-side token is needed.

The app holds the token only in this tab's memory. It sends the token only to GitHub's REST API and discards it on refresh, disconnect, or canceled connection. It does not use localStorage, sessionStorage, cookies or a service worker to persist credentials. You will need to reconnect after reloading the page.

A token with write access can change files in the selected private repository. Use an expiry, keep it private, and only enter it on a copy of the UI you trust. The UI code runs in your browser; anyone who can change the published UI can change that code.

Without a token, visitors can see the empty interface but cannot load the private tasks.

Malformed task files no longer block the entire board: valid cards still load, and the board lists each unreadable task filename and validation error until it is corrected. Publishing alerts wait for a clean refresh. GitHub request and authentication errors still fail the connection.

## Development

The deployable site is `docs/`, including its local `assets/` and `.nojekyll`. Keep `REPO = "gqgs/work"` and `BRANCH = "main"` in `docs/app.mjs` unless deliberately changing the private data destination.

Run the dependency-free tests with Node.js:

```sh
node --test tests/*.test.mjs
```

Serve locally:

```sh
python -m http.server 8000
# Open http://localhost:8000/docs/
```

The tests use synthetic fixtures and fake tokens. They never read or write live tasks. Conflicts must be surfaced rather than silently overwriting concurrent edits.

## Manual publishing and optional tab alerts

Choose **Publishing** (or Upload Ready, Overdue, Needs verification, Scheduled, Completed, Published,
On hold, Check metadata) and a channel. This is a planning view, not a publisher:
no uploads, provider credentials, external posts or scheduling APIs are involved.
Dates display in **America/Sao_Paulo**. A past scheduled time means **Needs
verification**, never an automatic claim that the post is public.

Publishing is grouped into derived lanes, with a highlighted **Upload Ready**
lane first. It includes `ready` items whose due time has passed, visibly marked
**Overdue** and sorted before undated/future items. Overdue drafts stay in
Preparing; scheduled items needing verification never enter Upload Ready.
Every card appears in one lane only. These lanes do not change persisted task
statuses or support drag-to-status moves; the normal engineering board is unchanged.
On narrow screens publishing lanes stack vertically, Upload Ready first.

Use one task per clip/channel delivery. Keep the existing six front-matter
fields. Add exactly one top-level fenced block to its Markdown description:

````markdown
```work-publish
{"version":1,"channel":"example","state":"ready","due":"2030-01-03T13:00:00-03:00","published_url":""}
```
````

- `version`: number `1`. `channel`: lowercase slug, 1–40 characters.
- `state`: `draft`, `ready`, `scheduled`, `published`, or `hold`.
- `due`: optional ISO datetime with seconds and explicit `Z` or `±HH:MM`
  offset; empty means no date. `scheduled` requires a date. Invalid calendar
  dates and local datetimes without offsets are rejected.
- `published_url`: optional credential-free HTTPS receipt. Required for
  `published`. Only mark scheduled/published after recording the actual result.
- No other metadata keys. Missing blocks mean ordinary work; malformed,
  unsupported or duplicate blocks show **Check publishing metadata** and never
  alert. Code examples nested in other fences are not live metadata.
- Task status `parked` or publishing state `hold` suppresses alerts. Task status
  `done` closes an unpublished plan without claiming it was published.
- A ready/draft item becomes **Overdue** at its due time. Ready is editorial
  readiness, not authorization to publish. Approval details and exact assets
  belong in the private description, not in this public UI repository.

This Markdown-body format round-trips through old board clients without a
front-matter migration. Edit the block in the existing task description form.
External read-only reminders can use `publishingInfo()` for the same state
calculation, keyed by the stable task ID and channel.

**Enable tab alerts** explicitly asks for system-notification permission. No
permission request happens on load or connection. Notifications contain only
counts, never task titles, links, captions or dates. The first successful
refresh establishes the ready baseline (no backlog flood); later ready
transitions alert. Existing overdue and needs-verification items may alert
once immediately. Alerts are deduplicated by task ID/channel/effective state/
due time for this connected session, including pause/resume. A changed due time
can rearm an overdue alert. Disconnect clears this memory and closes outstanding
notifications. Reconnecting is a new session and may alert for overdue items.

Connected tabs refresh every minute and reuse unchanged blobs in memory. A
pending edit/save is not interrupted; alerts wait for a successful full
refresh. No token, task data, opt-in flag or alert history is saved to browser
storage. Refreshing the page requires reconnecting and enabling alerts again.

Desktop HTTPS browsers with the Notifications API are supported on a best-effort
basis. Denied/unsupported notifications do not prevent using the board.
**This tab must remain open and connected.** Background throttling, sleep and OS
notification settings can delay or hide alerts. No service worker, push server
or reliable closed-tab reminder is provided; use a separate private reminder
for that. Never persist the GitHub token to work around this limitation.

To check browser alerts: connect, choose **Enable tab alerts** and allow the
browser permission if desired, then choose **Send test alert**. The test button
never requests permission itself. It sends only a generic synthetic notification,
without editing tasks, creating due dates, or resetting automatic alert history.
The inline result distinguishes unavailable/blocked/failed notifications from
**browser accepted**. Acceptance is not proof that the OS displayed it or that
you saw it: check the system notification center and Do Not Disturb settings.

The tab favicon and both notification types reuse the public EigenDynamics wiki
mark through [local assets](docs/assets/README.md), without contacting the wiki.
The icon is optional; browsers and operating systems may ignore it or show their
own browser badge alongside it. Notification delivery remains best-effort.

## One-click card actions

Each actionable card has one next-step button. Publishing drafts get **Mark
ready**; ready and scheduled cards (including Needs verification) get **Mark
complete** after you have manually uploaded. Completion changes only task
`status` to `done`, retaining the original publishing block, dates and links.
It stops ready/overdue/verification reminders and appears in **Completed**
with **Done** (no post link) or **Published** (post link recorded). This is your report of completion,
not an upload, schedule, or independent confirmation that a post is public.
No URL is invented or required. After completion, an optional **Add post link**
button opens a short form for X/Twitter, Instagram, YouTube and TikTok cards.
It saves the existing `state: "published"` and `published_url` together in one
SHA-protected write while keeping task status `done`, the original due date,
source `url`, and surrounding description. Existing receipts are never replaced.
Other channels and legacy receipts stay readable; the generic editor remains
available. There is no new schema and no second status to manage.

The form accepts recognizable HTTPS post/video permalinks for the card's channel,
including YouTube watch/Shorts/youtu.be, Instagram post/Reel, X status, and full
TikTok @user/video links. It rejects profiles, dashboards, credentials, incorrect
hosts and unresolved redirect/short links. Tracking queries/fragments are removed
(the YouTube video ID is retained). URL shape is checked locally, not fetched:
**Published means a post link was recorded, not that public access was verified**.
Nothing is uploaded, scheduled, posted, or changed on the social platform.

Completed cards share one lane separate from On hold. Card details show the same
derived publishing status; raw publishing metadata is hidden in read views but
preserved in the saved Markdown and generic editor. Cancel leaves the task
unchanged. Polling pauses while entering a link, repeated saves/dismissal are
blocked during the write, and conflicts or uncertain responses reconcile without
replay. A failed receipt save requires closing the form and reviewing the current
card before explicitly retrying; it never silently replaces another receipt.

Ordinary work has **Start**, **Move to review**, or **Mark done** for Backlog,
Active, and Review respectively. Terminal, parked, held, and malformed
publishing cards have no shortcut. **Details** and Edit remain available.
Each shortcut uses the existing SHA-protected GitHub save. Repeated clicks
are blocked during saves. A failed/uncertain save refreshes the board without
replaying it; if reconciliation fails, shortcuts wait for a successful Refresh.
