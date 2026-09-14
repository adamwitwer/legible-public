/**
 * The command reference, as a panel rather than a status line.
 *
 * It used to be one `setStatus` string in the top-right corner of the header,
 * on the same 2.5s timer as "synced" — dim chrome in the opposite corner from
 * the prompt you are typing into, gone before it is read, and ellipsised at the
 * end. Everything it needed to say was technically there. Nobody could read it.
 *
 * Dismissed by Escape or by typing, never by a timer: this is the one message
 * in the app you are meant to sit and read.
 */
const COMMANDS: [string, string][] = [
  [':new', 'start a typed note — `:new some text` starts it with that text'],
  [':scan', 'open the scan screen (the ⌾ scan button goes straight to the camera)'],
  [':sync', 'push and pull now'],
  [':enroll', 'add a passkey for this device'],
  [':devices', 'list passkeys'],
  [':forget <id>', 'remove a passkey, by an id from :devices'],
  [':logout', 'end the session'],
  [':help', 'this'],
];

const SEARCH: [string, string][] = [
  ['kubernetes retro', 'bare words, fuzzy — searches title, body and tags'],
  ['"exact phrase"', 'must match literally'],
  ['tag:meeting', 'a #tag written in the note'],
  ['is:todo', 'notes with an open TODO'],
  ['is:scan / is:typed', 'photographed pages, or typed notes'],
  ['after:2026-01', 'the date on the page, not the day it was photographed'],
  ['before:2025-06-15', 'filters compose: `is:todo tag:meeting after:2026-01`'],
];

const KEYS: [string, string][] = [
  ['↑ ↓', 'walk the note list — Tab and Shift+Tab do the same'],
  ['enter', 'open the highlighted note; with no match, start a note with what you typed'],
  ['esc', 'back to the prompt, and close whatever is open'],
  ['^p / ^n', 'previous and next query, readline-style'],
  ['⌘S', 'in a note: save now rather than waiting for the autosave'],
];

function Section({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <div className="help-section">
      <h2 className="help-title">{title}</h2>
      <dl className="help-list">
        {rows.map(([term, gloss]) => (
          <div className="help-row" key={term}>
            <dt className="help-term">{term}</dt>
            <dd className="help-gloss">{gloss}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="help">
      <div className="help-head">
        <span>help</span>
        <span className="help-hint">esc or keep typing to close</span>
      </div>

      <div className="help-scroll">
        <Section title="commands" rows={COMMANDS} />
        <Section title="search" rows={SEARCH} />
        <Section title="keys" rows={KEYS} />

        <div className="help-section">
          <h2 className="help-title">todos</h2>
          <p className="help-prose">
            Write <b>TODO</b> in a note — typed, or on the page in your own hand — and it
            gets a <span className="help-mark">[ ]</span> beside its title. Deleting the
            word is how you check it off; there is no separate checked state. A cleared
            TODO comes back from <b>history</b> in the note.
          </p>
        </div>

        <div className="help-section">
          <h2 className="help-title">summaries</h2>
          <p className="help-prose">
            <b>summarize</b> in an open note asks Claude for a paragraph or two about it. Nothing
            is summarized unless you ask. The summary is kept with the note, is never searched,
            and turns <b>stale</b> once the note is edited — <b>resummarize</b> to refresh it.
          </p>
        </div>
      </div>

      <button className="btn help-close" onClick={onClose}>close</button>
    </div>
  );
}
