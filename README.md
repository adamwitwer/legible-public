# Legible

A personal notes archive. Handwritten pages in via camera and OCR, typed notes in
directly, everything searchable in single-digit milliseconds.

Design: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Agent context: [`AGENTS.md`](AGENTS.md)
· Requirements: [`miniPRD.txt`](miniPRD.txt)

## Status

**Phase 1 — typed notes.** Passkey auth, create/edit/delete with revision history,
local-first search, sync.

**Phase 2 — capture.** Camera upload, page storage, a Postgres-backed job queue, the OCR
worker, note segmentation, and boundary review. The pipeline is verified end to end against
the four sample pages in `images/` with stubbed model output; the live OCR call needs
`ANTHROPIC_API_KEY` in `.env`.

## Running it locally

Requires Node 22+ and Postgres 17.

```bash
brew install postgresql@17 && brew services start postgresql@17
createdb legible

npm install
echo "DATABASE_URL=postgres://localhost:5432/legible" > .env
npm run migrate
npm run dev          # api on :3001, app on :5173
```

Open http://localhost:5173. First run asks for an enroll code — it is `dev-enroll`
in development (`ENROLL_CODE`). That authorises the first passkey; after that, adding
another device only needs an existing signed-in session.

```bash
npm test         # query grammar, search, dates, segmentation
npm run typecheck
```

Page images go to local disk (`.data/blobs`) unless R2 is configured, so no Cloudflare
account is needed to work on the capture pipeline. To use R2, set `R2_BUCKET`,
`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`.

### Driving the UI without a database

`web/offline-preview.html` boots the real `App` against seeded local data with
no server running, using the same offline path a dropped connection takes. It
is the way to exercise the interface on a machine that has no Postgres:

```
npm run dev --workspace=web
# then open /offline-preview.html
```

It clears the local Dexie store for its own origin, so run it on its own port,
not against a dev instance holding unsynced notes. Vite builds only
`index.html`, so it never reaches production.

`web/mobile-preview.html` embeds it in 390px and 320px iframes side by side.
Resizing the browser window does not reproduce a phone — media queries key
off the viewport, and an iframe has its own.

## What must not be committed

This repo is public. The archive it runs on is not.

The four pages in `images/` were written for this repo — real handwriting,
invented content, no real people — so that the Phase 0 findings and the OCR
fixtures could live in the open. Everything the app actually ingests is real:
named colleagues, dollar figures, personnel discussion.

So nothing real gets committed. Not a page, not a transcript, not a note title,
and not in a commit message or a screenshot either. `inbox/` and `.data/` are
gitignored and stay that way.

```bash
npm run hooks     # installs scripts/check-no-real-notes.sh as pre-commit
```

The hook blocks staged files under `inbox/` or `.data/`, anything landing in
`images/` other than the four samples, and any image or PDF elsewhere in the
tree. It also greps staged text against `.scrub-names`, a gitignored file of
names from the real archive — one per line, `#` for comments. That list is
gitignored on purpose: a roster of colleagues does not belong in a public repo
any more than their notes do. Without it the hook says so and runs the other
checks anyway.

It is a backstop. It cannot recognise a name it has not been told about, so it
does not replace reading your own diff.

## How it fits together

- **`server/`** — Fastify. Passkey auth, note upsert, sync feed, and a server-side
  full-text search endpoint kept as the fallback path.
- **`web/`** — React PWA. Dexie holds the local replica, MiniSearch indexes it in
  memory, and the terminal UI never touches the network to search.

### Backfilling a notebook

Photos go in `inbox/<notebook-name>/`, which is gitignored — they never enter the repo.

```bash
node scripts/backfill.mjs inbox/2023-green-notebook --dated 2023-09
```

**`--dated` is not optional in practice.** These pages write "Aug 11" with no year, so the
year is inferred from the photo's timestamp. Photograph a 2023 notebook today and every
note in it is dated this year, silently. Pass the period the notebook is from.

Name files so they sort correctly — `001.jpeg`, not `1.jpeg` (which sorts 1, 10, 11, 2).
Page order is what lets a note span pages. Run one notebook per batch: segmentation and
date inference both work across a batch, so mixing notebooks from different years produces
wrong dates.

Capture separates two things deliberately: **OCR is expensive and per-page**, so each page's
raw model output is stored on the page row; **segmentation is cheap and derived**, so note
boundaries can be recomputed after a review correction without ever re-calling the API.

Sync is a cursor over a monotonic `seq`: `GET /api/sync?since=N` returns everything
that changed after `N`, tombstones included. Writes are keyed by client-generated
UUID so a queued offline edit replays safely. Conflicts resolve last-write-wins on
`updated_at`, and the losing version is kept as a revision rather than dropped.

## Splitting a note

A note that swallowed the one after it — the failure mode of "a new note
carries a date", since forgetting the date merges silently — is repaired from
the editor: put the cursor where the second note begins and press **split
here**.

It is a server operation (`POST /api/notes/:id/split`), not a prompt command,
because it needs a cursor position and the prompt has no cursor in the body.
Local edits are pushed first: the server splits its own copy, so an offset
computed against an unsent body would cut in the wrong place. Offline it
refuses rather than guessing.

The second note takes the date it was absorbed under, marked `sequence`, so
the badge flags it as inherited until you set the real one. Pages are never
taken away from the original — a page can belong to two notes, which is what
`starts_at` is for — and when the boundary page cannot be identified from the
transcripts, both notes reference all of them and the status line says so.

## Backups

`npm run backup` writes the whole archive to `~/Dropbox/Documents/Legible`
(override with `--out DIR` or `BACKUP_DIR`):

- `notes/` — one markdown file per note, with `date_precision` preserved so
  guessed dates stay marked as guesses. This is the copy that outlives the app.
- `data/` — a gzipped JSON dump of every table, the exact restore path. The
  last 14 are kept, and the dated filename doubles as a staleness signal.
- `pages/` — the R2 page images, synced by storage key. Markdown page
  references are relative (`../pages/...`) and resolve on disk.

It reads `RENDER_DATABASE_URL` and the four `R2_*` values from `.env`, not a
session cookie — sessions expire after 90 days and this has to run unattended.
Any failure writes `LAST_RUN_FAILED` into the backup folder and exits non-zero.

### The scheduled job, and why it looks strange

A LaunchAgent runs it daily at 09:00. Two macOS constraints shape the setup,
both of which fail in ways that do not name their own cause:

1. **A launchd agent gets no filesystem access** without Full Disk Access —
   not to `~/Documents`, and not to `~/Dropbox` either. FDA attaches to the
   binary that makes the syscalls, and a shell script does not count: its
   shebang means the running process is `/bin/bash`, so a grant to the app
   bundle never applies. `~/Applications/Legible Backup.app` therefore embeds a
   *copy of node* as its executable, ad-hoc signed for a stable TCC identity.
   Grant Full Disk Access to that app. Embedding node also pins the version,
   which is deliberate: the nvm path changes on every upgrade and the job would
   otherwise stop silently.
2. **launchd opens `StandardOutPath` itself**, before exec, and it has no
   Dropbox access — pointing the log into the backup folder fails the whole job
   with `EX_CONFIG` (78) before the script runs. Logs go to
   `~/Library/Logs/legible-backup.log`.

Check it with `launchctl print gui/$UID/com.adamwitwer.legible-backup | grep
"last exit code"`.

**The header shows which build you are looking at** — `MMDD.hhmm` in UTC, from
`__BUILD_ID__` in `web/vite.config.ts`. It is there because a phone gives you no
other way to tell a stale bundle from a change that did not work: there is no
hard refresh, and a cache-busting query string proves a fresh fetch but says
nothing about whether the deploy has finished. The full stamp, in the title
attribute, carries the commit — `RENDER_GIT_COMMIT` during a Render build,
`local` otherwise.

## Commands in the app

**Arrow up and down walk the note list**, from the prompt or from a note that
already holds focus — Tab and Shift+Tab do the same, and the highlight follows
whichever you use. Typing while a note has focus hands the keystroke back to
the prompt rather than dropping it.

**Ctrl+P and Ctrl+N recall previous queries.** History is not on the arrows
because the main screen shows the note list with an empty prompt, where up has
to walk the notes; readline uses the same pair. It persists in localStorage and
holds the last 50 entries.


Typing searches; it does not navigate.

```
kubernetes retro              bare words, fuzzy
tag:meeting after:2026-01     filters compose
before:2025-06-15 is:scan
"exact phrase" tag:ideas

:new    start a note      :scan    capture pages
:sync   sync now
:help   command list      :logout  end session
↑ ↓ move · ⏎ open · esc back to the prompt
```

`after:` and `before:` filter on the date **written on the page**, not the day it was
photographed.

**Scanning is one tap, not a command.** The `⌾ scan` button at the end of the prompt
row *is* the camera's file input, so tapping it opens the camera inside the tap —
routing through a screen first, or calling `.click()` afterwards, loses the user
gesture on iOS and the camera never opens. The photos you take are already
uploading by the time the scan screen appears. `:scan` still opens that screen
empty-handed, which is the way in when the pages are already in the photo library.

**A note can be discarded on its own in review.** A batch often ends in a
fragment — the tail of a page that belongs to nothing, or a stray shot — and the
only options used to be keeping it or throwing the whole capture away. Each
proposed note now has its own `discard`, and the batch-level one reads
`discard all`. Discarding collapses the note to one line and is undone by
tapping `keep`, rather than asking for a confirmation: nothing is written until
`save`, and until then the transcript in that box is the only copy of that
reading. `merge up` targets the nearest note above that is *still being kept*,
so merging into a discarded note cannot quietly take both away. Pages under a
discarded note stay in the batch, attached to nothing.

The scan and review screens hide the prompt: there is nothing to type on either,
and a focused input on a phone costs half the screen — the prompt keeping focus
through `:scan` is what used to leave you looking at blank space with the controls
scrolled off the top. Escape is handled inside the scan screen instead.
