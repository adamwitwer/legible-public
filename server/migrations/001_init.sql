-- Legible — Phase 1 schema.
-- Capture-side tables (pages, note_pages, annotations, jobs) land in Phase 2;
-- their shape depends on the OCR pipeline and is deliberately not guessed here.

create extension if not exists pg_trgm;

-- ---------------------------------------------------------------- notes

-- Every insert AND update takes a new value from this sequence. That is what
-- lets a client ask "what changed since cursor N" and get edits, not just
-- creations. Getting this wrong means edits silently never sync between
-- devices — see AGENTS.md.
create sequence if not exists notes_seq_counter;

create table if not exists notes (
  id                    uuid primary key,          -- client-generated: offline creates replay idempotently
  kind                  text not null default 'typed' check (kind in ('typed','scan')),
  title                 text,
  body                  text not null default '',  -- markdown
  body_ocr_raw          text,                      -- untouched model output; never overwritten by edits
  written_on            date,
  written_on_precision  text check (written_on_precision in ('day','month','year','inferred')),
  tags                  text[] not null default '{}',
  ocr_status            text check (ocr_status in ('pending','running','done','failed')),
  ocr_model             text,
  ocr_run_at            timestamptz,
  confidence            real,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,               -- tombstone; sync must be able to see deletions
  seq                   bigint not null default 0,
  search                tsvector generated always as (
                          setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                          setweight(to_tsvector('english', coalesce(body, '')),  'B')
                        ) stored
);

create or replace function notes_bump_seq() returns trigger as $$
begin
  new.seq := nextval('notes_seq_counter');
  return new;
end;
$$ language plpgsql;

-- updated_at is deliberately NOT set here: last-write-wins compares the value the
-- client sent against the stored one, so the trigger must not clobber it.
drop trigger if exists notes_bump_seq_trigger on notes;
create trigger notes_bump_seq_trigger
  before insert or update on notes
  for each row execute function notes_bump_seq();

create index if not exists notes_search_idx     on notes using gin (search);
create index if not exists notes_body_trgm_idx  on notes using gin (body gin_trgm_ops);
create index if not exists notes_seq_idx        on notes (seq);
create index if not exists notes_written_on_idx on notes (written_on);

-- ------------------------------------------------------- note_revisions

create table if not exists note_revisions (
  id       bigserial primary key,
  note_id  uuid not null references notes(id) on delete cascade,
  title    text,
  body     text not null,
  saved_at timestamptz not null default now()
);
create index if not exists note_revisions_note_idx on note_revisions (note_id, saved_at desc);

-- ------------------------------------------------------------ auth

-- One user. This is a credential store, not an identity system.
create table if not exists credentials (
  id            text primary key,      -- base64url credential ID
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  label         text,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

create table if not exists sessions (
  token       text primary key,        -- random, opaque; stored hashed
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  last_seen_at timestamptz not null default now()
);
create index if not exists sessions_expires_idx on sessions (expires_at);

-- Short-lived WebAuthn challenges.
create table if not exists challenges (
  id         text primary key,
  challenge  text not null,
  kind       text not null check (kind in ('register','authenticate')),
  expires_at timestamptz not null
);
