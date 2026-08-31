import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Auth } from './ui/Auth';
import { Capture } from './ui/Capture';
import { Editor } from './ui/Editor';
import { startRegistration } from '@simplewebauthn/browser';
import { pushHistory as recordHistory, stepHistory } from './lib/history';
import { Devices, type Device } from './ui/Devices';
import { api } from './lib/api';
import { displayDate } from './lib/dates';
import { allLiveNotes, db } from './lib/db';
import { createNote, deleteNote, saveNote, type NotePatch } from './lib/notes';
import { buildIndex, indexSize, search, type Hit } from './lib/search';
import { lastSync, sync } from './lib/sync';
import type { Note } from './lib/types';

type Phase = 'booting' | 'auth' | 'ready';

const fmtAgo = (d: Date | null) => {
  if (!d) return 'never';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

const HISTORY_KEY = 'legible.history';
const HISTORY_MAX = 50;

/** Survives a reload the way a shell's history does. */
function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return []; // private window, or storage disabled
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('booting');
  const [enrolled, setEnrolled] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<Note | null>(null);
  const [capturing, setCapturing] = useState(false);
  // Photos from the one-tap scan, handed to <Capture> so it can start
  // uploading them the moment it mounts.
  const [scanFiles, setScanFiles] = useState<File[] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [history, setHistory] = useState<string[]>(loadHistory);
  // null means "not browsing history"; an index means the query on screen came
  // from it, which is what lets typing drop back out.
  const [histIndex, setHistIndex] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [synced, setSynced] = useState<Date | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [took, setTook] = useState(0);
  const promptRef = useRef<HTMLInputElement>(null);
  // Closing a note re-runs the search, which resets the cursor. Park the id
  // here so the note you just left comes back highlighted instead of the top.
  const selectAfterSearch = useRef<string | null>(null);

  // ---------------------------------------------------------------- boot

  const refresh = useCallback(async () => {
    const notes = await allLiveNotes();
    buildIndex(notes);
    const n = indexSize();
    setCount(n);
    return n; // the boot path needs this now, not on the next render
  }, []);

  const runSync = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setStatus('syncing…');
      const { pushed, pulled } = await sync();
      await refresh();
      setSynced(await lastSync());
      if (!quiet) setStatus(pushed || pulled ? `synced ↑${pushed} ↓${pulled}` : 'up to date');
    } catch (e: any) {
      if (e?.status === 401) { setPhase('auth'); return; }
      if (!quiet) setStatus('offline — working locally');
    }
  }, [refresh]);

  useEffect(() => {
    (async () => {
      const local = await refresh();
      setSynced(await lastSync());
      try {
        const state = await api.authState();
        setEnrolled(state.enrolled);
        if (!state.authenticated) return setPhase('auth');
        setPhase('ready');
        void runSync(true);
      } catch {
        // Server unreachable: still usable against the local replica. `count`
        // is captured from the first render and is always 0 here, so reading it
        // sent every offline boot to the sign-in screen.
        setPhase(local > 0 ? 'ready' : 'auth');
      }
    })();
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    const id = window.setInterval(() => void runSync(true), 120_000);
    const onOnline = () => void runSync(true);
    window.addEventListener('online', onOnline);
    return () => { window.clearInterval(id); window.removeEventListener('online', onOnline); };
  }, [phase, runSync]);

  // -------------------------------------------------------------- search

  useEffect(() => {
    if (phase !== 'ready') return;
    const t0 = performance.now();
    const { hits: h } = search(query);
    setTook(performance.now() - t0);
    setHits(h);
    const want = selectAfterSearch.current;
    selectAfterSearch.current = null;
    const i = want ? h.findIndex((hit) => hit.note.id === want) : -1;
    setCursor(i >= 0 ? i : 0);
  }, [query, phase, count, open]);

  useEffect(() => {
    if (status) {
      // Something that went wrong needs longer than an acknowledgement: 2.5s is
      // enough to confirm a sync, not enough to read a failure and act on it.
      const ms = /failed|not reachable|could not|offline/.test(status) ? 9000 : 2500;
      const id = window.setTimeout(() => setStatus(null), ms);
      return () => window.clearTimeout(id);
    }
  }, [status]);

  const pushHistory = useCallback((raw: string) => {
    const entry = raw.trim();
    if (!entry) return;
    setHistory((prev) => {
      const next = recordHistory(prev, entry, HISTORY_MAX);
      if (next === prev) return prev;
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ---------------------------------------------------------------- scan

  /**
   * Opening the scan screen, from `:scan` with nothing in hand or from the
   * camera button with the first photos already taken.
   *
   * The prompt gives up focus on the way in. It is what made this screen land
   * blank on a phone: it keeps focus through the transition, iOS scrolls the
   * focused input into view, and the scan controls at the top of the screen go
   * up and out of sight with it.
   */
  const startScan = useCallback((files: File[] | null) => {
    setScanFiles(files);
    setCapturing(true);
    setQuery('');
    promptRef.current?.blur();
  }, []);

  const endScan = useCallback(() => {
    setCapturing(false);
    setScanFiles(null);
  }, []);

  // The prompt unmounts while scanning, so focus has to be handed back when it
  // returns — otherwise it falls to <body> and the arrow keys go dead. Not on a
  // phone, where refocusing only reopens the keyboard over the note list.
  useEffect(() => {
    if (phase !== 'ready' || capturing) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;
    promptRef.current?.focus();
  }, [capturing, phase]);

  // ------------------------------------------------------------ commands

  async function runCommand(raw: string): Promise<boolean> {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    switch (cmd) {
      case 'new': {
        const note = await createNote(rest.length ? { body: rest.join(' ') } : {});
        await refresh();
        setQuery('');
        setOpen(note);
        return true;
      }
      case 'sync':   void runSync(); setQuery(''); return true;
      case 'logout': await api.logout(); setPhase('auth'); return true;
      case 'scan':   startScan(null); return true;
      case 'enroll': {
        // Adds a passkey for the machine you are already signed in on. The
        // enroll code only works while no credential exists at all, so this
        // session is what authorises the second device.
        setQuery('');
        setStatus('waiting for passkey…');
        try {
          const options = await api.registerStart();
          const response = await startRegistration({ optionsJSON: options });
          await api.registerFinish(response, navigator.platform || 'device');
          setStatus('this device is enrolled');
        } catch (e: any) {
          setStatus(
            e?.name === 'InvalidStateError'
              ? 'this device already has a passkey'
              : `enroll failed: ${e?.message ?? 'unknown error'}`,
          );
        }
        return true;
      }
      case 'devices': {
        setQuery('');
        setDevices(await api.credentials());
        return true;
      }
      case 'forget': {
        setQuery('');
        if (!rest[0]) { setStatus('usage: :forget <id from :devices>'); return true; }
        try {
          const { remaining } = await api.forgetCredential(rest[0]);
          if (devices) setDevices(await api.credentials());
          setStatus(
            remaining === 0
              ? 'passkey removed — none left; :enroll now, or the enroll code works again'
              : `passkey removed — ${remaining} left`,
          );
        } catch (e: any) {
          setStatus(`could not remove: ${e?.message ?? 'unknown error'}`);
        }
        return true;
      }
      case 'help':
        setStatus(':new  :scan  :sync  :enroll  :devices  :forget  :logout  ·  ↑↓ notes  ·  ^p/^n history  ·  tag: is: after: before: "phrase"');
        setQuery('');
        return true;
      default:
        setStatus(`unknown command: :${cmd}`);
        return true;
    }
  }

  async function onPromptKey(e: React.KeyboardEvent<HTMLInputElement>) {
    // History lives on ctrl-p/ctrl-n rather than the arrows: the main screen
    // shows the note list with an empty prompt, and up there has to walk the
    // notes. readline uses the same pair, so this is if anything more terminal.
    if (e.ctrlKey && (e.key === 'p' || e.key === 'n')) {
      e.preventDefault();
      const step = stepHistory(history, histIndex, e.key === 'p' ? 'back' : 'forward');
      if (!step) return;
      setHistIndex(step.index);
      setQuery(step.query);
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, hits.length - 1)); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
    if (e.key === 'Escape')    {
      pushHistory(query);
      setHistIndex(null);
      if (capturing) setCapturing(false);
      setDevices(null);
      setQuery('');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      pushHistory(query);
      setHistIndex(null);
      if (query.startsWith(':')) { await runCommand(query.trim()); return; }
      const hit = hits[cursor];
      if (hit) setOpen(hit.note);
      else if (query.trim()) {
        // Nothing matched — offer the query as the start of a new note.
        const note = await createNote({ body: query.trim() });
        await refresh();
        setQuery('');
        setOpen(note);
      }
    }
  }

  const onEdit = useCallback(async (patch: NotePatch) => {
    if (!open) return;
    const updated = await saveNote(open.id, patch);
    if (updated) { setOpen(updated); setCount(indexSize()); }
  }, [open]);

  const closeNote = useCallback(() => {
    if (open) selectAfterSearch.current = open.id;
    setOpen(null);
    // The prompt is always mounted, so this lands before the editor unmounts —
    // without it focus falls to <body> and the arrow keys go dead.
    promptRef.current?.focus();
  }, [open]);

  const onSplit = useCallback(async (at: number) => {
    if (!open) return;
    const id = open.id;
    setStatus('splitting…');
    // sync() rather than runSync(): runSync swallows failures, and splitting a
    // body the server has not received yet would cut in the wrong place.
    try {
      await sync();
    } catch {
      setStatus('split needs the server, and it is not reachable — try again when back online');
      return;
    }
    try {
      const res = await api.splitNote(id, at);
      await sync();
      await refresh();
      setSynced(await lastSync());
      selectAfterSearch.current = res.id;
      setOpen(null);
      promptRef.current?.focus();
      setStatus(
        res.pages_divided === false && res.pages
          ? `split — pages could not be divided, both notes keep all ${res.pages}`
          : `split off “${res.title ?? 'untitled'}”`,
      );
    } catch (e: any) {
      setStatus(`split failed: ${e?.detail ?? e?.message ?? 'unknown error'}`);
    }
  }, [open, refresh]);

  const onDelete = useCallback(async () => {
    if (!open) return;
    await deleteNote(open.id);
    setOpen(null);
    await refresh();
    promptRef.current?.focus();
    setStatus('deleted');
  }, [open, refresh]);

  // ---------------------------------------------------------------- view

  if (phase === 'booting') return <div className="booting">booting…</div>;
  if (phase === 'auth') {
    return <Auth enrolled={enrolled} onDone={async () => { setPhase('ready'); await runSync(); }} />;
  }

  return (
    <div className="app">
      <header className="bar">
        <span className="bar-brand">notes ~</span>
        <span className="bar-count">{count.toLocaleString()} notes</span>
        <span className="bar-rule" />
        {/* Which build is on the screen. On a phone there is no other way to
            tell a stale bundle from a change that did not work. */}
        <span className="bar-build" title={`build ${__BUILD_ID__}`}>
          {__BUILD_ID__.split('·')[0]}
        </span>
        <span className="bar-sync">{status ?? `last sync ${fmtAgo(synced)}`}</span>
      </header>

      {devices ? (
        <Devices devices={devices} onClose={() => setDevices(null)} />
      ) : capturing ? (
        <Capture
          initialFiles={scanFiles}
          onCancel={endScan}
          onDone={async (created) => {
            endScan();
            await runSync();
            setStatus(`${created} note${created === 1 ? '' : 's'} added from scan`);
          }}
        />
      ) : open ? (
        <Editor note={open} onChange={onEdit} onClose={closeNote} onDelete={onDelete} onSplit={onSplit} />
      ) : (
        <Results
          hits={hits}
          cursor={cursor}
          onPick={(n) => setOpen(n)}
          onCursor={setCursor}
          onType={(ch) => { setQuery((q) => q + ch); setHistIndex(null); promptRef.current?.focus(); }}
          onEscape={() => promptRef.current?.focus()}
          query={query}
        />
      )}

      {/* The scan screen gets the whole height and none of the keyboard: there
          is nothing to type there, and a focused input on a phone costs half
          the screen. Escape is handled inside <Capture> instead. */}
      {!capturing && (
        <footer className="prompt">
          <span className="prompt-caret">&gt;</span>
          <input
            ref={promptRef}
            className="prompt-input"
            value={query}
            placeholder={open ? 'esc to return to search' : 'type to search · :help'}
            autoFocus
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => { setQuery(e.target.value); setHistIndex(null); }}
            onKeyDown={onPromptKey}
          />
          {/* One tap from the note list to the camera. The button is the file
              input's own label so the picker opens inside the tap itself —
              routing through a screen first, or calling .click() afterwards,
              loses the user gesture on iOS and the camera never opens.

              Not while a note is open: scanning unmounts the editor, and an
              edit typed in the last 400ms is still sitting in its debounce.
              Every other way out of the editor flushes first; this one has no
              way to. :scan is still there for anyone who wants it from here. */}
          {!open && (
            <>
              <input
                id="scan-now"
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = ''; // so the same page can be shot again
                  if (files.length) startScan(files);
                }}
              />
              <label
                htmlFor="scan-now"
                className="prompt-scan"
                title="photograph pages (:scan opens the scan screen empty-handed)"
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.currentTarget.click(); // still inside the gesture, so iOS allows it
                  }
                }}
              >
                ⌾ scan
              </label>
            </>
          )}
          <span className="prompt-meta">
            {hits.length} {hits.length === 1 ? 'hit' : 'hits'} · {took < 1 ? '<1' : took.toFixed(0)} ms
          </span>
        </footer>
      )}
    </div>
  );
}

function Results({
  hits, cursor, onPick, onCursor, onType, onEscape, query,
}: {
  hits: Hit[];
  cursor: number;
  onPick: (n: Note) => void;
  onCursor: (i: number) => void;
  onType: (ch: string) => void;
  onEscape: () => void;
  query: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  if (!hits.length) {
    return (
      <div className="results empty">
        {query.trim()
          ? <>no match for <b>{query}</b> — <span className="dim">enter starts a note with it</span></>
          : <>no notes yet — <span className="dim">type something and press enter, or :new</span></>}
      </div>
    );
  }

  return (
    <div
      className="results"
      ref={ref}
      onKeyDown={(e) => {
        // Only fires when a hit itself holds focus — arriving by Tab or click.
        // The prompt has its own handler and never reaches this.
        const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
        if (step) {
          e.preventDefault();
          const next = Math.min(Math.max(cursor + step, 0), hits.length - 1);
          onCursor(next);
          const buttons = ref.current?.querySelectorAll<HTMLButtonElement>('.hit');
          buttons?.[next]?.focus();
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); onEscape(); return; }
        // Typing anywhere belongs to the prompt. Route the character rather
        // than only moving focus, which would drop the keystroke that caused it.
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          onType(e.key);
        }
      }}
    >
      {hits.map((h, i) => (
        <button
          key={h.note.id}
          data-active={i === cursor}
          className="hit"
          onFocus={() => onCursor(i)}
          onClick={() => onPick(h.note)}
        >
          <span className="hit-date">{displayDate(h.note)}</span>
          <span className="hit-title">{h.note.title ?? <em className="dim">untitled</em>}</span>
          <span className="hit-kind">{h.note.kind}</span>
          <span className="hit-snippet">{h.snippet}</span>
        </button>
      ))}
    </div>
  );
}
