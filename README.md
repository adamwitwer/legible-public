# Legible

A personal notes archive. Handwritten pages in via camera and OCR, typed notes in
directly, everything searchable in single-digit milliseconds.

Design: [`ARCHITECTURE.md`](ARCHITECTURE.md) · Agent context: [`AGENTS.md`](AGENTS.md)
· Requirements: [`miniPRD.txt`](miniPRD.txt)

## Status

**Phases 1 and 2 are built and deployed on Render.** Passkey auth, typed notes with
revision history, local-first search and sync; and capture — camera upload, a Postgres
job queue, `claude-opus-5` OCR, segmentation and boundary review, verified against the
real model. **Phase 3, backfill,** has its first notebook in.

Since then: [TODO markers](#todos), [on-request summaries](#summaries),
[crossed-out words dropped at import](#crossed-out-words), opening with no signal, a
`:help` panel and a `+ note` button, and app icons.

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
npm test         # search, dates, segmentation, split, auth, TODOs, summaries
npm run typecheck
```

OCR and summaries call Claude, so both need `ANTHROPIC_API_KEY` in `.env`. Everything
else runs without it.

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
tree — except the four app icons in `web/public/`, which it allows by exact
filename. It also greps staged text against `.scrub-names`, a gitignored file of
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

**It opens with no signal.** A service worker (`web/public/sw.js`) caches the app shell, so
the app starts offline against the local replica. The page is fetched network-first, so a
deploy still lands the next time you open it online; the API is never cached. Fonts are
self-hosted for the same reason — the worker cannot cache a third-party font — and so no
page view reaches anyone else. It registers in production builds only: to try it, run
`npm run build`, then `npx vite preview` in `web/`, load it, stop the server, and reload.

**App icons come from one file,** `web/public/favicon.svg`. `node scripts/make-icons.mjs`
renders the Apple touch icon and the manifest icons from it through headless Chrome. To
change them, edit the SVG and re-run; don't touch the PNGs.

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

### Which build is on screen

The header shows it — `MMDD.hhmm` in UTC, from
`__BUILD_ID__` in `web/vite.config.ts`. It is there because a phone gives you no
other way to tell a stale bundle from a change that did not work: there is no
hard refresh, and a cache-busting query string proves a fresh fetch but says
nothing about whether the deploy has finished. The full stamp, in the title
attribute, carries the commit — `RENDER_GIT_COMMIT` during a Render build,
`local` otherwise.

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

## TODOs

Write **`TODO`** anywhere in a note — typed, or on the page in your own hand — and
the note gets a `[ ]` beside its title in the list. `is:todo` narrows to those;
`tag:todo` reaches the same set, because both forms derive one tag.

**Deleting the word is how you check it off.** There is no separate checked
state to drift out of step with the note, and nothing to click: clear the marker,
save, and the indicator goes. The previous body is kept in `note_revisions`, so a
TODO cleared by mistake comes back from **history**.

Uppercase and a whole word — "todo" inside a sentence is prose, not a task. A
struck-through `~~TODO~~` is a task abandoned and does not count. On a scanned
page a TODO in the *margin* is an annotation rather than body text, so the import
appends a `#todo` line to the body to make it the same editable marker; the
transcript as OCR'd it stays untouched in `body_ocr_raw`.

## Crossed-out words

Words you cross out on the page are dropped from the digital note at import, so it reads the
way the page means. The photograph and the raw OCR keep them — the model still transcribes a
strike, which is what stops a crossed-out date being taken as a note's date. Typed notes keep
whatever you type.

Notes imported before this (2026-09-14) were brought in line by a one-off script, which uses
the same function as the import:

```bash
npm run strip-struck             # dry run: which notes would change, by id and count
npm run strip-struck -- --apply  # each changed note keeps its original in history
```

## Summaries

An open note has **summarize**: Claude writes a paragraph or two about it and the
summary is kept with the note. Nothing is summarized unless you ask, one note at a
time. Edit the note afterwards and the summary is marked **stale** until you
**resummarize**; **remove** drops it.

Summaries are never searched — a search should only find words you wrote. They live
in their own columns, not the body, so tags, TODOs and history are untouched. For a
scan the margin annotations go to the model too, so a meeting summary knows who said
what, and the prompt treats `~~struck~~` text as retracted and `[?]` as a gap rather
than a name to guess. It needs the server, so it is unavailable offline. `SUMMARY_MODEL`
overrides the model (default `claude-opus-5`); a summary costs about what OCRing one
page does.

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
is:todo tag:meeting          notes with an open TODO
"exact phrase" tag:ideas

:new      start a note        :scan     capture pages
:sync     sync now            :help     commands, search, keys
:enroll   add this device     :devices  list passkeys
:forget   remove a passkey    :logout   end session
↑ ↓ move · enter open · esc back to the prompt
```

`after:` and `before:` filter on the date **written on the page**, not the day it was
photographed.

**Scanning is one tap, not a command.** The `⌾ scan` button at the end of the prompt
row *is* the camera's file input, so tapping it opens the camera inside the tap —
routing through a screen first, or calling `.click()` afterwards, loses the user
gesture on iOS and the camera never opens. The photos you take are already
uploading by the time the scan screen appears. `:scan` still opens that screen
empty-handed, which is the way in when the pages are already in the photo library.

**Typing a note is one tap too.** `+ note` sits beside `⌾ scan` (a bare `+` on a
phone), and whatever is in the prompt becomes the start of the note — so a search that
found nothing is one tap from being written down. Enter on a query with no match does
the same, and `:new` still works. `:help` opens a panel of every command, filter and
key; it closes on esc or as soon as you type.

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
