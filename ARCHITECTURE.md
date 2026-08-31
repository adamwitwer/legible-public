# Legible — Architecture

Draft 02 · 2026-08-20 · derived from `miniPRD.txt` and the Phase 0 OCR spike against `images/`

A personal archive that turns handwritten notebooks into something you can grep.
One user, terminal aesthetic, sub-frame search.

---

## Phase 0 result: the spike passed

The largest unknown in draft 01 was whether a vision model could actually read your
handwriting. I ran all four pages in `images/`. **It read all four at high confidence.**

Your hand is close to a best case: print-style rather than cursive, consistent
letterforms, generous word spacing, dark ink on ruled paper. These four pages are
deliberately clean — they were written to test structure, not legibility, and the model
read them without a wobble. The harder legibility question was settled separately against
the real notebook, where genuinely ambiguous tokens ran roughly one in eighty: overwritten
letters, a digit that could be `0` or `O`, a struck word too faint to recover.

**This de-risks the project.** The rest of this document is written with that settled.

But the pages showed five structural features that draft 01 did not account for, and
they matter more than raw character accuracy.

### 1. Notes are entries, and a new one can start mid-page

Page 1 opens `Aug 1  Meeting Title`. Page 2 carries no dated header — it continues that
note, and the bare `Tell me` partway down is a subject, not a note of its own. Page 3
finishes the note in its upper half and opens `Aug 2  The Second Coming` **halfway down a
page that is still finishing the previous one.** Page 4 opens `Aug 3` cleanly at the top.

So: a note is an entry spanning one or more pages, confirming the multi-page model — but
segmentation happens at the **block** level, not the page level. A page can end one note
and begin another.

The boundary signal is learnable: a short line, left-aligned at the margin, naming a
person or topic, often followed by a date or a long dash. The model is asked to emit
segmentation candidates; you confirm them in a review step.

### 2. Dates on the page are partial

`Aug 1` — no year. Every date in the sample is bare month-day. Draft 01 assumed a full
`written_on` date, which would have quietly mis-sorted the entire archive.

Resolution order: an explicit year on the page → the year implied by neighbouring pages
in the same import batch → the photo's EXIF capture date → the upload date. Alongside
`written_on` the note stores `written_on_precision` (`day` / `month` / `year` /
`inferred`), so `before:` and `after:` filters can be honest about what they are
filtering on, and the UI can show an inferred date differently from a read one.

### 3. Marginalia is positional and carries meaning

The sample carries two, and they differ in exactly the way that matters:

- `right-margin note here` — page 1, right margin, written **horizontally**, `rotation: 0`.
- `FB Insights!` — page 2, right margin, written **vertically down the edge**, `rotation: 90`.

Two are enough to prove the mechanism but not the taxonomy, which comes from the real
notebook. A left-margin underlined name is a **speaker attribution** for the lines beside
it. A name with a question mark is someone to **follow up** with. A phrase such as
"lower than 80%" is a **qualifier** on the adjacent line. Everything else is a plain note.

Flattening any of them into the body reading order would corrupt the meaning — a speaker
name would land mid-sentence, a qualifier would attach to the wrong claim. They are
captured as structured annotations with a side, an anchor to the block they sit beside,
and a type. They are indexed for search but rendered in the margin, where they belong.

Rotated text needs calling out explicitly in the prompt or it gets skipped.

### 4. Struck text is retracted, not absent

Page 2 carries a struck `Aug 2` — a date started and abandoned. It matters twice over.
Struck spans are transcribed wrapped in `~~…~~` and given lower search weight: findable
if you go looking, never read as current, because silently dropping them loses the fact
that you changed your mind, which is often the interesting part. And a struck date must
never be taken as a header date — the note it sits inside is `Aug 1`, and the `Aug 2`
note does not begin until partway down the next page.

### 5. Bleed-through is everywhere

Every page shows the reverse side faintly through the paper. The model ignored it
correctly, but the prompt states the rule explicitly rather than relying on luck: faint,
low-contrast, or mirrored text is paper show-through and is never transcribed.

### Also worth noting

Structure is carried by **cascading indentation** and occasional **braces**; the sample
pages exercise indentation and underlining, the real notebook adds braces. Nested markdown
lists capture the indentation and a brace becomes a described grouping. Underlining in the
body — `Lorem ipsum` on page 1, `guy` on page 3 — is emphasis, and is transcribed as plain
text rather than markup, because the app renders bodies literally.

The pages in `images/` are written for this repo, not lifted from a real notebook. The
archive the app goes on to hold is a different matter — that is real work material, and
it is a security requirement rather than a footnote. See
[Access](#access-and-durability).

---

## The core decisions

### 1. Search runs on your device

`VERY fast` is the requirement that shapes everything. A round trip to Render from a
phone on cellular costs 60–200 ms before the database does any work — a perceptible lag
on every keystroke, and unavailable with no signal.

One user means a bounded corpus, so the whole thing is synced down and searched in
memory. **~2–5 ms per keystroke, and it works offline.**

At ~1.5 KB of text per note, 5,000 notes is ~7 MB raw and under 3 MB gzipped — a one-time
cost on a new device, then deltas. The in-RAM index sits around 15 MB.

Postgres keeps its own `tsvector` + GIN index throughout, so the escape hatch is already
built: past roughly 25,000 notes, keep recent years local and fall back to the server for
the long tail. Nothing needs rewriting. **Your 200-page backlog is three orders of
magnitude below that ceiling.**

### 2. A vision model reads the pages

Classic OCR (Tesseract and the OCR modes of most cloud vision APIs) is trained on print
and degrades badly on handwriting. `claude-opus-5` reads the page and returns structured
JSON — transcript, segmentation candidates, annotations, dates — in one call.

### 3. One Render web service, one Postgres, one bucket

No Redis, no worker service. The job queue is a Postgres table claimed with
`FOR UPDATE SKIP LOCKED`, worked by an in-process loop.

### 4. Every note is editable — including scanned ones

*(New requirement, added to the PRD.)* The editor is one component and does not care
where a note came from. Editing a scan diverges `body` from `body_ocr_raw`; the raw model
output and the page images are both kept untouched. Because notes are now mutable and
this is an archive you intend to keep for decades, saves also write a revision row —
cheap insurance against a bad edit noticed three months later.

---

## Data model

```sql
create table notes (
  id            uuid primary key,        -- client-generated → offline creates are idempotent
  kind          text not null,           -- 'scan' | 'typed'
  title         text,
  body          text not null default '',    -- markdown; edited transcript or typed text
  body_ocr_raw  text,                    -- untouched model output, never overwritten
  written_on    date,                    -- date on the page; what date search filters on
  written_on_precision text,             -- 'day' | 'month' | 'year' | 'inferred'
  tags          text[] not null default '{}',
  ocr_status    text,                    -- pending | running | done | failed
  ocr_model     text,
  ocr_run_at    timestamptz,
  confidence    real,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,             -- tombstone; sync must see deletions
  seq           bigint not null,         -- sync cursor; bumped by trigger on INSERT *and* UPDATE
  search        tsvector generated always as (
                  setweight(to_tsvector('english', coalesce(title,'')), 'A') ||
                  setweight(to_tsvector('english', body), 'B')
                ) stored
);
create index on notes using gin(search);
create index on notes using gin(body gin_trgm_ops);  -- fuzzy, for OCR near-misses
create index on notes(seq);
create index on notes(written_on);

-- A note spans pages; a page may be shared by two notes ("The Second Coming", mid-page-3).
create table note_pages (
  note_id     uuid references notes(id) on delete cascade,
  page_id     uuid references pages(id) on delete cascade,
  idx         int not null,              -- order within the note
  starts_at   text,                      -- block anchor where this note begins on the page
  primary key (note_id, page_id)
);

create table pages (
  id      uuid primary key,
  r2_key  text not null,
  width   int, height int,
  shot_at timestamptz,                   -- EXIF; the year-resolution fallback
  batch   uuid                           -- import batch, for neighbour date inference
);

-- Marginalia, kept positional rather than flattened into the body.
create table annotations (
  id        uuid primary key,
  note_id   uuid references notes(id) on delete cascade,
  page_id   uuid references pages(id) on delete cascade,
  side      text,                        -- 'left' | 'right' | 'top' | 'bottom'
  rotation  int default 0,               -- 90 for the rotated right-margin note on page 1
  anchor    text,                        -- the body line it sits beside
  kind      text,                        -- 'speaker' | 'question' | 'qualifier' | 'note'
  text      text not null
);

-- Notes are editable, so keep history.
create table note_revisions (
  id         bigserial primary key,
  note_id    uuid references notes(id) on delete cascade,
  body       text not null,
  title      text,
  saved_at   timestamptz not null default now()
);

create table jobs (                      -- the entire queue. no Redis.
  id bigserial primary key, kind text, payload jsonb,
  run_after timestamptz default now(), attempts int default 0,
  locked_at timestamptz, last_error text
);
```

**The detail that bites people:** `seq` must bump on *update* as well as insert, or edits
made on your laptop never reach your phone. A `before insert or update` trigger assigning
`nextval()` handles it. This matters more now that editing is a first-class requirement.

### Sync

Deliberately boring — one user across a few devices does not need CRDTs.

- `GET /api/sync?since=<seq>` returns changed rows and tombstones in `seq` order, 500 at a
  time, plus the new cursor.
- `POST /api/notes` upserts a batch keyed by client-generated UUID, so replaying a queued
  offline write is harmless.
- Conflicts resolve last-write-wins on `updated_at`, with the losing body appended rather
  than dropped, and both preserved in `note_revisions`. For one person this fires
  approximately never; when it does, you would rather see both.

---

## Capture pipeline

The worker sends each page and gets back validated JSON via `output_config.format`, with
`thinking: {type: "adaptive"}` for the messy passages:

```json
{
  "blocks": [
    {
      "starts_note": true,
      "title": "Meeting Title",
      "date_text": "Aug 1",
      "date_precision": "day",
      "transcript": "Lorem ipsum\ndolor sit amet\ndolore provident\n..."
    }
  ],
  "annotations": [
    { "side": "right", "rotation": 0, "kind": "note",
      "anchor": "dolor sit amet", "text": "right-margin note here" }
  ],
  "confidence": 0.94,
  "illegible": []
}
```

Prompt rules earned directly from the sample pages:

- **Segment at blocks, not pages.** A short left-margin line naming a person or topic,
  **carrying a date**, starts a new note — even mid-page. A name without a date does not;
  it is a subject inside the note in progress. (Revised 2026-08-21; the original rule
  accepted a long dash in place of a date and over-segmented Adam's real notebooks.)
- **Transcribe to markdown.** Cascading indentation becomes nested lists. Braces
  grouping several lines become a described grouping.
- **Keep struck text**, wrapped in `~~…~~`.
- **Capture margin text separately**, with its side and rotation. Read rotated text.
- **Ignore bleed-through** — faint, low-contrast, or mirrored text is the reverse of the page.
- **Describe sketches and arrows** in brackets so they remain findable.

### Cost

A page is roughly 1,500–3,000 input tokens; the JSON back is ~800.

| Model | Per page | Your 200-page backlog |
|---|---|---|
| `claude-opus-5` | **≈ 4.1¢ (measured)** | **≈ $8.20** |
| `claude-opus-5` via Batch API | ≈ 2.1¢ | ≈ $4.10 |
| `claude-sonnet-5` | ≈ 2.5¢ (est.) | ≈ $5.00 |

Measured, not estimated: a real page runs ~6,900 input tokens and ~250–400 output. The
input is higher than the 1,500–3,000 first guessed because these photos are 3024×4032;
downscaling before the API call would cut it materially, and is the obvious optimisation
if the backlog ever grows past a few hundred pages. At 200 pages it is not worth the
dependency.

**200 pages is a rounding error.** Two consequences: use Opus 5 and stop optimising, and
bulk import is a throwaway script rather than a built feature. Ongoing capture at ~5
pages/day lands near $5/month.

### Capture UX

The phone camera is reached through
`<input type="file" accept="image/*" capture="environment">` — no native app, no App
Store, works from the installed PWA on iOS and Android. Shoot pages continuously; they
upload in the background and the note appears immediately as `pending`, filling in when
the worker finishes.

After a multi-page import, a **boundary review** step shows the proposed note splits as a
filmstrip. Merge, split, retitle, fix a date. This is the one place the pipeline asks for
help, and it is where page-8-style mid-page boundaries get confirmed.

---

## Interface

The terminal aesthetic is not only decoration — a command line is genuinely the fastest
interface for "find the thing", and it lets the app have almost no chrome. One persistent
prompt. Typing filters; it does not navigate.

```
notes ~ 2,481 notes ─────────────────────────── last sync 2m ago

  2026-03-14  Q3 planning — open questions        scan
              ...who owns the migration? need to ask...
  2026-02-02  Migration notes                     typed
              ...the migration path from the old...

> migration▊                                      3 hits · 4 ms
```

- **Type anything** — results re-render on every keystroke against the local index.
- **`:scan`** camera · **`:new`** blank note · **`:e`** edit · **`:o`** original photograph
- **`↑`/`↓`** move, **`⏎`** open, **`esc`** back to the prompt. Never reach for the mouse.
- On mobile the prompt pins above the keyboard with a camera button beside it.
- **`motd`** on the boot screen surfaces a note from this day a year ago.

Query grammar — bare words match fuzzily, prefixed tokens filter, and they compose:

```
kubernetes retro
tag:meeting after:2026-01 budget
before:2025-06-15 is:scan
"exact phrase" tag:ideas
```

`after:` and `before:` filter on **the date written on the paper**, not the day you
photographed it — with `written_on_precision` keeping that honest when the year was
inferred.

**Typography:** monospace for chrome, prompt, and metadata; **proportional for note
bodies** (per your answer). Amber phosphor on warm near-black rather than green on pure
black — it holds up far better for long reading while still reading as a console.

Fuzzy matching matters more than usual here: handwriting OCR produces near-misses, and
exact-token search would silently lose those notes forever. `MiniSearch` edit-distance on
the client, `pg_trgm` on the server fallback.

---

## Deployment

Render works, with one hard constraint: **this cannot run on free instances.** Free web
services spin down and cold-start in tens of seconds — the opposite of the headline
requirement — and free Postgres expires.

| Component | Where | ≈ $/mo |
|---|---|---|
| PWA + API + OCR worker | Render Web Service (one service) | ~$7 |
| Database | Render Postgres | ~$7 |
| Page images | Cloudflare R2 | ~$0 |
| OCR | Claude API | ~$5 |

**Amended in Phase 1 — one service, not two.** Draft 02 split the PWA onto a
Render Static Site. That does not work with passkeys: WebAuthn scopes a credential to a
relying-party ID, which must be the registrable domain. A split origin
(`legible.onrender.com` + `legible-api.onrender.com`) would need an RP ID of
`onrender.com`, which is on the Public Suffix List and rejected by browsers. Serving both
from one origin also removes CORS and `SameSite=None` from the session cookie. The app
shell is small and service-worker cached, so losing the CDN costs little. On a custom
domain the split becomes possible again — not worth doing.

**~$15/month** steady state, plus a one-time ~$6 backlog. Figures are list prices —
verify against current pricing pages before committing.

### On Dropbox / SCP over the Tailnet

Your instinct is right, but it fits better one layer over. 200 pages is ~400 MB, which
sits inside R2's free tier indefinitely.

The problem with serving from Dropbox or a Tailnet host is that the app is served from
Render on the public internet, and **Render is not on your tailnet** — it could not fetch
the images to display them without a Tailscale sidecar, which is a lot of moving parts
for 400 MB. Dropbox's API adds OAuth refresh handling and rate limits, and it is not
built to serve content.

So: **R2 serves, your infrastructure backs up.** The nightly export pushes markdown plus
images to Dropbox, or rsyncs over the Tailnet to your own box. You get your data on
hardware you control, which is what the instinct is actually about, without putting a VPN
in the request path.

### Access and durability

The archive holds real work material — named colleagues, dollar figures, personnel
discussion. Treat it as confidential. The sample pages committed to `images/` are
invented for this repo precisely so the repo can be public and the archive not.

- **Passkey auth** (WebAuthn) — Face ID on the phone, Touch ID on the Mac. Bootstrap
  enrollment with a one-time code from an env var; session is an HttpOnly, SameSite=Lax
  cookie. It is one user; do not build an identity system.
- **Rate limits, and what they actually buy.** The per-IP caps — 300/min globally, 20/min
  on ceremony endpoints — are keyed on `X-Forwarded-For`, which the caller writes. Anyone
  willing to rotate it walks past them, so they are protection against runaway clients and
  accidents, not against a deliberate attacker, and nothing security-critical rests on them.
- **The enroll code's entropy is what protects it, not a rate limit.** This took three
  attempts to get right, so the reasoning is worth keeping. A budget consulted *before* the
  code is compared would cap brute force — and any bucket a stranger can drain is a bucket
  the owner can be locked out of, on the one documented way back into the archive after a
  domain move. Keying it per IP does not escape that: under `trustProxy` the key is
  caller-written, and a key derived from the proxy chain can collapse onto a shared upstream
  address the owner also sits behind. There is no keying that both caps guessing and cannot
  be used to lock the owner out.
  So the code carries its own weight, the way an API token does: `env.ts` refuses to start
  in production unless `ENROLL_CODE` is at least 16 characters and not the dev default.
  `generateValue: true` in `render.yaml` satisfies that; a memorable value typed by hand is
  the temptation it exists to refuse. The failure budget stays, charged only on a wrong
  code — it is back-pressure and a log signal, not the control, and a stranger emptying it
  costs the owner nothing because a correct code never consults it.
- **One challenge row per ceremony**, keyed by the challenge value. Keyed by *kind* — the
  original design — the pending challenge was a single slot any unauthenticated caller
  could overwrite via `/login/start`, locking the real user out for as long as they kept
  writing to it.
- **Security headers** via `@fastify/helmet`: a same-origin CSP with
  `frame-ancestors 'none'`, HSTS in production, `Referrer-Policy: no-referrer`, nosniff.
- **Failures do not explain themselves to strangers.** Verification errors log the reason
  and return a bare `verification_failed`.
- **R2 objects stay private**, served through short-lived signed URLs. Never a public bucket.
- **Nightly export** to R2 *and* your own storage: one markdown file per note plus its
  images, in a plain directory tree. Render's backups protect the service; the markdown
  export protects *you*, and means the archive outlives the app, Render, and this design.

---

## Build order

**0. ~~Spike: can it read your handwriting?~~ — done. Yes.**

1. **Typed notes, end to end.** Schema, sync, local index, terminal UI, editing, revision
   history, passkey auth, deployed. No camera yet. At the end you have a fast notes app
   you would use daily, and the search architecture is proven under real typing.

2. **Capture pipeline.** Camera input, R2 uploads, jobs table, OCR worker, the block
   segmentation prompt, annotations, pending states, boundary review.

3. **Backfill the 200 pages.** A script, not a feature — submit through the Batch API,
   review the boundaries, done in an afternoon for about $3.

4. **The rest.** Offline write queue, `motd`, markdown export to Dropbox/Tailnet, and
   optionally a second search rail — embeddings in `pgvector`, where a `?` prefix asks a
   question instead of matching keywords. Deliberately last: keyword search over your own
   words is usually what you actually want, and it is instant.

---

## Appendix: spike transcripts

Read from `images/`, ordered as supplied. Three notes are present.

These four pages were written for this repo. They are in my hand, in the same notebook,
with the same habits — a dated header, margin notes both flat and turned sideways, a
struck line, an underline for emphasis — because that is what the spike had to test. The words are
placeholder text, a pangram, and scraps of things I had been reading. Nothing here is a
real meeting, and there are no real people in it.

**`Meeting Title — Aug 1`** (pages 1–3, ending partway down page 3)

> Lorem ipsum
> dolor sit amet *[margin, right: right-margin note here]*
> dolore provident
>
> The quick brown
> fox jumps over the
> lazy dog
>
> The vanishing spies
> just something I read
> …
>
> that is just how some
> things do not
> materialize *[margin, right, rotated 90°: FB Insights!]*
>
> ~~Aug 2~~
> Give me one little
> blip and I'll totally
> flip Yeahhhh…
>
> Tell me
>
> it's nothing but
> skies and
> I will be one lonely
> guy

`Lorem ipsum` on page 1 and `lonely` / `guy` on page 3 are underlined — emphasis,
transcribed as plain text. The struck `Aug 2` on page 2 is a date abandoned mid-thought;
it stays inside this note, which is dated `Aug 1`. `Tell me` is heading-shaped — short,
left-aligned, white space above it — but carries no date, so it does not split. The two
margin notes differ in rotation on purpose: page 1's runs horizontally in the margin,
page 2's runs vertically down the page edge.

**`The Second Coming — Aug 2`** (page 3, lower half — a second note beginning mid-page)

> Turning and turning
> in the widening gyre

**`Love makes your soul crawl out from its hiding place — Aug 3`** (page 4, at the top)

> Love makes your soul crawl out from its hiding place
