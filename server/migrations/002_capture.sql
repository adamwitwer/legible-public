-- Phase 2 — capture pipeline.
--
-- Design note: OCR is expensive and per-page; segmentation is cheap and derived.
-- They are deliberately separate. Each page keeps its raw model output in
-- pages.ocr_json, so re-deriving note boundaries after a review correction costs
-- nothing — we never re-call the API to fix a split.

-- A batch is one import: the pages you shot in a sitting.
create table if not exists batches (
  id          uuid primary key,
  status      text not null default 'uploading'
                check (status in ('uploading','ocr','review','committed','failed')),
  created_at  timestamptz not null default now(),
  committed_at timestamptz
);

create table if not exists pages (
  id           uuid primary key,
  batch_id     uuid references batches(id) on delete cascade,
  idx          int not null,              -- shot order within the batch
  storage_key  text not null,
  content_type text not null default 'image/jpeg',
  bytes        int,
  width        int,
  height       int,
  shot_at      timestamptz,               -- EXIF capture time; the year-resolution fallback
  ocr_status   text not null default 'pending'
                 check (ocr_status in ('pending','running','done','failed')),
  ocr_json     jsonb,                     -- raw model output; never overwritten by edits
  ocr_model    text,
  ocr_run_at   timestamptz,
  confidence   real,
  error        text,
  created_at   timestamptz not null default now()
);
create index if not exists pages_batch_idx  on pages (batch_id, idx);
create index if not exists pages_status_idx on pages (ocr_status);

-- A note spans pages, and a page may be shared by two notes: sample page 8 ends
-- one note and begins another halfway down. starts_at anchors that boundary.
create table if not exists note_pages (
  note_id   uuid not null references notes(id) on delete cascade,
  page_id   uuid not null references pages(id) on delete cascade,
  idx       int not null,
  starts_at text,
  primary key (note_id, page_id)
);
create index if not exists note_pages_page_idx on note_pages (page_id);

-- Marginalia, kept positional. Flattening it into the body would attach
-- a speaker name mid-sentence and hang "lower than 80%" off the wrong claim.
create table if not exists annotations (
  id       uuid primary key,
  note_id  uuid not null references notes(id) on delete cascade,
  page_id  uuid references pages(id) on delete set null,
  side     text check (side in ('left','right','top','bottom')),
  rotation int not null default 0,
  anchor   text,
  kind     text check (kind in ('speaker','question','qualifier','note')),
  text     text not null
);
create index if not exists annotations_note_idx on annotations (note_id);

-- The entire queue. No Redis: claimed with FOR UPDATE SKIP LOCKED.
create table if not exists jobs (
  id         bigserial primary key,
  kind       text not null,
  payload    jsonb not null,
  status     text not null default 'pending'
               check (status in ('pending','running','done','failed')),
  run_after  timestamptz not null default now(),
  attempts   int not null default 0,
  max_attempts int not null default 3,
  locked_at  timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);
create index if not exists jobs_claim_idx on jobs (status, run_after) where status = 'pending';
