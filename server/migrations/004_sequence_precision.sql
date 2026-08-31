-- A notebook is written in order, so an undated entry sitting between two dated
-- ones is bounded by them. Carrying the previous entry's date forward recovers
-- roughly three quarters of this archive's dates, which would otherwise be null
-- and unreachable by `before:` / `after:`.
--
-- It gets its own precision rather than reusing 'inferred'. They are different
-- claims: 'inferred' means the page named a month and day and only the year was
-- supplied; 'sequence' means the page named no date at all and this is the last
-- date written before it. Collapsing the two would make the date filters
-- quietly overstate what is known.
alter table notes drop constraint if exists notes_written_on_precision_check;
alter table notes add constraint notes_written_on_precision_check
  check (written_on_precision in ('day', 'month', 'year', 'inferred', 'sequence'));
