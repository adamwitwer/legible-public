# AGENTS.md

Working context for coding agents on this repo. Read `ARCHITECTURE.md` for the full design;
this file is the short version plus the conventions that aren't derivable from the code.

## What this is

**Legible** — a personal notes archive for one user (Adam). Digitizes handwritten notebook
pages via phone camera + vision-model OCR, stores them alongside typed notes, and makes the
whole corpus searchable in single-digit milliseconds. Old-school terminal aesthetic.

Source of truth for requirements: `miniPRD.txt`. Design: `ARCHITECTURE.md`.

## Status

- **Phase 0 (OCR spike): done.** All 4 pages in `images/` read at high confidence. Full
  transcripts are in the ARCHITECTURE.md appendix — use them as regression fixtures when
  building the capture pipeline.
- **Phase 1: built and deployed.** Passkey auth, notes CRUD with revision history,
  local-first search, and sync all work, locally and on Render.
- **Phase 2: built and verified against the real model.** Upload → storage → job queue → OCR
  worker → segmentation → boundary review → commit, run end to end on the four pages in
  `images/`. Output matched the hand reading in ARCHITECTURE.md: 3 notes, page 3 shared
  because "The Second Coming" started mid-page, marginalia typed and rotated correctly, strikethroughs
  preserved, no bleed-through, no invented years. Measured cost ≈ 4.1¢/page.

- **Phase 3: first notebook done (2026-08-21).** 96 pages covering 17 Jul – 20 Aug 2026,
  scanned with Notes.app to PDF, rendered by `scripts/pdf-pages.mjs`, imported by
  `scripts/backfill.mjs --dated 2026`. 56 notes committed, 0 OCR failures, ~$4. Read the
  Backfill section below before the next one.

  Four dates came out wrong, and three share one cause: **a date written inside a note's
  body was taken as the note's own date** ("to Aug 17", "Bo — Gus Sep 5"). Tightening the
  header-vs-body distinction in `ocr.ts` would fix future notebooks; it cannot fix past
  ones, because `date_text` is stored in `pages.ocr_json` and only re-OCR would change it.

`npm test` covers the query grammar, search, dates, and segmentation (77 assertions).
Phases 3–4 in `ARCHITECTURE.md`. See `README.md` for how to run it.

**Deployed to Render on 2026-08-21**, single web service + Postgres 17, page images in
Cloudflare R2. Passkey enrolled and a note round-tripped. Two things the deploy taught, both
of which cost a failed build or would have cost a production outage:

- **`NODE_ENV=production` applies during Render's build**, so `npm ci` omits every
  devDependency — and the build needs `typescript`, `vite` and the `@types` packages. The
  build command must keep `--include=dev`. It does not fail with "tsc: not found": the build
  image has a *global* tsc that compiles the app against a tree with no type declarations
  and emits 200 lines of unrelated-looking TS7016/TS7026.
- **The R2 path had never been executed before it was deployed.** It used `require()` in an
  ESM package, `@aws-sdk/client-s3` was never a declared dependency, and `render.yaml` set
  no R2 variables, so it would have silently written blobs to Render's ephemeral disk.
  `build()` in `server/src/lib/storage.ts` now refuses to start in production without R2
  rather than losing the archive one deploy at a time.

**Still not backed up.** Render's managed Postgres has its own backups, but there is no
export under Adam's control and no copy of the R2 objects. Worth solving once the archive
holds a notebook or two.

**A new note must carry a date.** A bare heading — "Tell me" in the sample, or a bare
name in the real notebook — is a subject inside the note already in progress, however heading-like it
looks. This is Adam's own convention (2026-08-21) and he writes dated headers going
forward. It is enforced in two places on purpose: the `ocr.ts` prompt, so the model's
judgement matches, and `segment.ts`, so it is a property of the data rather than of the
model's mood that day — and so it re-derives over an existing batch through `/resegment`
without re-reading a page. On the first notebook the rule takes 56 notes to 34.

## Settled decisions — do not relitigate without a reason

| Decision | Choice |
|---|---|
| Search | **Local-first.** Full corpus synced to device, in-memory index, `MiniSearch`. Postgres `tsvector` + GIN is the durable copy and the >25k-notes fallback. |
| OCR | **`claude-opus-5` vision**, structured output via `output_config.format`, `thinking: {type:"adaptive"}`. Not Tesseract. Not a cheaper model — accuracy compounds over a decades-long archive. |
| Note model | A note is an **entry**, not a page. It spans pages via `note_pages`; a page can be shared by two notes. |
| Hosting | Render (paid tiers — free instances cold-start and break the speed goal). **One** Web Service serves API + PWA, plus Postgres. Single origin is required for WebAuthn: a split origin would need an RP ID of `onrender.com`, which is a public suffix. |
| Images | **Cloudflare R2** in production, local disk in dev (`server/src/lib/storage.ts` picks by env). Served through the authenticated API rather than signed URLs — for one user that is simpler and strictly more private, since no URL works outside a live session. Dropbox / Tailnet is the *backup* target, never the serving path. |
| Auth | Passkey / WebAuthn, HttpOnly SameSite=Lax session cookie. One user; do not build an identity system. |
| Queue | Postgres `jobs` table + `FOR UPDATE SKIP LOCKED`, worked in-process. No Redis. |
| Typography | Monospace for chrome/prompt/metadata, **proportional for note bodies**. Amber phosphor on warm near-black, not green on black. |

## Findings from real pages that the code must honor

These came from `images/` and are easy to get wrong from first principles:

1. **A new note can start mid-page.** Segment at block level, not page level. `note_pages.starts_at`
   holds the block anchor. Page 3 of the sample is the canonical hard case: "Aug 2  The
   Second Coming" opens partway down a page still finishing the note above it. An *undated*
   header in that position does not split — it is a subject inside the note in progress,
   which is what "Tell me" on page 2 is there to test.
2. **Dates on the page have no year** (`Aug 1`). Resolve: explicit year → batch neighbours →
   EXIF `shot_at` → upload date. Always record `written_on_precision`.
3. **Marginalia is positional and typed** — a left-margin underlined name is a speaker
   attribution, not a stray word. Keep `side`, `rotation`, `anchor`, `kind`. Some margin
   text is rotated 90°: the sample has one of each, flat on page 1 and vertical on page 2,
   so a run that reports the same rotation for both is wrong.
4. **Struck text is retracted, not absent.** Transcribe inside `~~…~~`, weight it down in
   search. A struck *date* is never a header date — page 2's `~~Aug 2~~` sits inside the
   `Aug 1` note, and the `Aug 2` note does not open until page 3.
5. **Bleed-through is on every page.** The OCR prompt must explicitly refuse faint/mirrored text.

**Segmentation tuning (learned from the first real run):** the model's default is to start a
new note at every topic heading, which turned 3 notes into 5. A note is one *session* — a
meeting or a conversation — not a subject. The prompt now contrasts real headers from this
sample ("Aug 1  Meeting Title", "Aug 2  The Second Coming") against bare headings that must
NOT split ("Tell me", "The vanishing spies"), and tells the model to continue when unsure.
Keep that contrast if you rewrite the prompt; it is the difference between 3 notes and 5.

## Backfill (Phase 3)

`scripts/backfill.mjs <dir> --dated YYYY[-MM]` imports a notebook from `inbox/` (gitignored).
One notebook per batch: segmentation runs across a batch, and so does year inference.

**Never put notebook photos in `images/`** — that directory is committed, and the repo is
public. `images/` holds exactly the four invented Phase 0 samples and must stay that way:
a real page there is both ~400MB of permanent git history for a notebook and a disclosure
of other people's information that no later commit can undo.

**`--dated` prevents the worst silent failure in the system.** Pages carry "Aug 1" with no
year, so `resolveDate` falls back to `pages.shot_at`. Photographing an old notebook today
dates its every note to the current year, with no error and nothing to notice until the
archive is already wrong. The script writes `shot_at` from `--dated` instead. If that column
ever needs to mean "when the photo was taken" for another reason, add an explicit
`batches.date_hint` rather than removing this behaviour.

## Conventions

- **Bind jsonb with `sql.json(value)`, never `JSON.stringify(value)::jsonb`.** postgres.js
  JSON-encodes a string parameter bound to `jsonb`, so stringifying first stores a JSON
  *string* containing JSON. It reads back as a string, so `payload.pageId` is `undefined` —
  and a job then silently no-ops and marks itself `done`. No error is raised anywhere; it
  looks exactly like "OCR just never runs." This shipped in Phase 2's first draft and was
  caught only because the pipeline was exercised end to end.
- **`seq` must bump on UPDATE as well as INSERT** (trigger, not a column default). Editing is a
  first-class requirement; without this, edits never sync between devices. This is the single
  easiest bug to introduce here.
- **Calendar dates are not instants.** `written_on` is the day a note was written or the date on
  the page — always derive it in local time via `web/src/lib/dates.ts`, never from
  `toISOString()`, which dates anything after ~7pm EST to tomorrow. Postgres `date` columns are
  configured in `server/src/db/index.ts` to parse as plain `YYYY-MM-DD` strings rather than JS
  Dates, because the default re-serializes them to UTC midnight and breaks `before:` filters.
  `created_at` / `updated_at` stay UTC — those are real instants and sync ordering depends on it.
- Note IDs are **client-generated UUIDs** so offline creates are idempotent on replay.
- Never overwrite `body_ocr_raw` or delete page images. The photograph is the source of truth;
  the transcript is derived and correctable.
- Every save writes a `note_revisions` row.
- Search must stay off the network. If a feature needs a round trip per keystroke, it's wrong.

## Security

**Auth hardening (2026-08-31).** Rate limits exist now. The per-IP floors are best-effort
only — `X-Forwarded-For` is caller-written, so they stop accidents, not adversaries. **The enroll code is protected by its entropy, not by a rate limit** — `env.ts` refuses to
start in production on anything under 16 chars. That is deliberate: every way of keying a
pre-check budget either can be rotated past or can be drained by a stranger to lock the
owner out of the one documented way back into the archive. The failure budget in
`lib/enroll.ts` is charged only on a wrong code and is back-pressure, not the control.
Don't "fix" it by moving the charge ahead of the comparison — read the note in
`decideEnroll` first. `enroll.test.ts` pins both properties.

**When reading @fastify/rate-limit's result, `isAllowed` is not the field you want.** It is
true only for allowList hits; `isExceeded` is the real signal. Translate through
`overBudget()`, and test against fixtures of the library's actual shapes — a mock with
invented semantics is how this shipped wrong once already.
WebAuthn challenges are stored one row per ceremony keyed by the challenge value — keyed
by kind, a stranger could overwrite the pending challenge and lock Adam out with no
credential at all. `ENROLL_CODE` now refuses to fall back to its dev value in production.
Don't undo any of these to simplify a test; use `WORKER_CONCURRENCY=0` and a real code.

**This repo is public. The archive it holds is not.**

The four pages in `images/` are invented for this repo — real handwriting, fictional
content, no real people. Everything the app actually ingests is real work material: named
colleagues, dollar figures, personnel discussion.

So: never commit a real page, a real transcript, or a real note title — not to `images/`,
not into a test fixture, not into a commit message, not into an issue or PR description.
`inbox/` and `.data/` are gitignored and must stay that way, and a pre-commit hook
(`scripts/check-no-real-notes.sh`) blocks the obvious cases. The hook is a backstop, not
permission to stop thinking: it cannot recognise a name it has not been told about.

Keep R2 objects private behind short-lived signed URLs; never a public bucket.

## Working agreements

- This is a collaboration, not a spec handoff. Push back on the design where it's wrong, and
  say so plainly rather than building around it.
- Flag open questions in the doc rather than silently picking; the PRD tracks answers inline.
- Cost figures in the docs are list-price estimates — re-verify against current pricing pages
  before anything is committed to.
