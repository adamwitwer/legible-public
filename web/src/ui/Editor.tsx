import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { bodyHash } from '../lib/summary';
import type { NotePatch } from '../lib/notes';
import type { Note } from '../lib/types';

/** How a date was arrived at, when it was not simply written on the page. */
const PRECISION_HINT: Record<string, string> = {
  inferred: 'the page gave a month and day; the year came from the notebook',
  sequence: 'no date on the page — carried forward from the last dated note before it',
  month: 'the page named a month, not a day',
  year: 'the page named only a year',
};

export function Editor({
  note,
  onChange,
  onClose,
  onDelete,
  onSplit,
  summarizing,
  onSummarize,
  onClearSummary,
}: {
  note: Note;
  onChange: (patch: NotePatch) => void;
  onClose: () => void;
  onDelete: () => void;
  onSplit: (at: number) => void;
  summarizing: boolean;
  onSummarize: () => void;
  onClearSummary: () => void;
}) {
  const [body, setBody] = useState(note.body);
  const [title, setTitle] = useState(note.title ?? '');
  const [date, setDate] = useState(note.written_on ?? '');
  const [saved, setSaved] = useState(true);
  const [revisions, setRevisions] = useState<{ id: string; body: string; saved_at: string }[] | null>(null);
  const [liveHash, setLiveHash] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number>(0);

  // Hash what is on screen, including typing not yet saved, so "stale" shows
  // the moment the note stops matching its summary rather than after autosave.
  useEffect(() => {
    if (!note.summary) return;
    let cancelled = false;
    void bodyHash(body).then((h) => { if (!cancelled) setLiveHash(h); });
    return () => { cancelled = true; };
  }, [body, note.summary, note.summary_body_hash]);
  // Unknown (not yet hashed, or no SubtleCrypto) is not stale.
  const stale = !!note.summary && liveHash !== null && liveHash !== note.summary_body_hash;

  useEffect(() => {
    setBody(note.body);
    setTitle(note.title ?? '');
    setDate(note.written_on ?? '');
    setSaved(true);
    setRevisions(null);
    setLiveHash(null);
    ref.current?.focus();
    // Put the caret at the end rather than the start.
    const el = ref.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, [note.id]);

  // Debounced autosave — the archive should never lose an edit to a closed tab.
  useEffect(() => {
    if (body === note.body) return;
    setSaved(false);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      onChange({ body });
      setSaved(true);
    }, 400);
    return () => window.clearTimeout(timer.current);
  }, [body]);

  function flush() {
    window.clearTimeout(timer.current);
    if (body !== note.body) onChange({ body });
    setSaved(true);
  }

  /**
   * Title and date commit on blur or Enter rather than per keystroke: the server
   * snapshots a revision on every applied write, so debounced typing would bury
   * the history under one entry per character.
   */
  function commitTitle() {
    if ((title.trim() || null) !== note.title) onChange({ title: title.trim() || null });
  }

  /**
   * The date field holds its own state while you type. Binding value straight to
   * note.written_on re-renders the input between segments, so React keeps
   * restoring the stored date underneath the keystrokes and you end up with a
   * date you did not enter. A <input type="date"> reports '' until all three
   * segments are filled, so committing only a complete value also avoids writing
   * a null every time the field is half-entered.
   */
  function commitDate(next: string) {
    setDate(next);
    if (next === '' && note.written_on === null) return;
    if (next !== '' && next === note.written_on) return;
    onChange({ written_on: next || null });
  }

  async function loadRevisions() {
    if (revisions) return setRevisions(null);
    try {
      const { revisions: r } = await api.revisions(note.id);
      setRevisions(r);
    } catch {
      setRevisions([]);
    }
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        <input
          className="editor-title"
          value={title}
          placeholder="untitled"
          aria-label="note title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitTitle(); ref.current?.focus(); }
            if (e.key === 'Escape') { e.preventDefault(); setTitle(note.title ?? ''); }
          }}
        />
        <input
          type="date"
          className="editor-dateinput"
          value={date}
          aria-label="date written"
          onChange={(e) => commitDate(e.target.value)}
          onBlur={() => setDate(note.written_on ?? '')}
        />
        {note.written_on && note.written_on_precision !== 'day' && PRECISION_HINT[note.written_on_precision ?? ''] && (
          <span className="badge" title={PRECISION_HINT[note.written_on_precision ?? '']}>
            {note.written_on_precision === 'sequence' ? 'from order' : note.written_on_precision}
          </span>
        )}
        <span className={`editor-status ${saved ? 'ok' : 'pending'}`}>
          {saved ? 'saved' : 'saving…'}
        </span>
        <div className="editor-actions">
          <button
            className="linkish"
            disabled={summarizing}
            title="a short AI summary, kept with this note — never searched"
            onClick={() => { flush(); onSummarize(); }}
          >
            {summarizing ? 'summarizing…' : note.summary ? 'resummarize' : 'summarize'}
          </button>
          <button className="linkish" onClick={loadRevisions}>
            {revisions ? 'hide history' : 'history'}
          </button>
          <button
            className="linkish"
            title="break this note in two at the cursor"
            onClick={() => {
              const at = ref.current?.selectionStart ?? 0;
              flush(); // the server splits its own copy, so push this one first
              onSplit(at);
            }}
          >
            split here
          </button>
          <button className="linkish danger" onClick={onDelete}>delete</button>
          <button className="linkish editor-back" onClick={() => { flush(); onClose(); }}>
            {/* On a phone there is no Esc key and no obvious way back, so this
                reads as a back control and is ordered first. */}
            <span className="narrow-only">‹ notes</span>
            <span className="wide-only">close (esc)</span>
          </button>
        </div>
      </div>

      {/* The summary and the body share the grid's one flexible row, so the
          layout is unchanged for the notes that have no summary — which is
          most of them, since a summary only exists when asked for. */}
      <div className="editor-main">
      {(note.summary || summarizing) && (
        <section className={`summary${stale ? ' summary-is-stale' : ''}`} aria-label="summary">
          <div className="summary-head">
            <span className="summary-label">summary</span>
            {summarizing ? (
              <span className="summary-meta">writing…</span>
            ) : stale ? (
              <span className="summary-meta summary-stale" title="the note has been edited since this was written">
                stale — the note has changed
              </span>
            ) : (
              <span className="summary-meta" title={note.summary_model ?? undefined}>
                {note.summarized_at ? new Date(note.summarized_at).toLocaleDateString() : ''}
              </span>
            )}
            {!summarizing && note.summary && (
              <button className="linkish summary-remove" onClick={onClearSummary}>remove</button>
            )}
          </div>
          {note.summary && (
            <div className="summary-text">
              {note.summary.split(/\n\s*\n/).map((para, i) => <p key={i}>{para}</p>)}
            </div>
          )}
        </section>
      )}
      <textarea
        ref={ref}
        className="editor-body"
        value={body}
        spellCheck
        placeholder="First line becomes the title. #tags work anywhere."
        onChange={(e) => setBody(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); flush(); onClose(); }
          if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); flush(); }
        }}
      />
      </div>

      {revisions && (
        <div className="revisions">
          <div className="revisions-head">history · {revisions.length}</div>
          {revisions.length === 0 && <div className="revisions-empty">no earlier versions yet</div>}
          {revisions.map((r) => (
            <button
              key={r.id}
              className="revision"
              title="restore this version into the editor"
              onClick={() => setBody(r.body)}
            >
              <span className="revision-when">{new Date(r.saved_at).toLocaleString()}</span>
              <span className="revision-peek">{r.body.replace(/\s+/g, ' ').slice(0, 80) || '(empty)'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
