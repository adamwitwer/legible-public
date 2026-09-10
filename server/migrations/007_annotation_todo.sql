-- A margin "TODO" is a fifth kind of annotation, and it needed naming rather
-- than folding into 'note'. The other four describe what a scrap of margin text
-- *is* — a speaker, a question, a qualifier. 'todo' also says the note has
-- outstanding work on it, which is the thing the manifest indicator reads, and
-- 'note' is the bucket everything unclassified already falls into, so reusing
-- it would make every stray margin remark look like a task.
alter table annotations drop constraint if exists annotations_kind_check;
alter table annotations add constraint annotations_kind_check
  check (kind in ('speaker', 'question', 'qualifier', 'note', 'todo'));
