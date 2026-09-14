-- An AI summary a note carries only when asked for one.
--
-- Its own columns, never the body. The body is what was written: tags and TODOs
-- derive from it, search indexes it, history snapshots it. A summary in there
-- would put words in the archive that were never written and make them
-- searchable as if they had been. The generated `search` column is untouched,
-- so summaries stay out of server-side search too.
--
-- summary_body_hash is the SHA-256 of the body the summary was made from. The
-- client hashes the body it is showing and compares, so an edit after the fact
-- reads as "stale" rather than the summary silently describing an older note.
--
-- Written server-side only, and never with updated_at: see routes/notes.ts.
alter table notes add column if not exists summary           text;
alter table notes add column if not exists summary_body_hash text;
alter table notes add column if not exists summary_model     text;
alter table notes add column if not exists summarized_at     timestamptz;
