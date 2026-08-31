import { useEffect, useRef, useState } from 'react';
import { api, pageImageUrl } from '../lib/api';

type PageRow = { id: string; idx: number; ocr_status: string; confidence: number | null; error: string | null; blocks: number };
type Proposed = {
  title: string | null;
  body: string;
  writtenOn: string | null;
  writtenOnPrecision: string | null;
  dateText: string | null;
  pages: { pageId: string; idx: number; startsAt: string | null }[];
  annotations: { side: string; rotation: number; kind: string; anchor: string | null; text: string }[];
  /** Client-side only: left out of the commit. Never sent to the server. */
  dropped?: boolean;
};

/** What a commit would actually create: everything not discarded, without the flag. */
function kept(list: Proposed[]): Proposed[] {
  return list.filter((n) => !n.dropped).map(({ dropped: _dropped, ...n }) => n);
}

export function Capture({
  onDone,
  onCancel,
  initialFiles,
}: {
  onDone: (created: number) => void;
  onCancel: () => void;
  /** Photos already taken, when the scan started from the camera rather than :scan. */
  initialFiles?: File[] | null;
}) {
  const [batchId, setBatchId] = useState<string | null>(null);
  const [pages, setPages] = useState<PageRow[]>([]);
  const [proposed, setProposed] = useState<Proposed[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const poll = useRef<number>(0);
  // A poll can be in flight when an upload reopens the batch. Its reply still says
  // "review" and would drag the screen back to stale boundaries, so ignore replies
  // that land while pages are going up.
  const uploading = useRef(false);

  async function ensureBatch(): Promise<string> {
    if (batchId) return batchId;
    const b = await api.createBatch();
    setBatchId(b.id);
    return b.id;
  }

  async function onFiles(list: FileList | File[] | null) {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    setBusy(true);
    uploading.current = true;
    // Adding a page invalidates the proposed boundaries — the server drops them and
    // re-derives over every page — so leave review and watch the pages read again.
    setProposed(null);
    try {
      const id = await ensureBatch();
      // Sequential so page order matches shot order — idx is assigned server-side.
      for (const [i, file] of files.entries()) {
        setStatus(`uploading ${i + 1} of ${files.length}…`);
        await api.uploadPage(id, file, new Date(file.lastModified).toISOString());
      }
      setStatus('reading pages…');
    } catch (e: any) {
      setStatus(`upload failed: ${e.message}`);
    } finally {
      setBusy(false);
      uploading.current = false;
      // Polling stops once boundaries arrive; adding pages starts it again.
      setRound((r) => r + 1);
      if (fileRef.current) fileRef.current.value = '';
      if (libraryRef.current) libraryRef.current.value = '';
    }
  }

  // A one-tap scan opens the camera from the note list, so the first photos are
  // already in hand by the time this screen mounts. Upload them without waiting
  // for a second tap on a picker.
  const startedWith = useRef(false);
  useEffect(() => {
    if (startedWith.current || !initialFiles?.length) return;
    startedWith.current = true;
    void onFiles(initialFiles);
  }, [initialFiles]);

  // The prompt no longer holds focus while this screen is up (it is a keyboard
  // trap on a phone and does nothing here), so Escape has to be caught on the
  // window instead of in the prompt's key handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Not while a transcript is being corrected: Escape there should do
      // nothing, not throw the whole review away.
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return;
      onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Poll while OCR runs. The pages appear immediately; text fills in behind them.
  useEffect(() => {
    if (!batchId) return;
    const tick = async () => {
      try {
        const b = await api.batch(batchId);
        if (uploading.current) return;
        setPages(b.pages);
        if (b.batch.status === 'review' && b.proposed?.length) {
          setProposed(b.proposed);
          setStatus('');
          window.clearInterval(poll.current);
        }
      } catch { /* keep polling */ }
    };
    poll.current = window.setInterval(tick, 1500);
    void tick();
    return () => window.clearInterval(poll.current);
  }, [batchId, round]);

  const done = pages.filter((p) => p.ocr_status === 'done').length;
  const failed = pages.filter((p) => p.ocr_status === 'failed');

  async function commit() {
    if (!batchId || !proposed) return;
    const keeping = kept(proposed);
    if (!keeping.length) return;
    setBusy(true);
    try {
      const { created } = await api.commitBatch(batchId, keeping);
      onDone(created.length);
    } catch (e: any) {
      setStatus(`commit failed: ${e.message}`);
      setBusy(false);
    }
  }

  /**
   * The note a "merge up" would land in: the nearest one above that is still
   * being kept. Merging into a discarded note would quietly throw both away.
   */
  function targetAbove(i: number): number {
    if (!proposed) return -1;
    for (let j = i - 1; j >= 0; j--) if (!proposed[j]!.dropped) return j;
    return -1;
  }

  function mergeUp(i: number) {
    if (!proposed) return;
    const j = targetAbove(i);
    if (j < 0) return;
    const next = [...proposed];
    // j < i, so splicing i out leaves j pointing at the same note.
    const [note] = next.splice(i, 1);
    const prev = next[j]!;
    next[j] = {
      ...prev,
      body: `${prev.body}\n\n${note!.body}`.trim(),
      pages: [...prev.pages, ...note!.pages.filter((p) => !prev.pages.some((q) => q.pageId === p.pageId))],
      annotations: [...prev.annotations, ...note!.annotations],
    };
    setProposed(next);
  }

  function update(i: number, patch: Partial<Proposed>) {
    if (!proposed) return;
    const next = [...proposed];
    next[i] = { ...next[i]!, ...patch };
    setProposed(next);
  }

  // Both pickers are mounted on both screens: pages can be added during review too,
  // because on a phone review arrives while you are still holding the camera.
  // They are separate inputs because `capture` is not a hint — on iOS it opens the
  // camera and takes the photo library away, so one control cannot be both.
  const pickers = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(e) => onFiles(e.target.files)}
        id="capture-input"
        hidden
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(e) => onFiles(e.target.files)}
        id="capture-library"
        hidden
      />
    </>
  );

  // --- review -------------------------------------------------------------

  if (proposed) {
    const keeping = kept(proposed);
    const dropped = proposed.length - keeping.length;
    return (
      <div className="capture">
        {pickers}
        <div className="capture-bar">
          <span className="capture-title">review boundaries</span>
          <span className="dim">
            {keeping.length} {keeping.length === 1 ? 'note' : 'notes'} from {pages.length} pages
            {dropped > 0 && `, ${dropped} discarded`}
          </span>
        </div>

        <div className="capture-scroll review">
          {proposed.map((n, i) => {
            // A discarded note collapses to one line rather than leaving the list.
            // Nothing is lost until save, so this is undoable by tapping "keep" —
            // better than a confirm on a phone, where the transcript it holds is
            // the only copy of that reading.
            if (n.dropped) {
              return (
                <div className="proposed dropped" key={i}>
                  <div className="proposed-head">
                    <span className="dropped-title">{n.title || firstLine(n.body) || 'untitled'}</span>
                    <span className="badge">discarded</span>
                    <span className="proposed-acts">
                      <button className="linkish" onClick={() => update(i, { dropped: false })}>
                        keep
                      </button>
                    </span>
                  </div>
                </div>
              );
            }
            return (
            <div className="proposed" key={i}>
              <div className="proposed-head">
                <input
                  className="proposed-title"
                  value={n.title ?? ''}
                  placeholder="untitled"
                  onChange={(e) => update(i, { title: e.target.value || null })}
                />
                <input
                  className="proposed-date"
                  value={n.writtenOn ?? ''}
                  placeholder="yyyy-mm-dd"
                  onChange={(e) => update(i, { writtenOn: e.target.value || null, writtenOnPrecision: 'day' })}
                />
                {n.writtenOnPrecision === 'inferred' && (
                  <span className="badge" title={`the page said "${n.dateText}" with no year`}>year inferred</span>
                )}
                {n.writtenOnPrecision === 'sequence' && (
                  <span className="badge" title="no date on the page — carried forward from the last dated note before it">
                    from order
                  </span>
                )}
                <span className="proposed-acts">
                  {targetAbove(i) >= 0 && (
                    <button className="linkish" onClick={() => mergeUp(i)} title="join this into the note above">
                      merge up
                    </button>
                  )}
                  <button
                    className="linkish danger"
                    onClick={() => update(i, { dropped: true })}
                    title="leave this one out — the other notes still save"
                  >
                    discard
                  </button>
                </span>
              </div>

              <div className="proposed-pages">
                {n.pages.map((p) => (
                  <a key={p.pageId} href={pageImageUrl(p.pageId)} target="_blank" rel="noreferrer" title={p.startsAt ? `starts partway down: "${p.startsAt}"` : undefined}>
                    <img src={pageImageUrl(p.pageId)} alt={`page ${p.idx + 1}`} />
                    {p.startsAt && <span className="midpage">starts mid-page</span>}
                  </a>
                ))}
              </div>

              <TranscriptBox value={n.body} onChange={(body) => update(i, { body })} />

              {n.annotations.length > 0 && (
                <div className="margin-notes">
                  {n.annotations.map((a, j) => (
                    <span className="margin-note" key={j} title={a.anchor ? `beside: ${a.anchor}` : undefined}>
                      <b>{a.kind}</b> {a.text}
                      {a.rotation ? <i> ({a.rotation}°)</i> : null}
                    </span>
                  ))}
                </div>
              )}
            </div>
            );
          })}
        </div>

        {/* Saving is the end of a scroll through every proposed note, so the
            button that ends it stays in the thumb's reach rather than back at
            the top of the screen. */}
        <div className="capture-foot">
          {/* "discard all" since individual notes now have a discard of their own. */}
          <button className="linkish" onClick={onCancel}>discard all</button>
          <label htmlFor="capture-input" className="linkish" title="boundaries are re-derived over every page">
            add pages
          </label>
          <button className="btn capture-primary" onClick={commit} disabled={busy || !keeping.length}>
            {busy ? 'saving…' : keeping.length ? `save ${keeping.length}` : 'nothing kept'}
          </button>
        </div>
      </div>
    );
  }

  // --- capture ------------------------------------------------------------

  return (
    <div className="capture">
      {pickers}
      <div className="capture-bar">
        <span className="capture-title">scan pages</span>
        <span className="dim">{status || (pages.length ? `${done} of ${pages.length} read` : 'shoot pages in order')}</span>
      </div>

      <div className="capture-scroll">
        {pages.length > 0 && (
          <div className="filmstrip">
            {pages.map((p) => (
              <div className={`frame ${p.ocr_status}`} key={p.id}>
                <img src={pageImageUrl(p.id)} alt={`page ${p.idx + 1}`} />
                <span className="frame-status">
                  {p.ocr_status === 'done' ? `${p.blocks} block${p.blocks === 1 ? '' : 's'}` : p.ocr_status}
                </span>
              </div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <p className="capture-error">{failed.length} page(s) failed: {failed[0]!.error}</p>
        )}

        <p className="dim capture-hint">
          Shoot pages in order. A note can span several pages — boundaries are proposed for you to check.
          {' '}
          <label htmlFor="capture-library" className="linkish">or choose images already taken</label>
        </p>
      </div>

      {/* Two controls only: the way out, and the one you came here to press.
          A third would wrap onto two lines at 320px. */}
      <div className="capture-foot">
        <button className="linkish" onClick={onCancel}>cancel<span className="wide-only"> (esc)</span></button>
        <label htmlFor="capture-input" className="btn capture-primary">
          {pages.length ? 'add pages' : 'take photo'}
        </label>
      </div>
    </div>
  );
}

/**
 * The transcript, in a box that grows to fit it.
 *
 * A fixed-height textarea puts a scroll region inside a screen that is already
 * scrolling, which on a phone means the review list stops moving under your
 * thumb whenever it lands on a transcript. Height is set from the content
 * instead, and the page scrolls as one.
 */
function TranscriptBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.height = 'auto';
      // scrollHeight is the content box; add back what the borders take, or the
      // box lands a hair short and scrolls by two pixels forever.
      el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
    };
    fit();
    // Plex is a webfont and lands after first paint. Its metrics are not the
    // fallback's, so a box measured before the swap is measured against the
    // wrong text and comes out short.
    void document.fonts?.ready.then(fit);
  }, [value]);
  return (
    <textarea
      ref={ref}
      className="proposed-body"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Enough of a transcript to recognise which note a collapsed row is. */
function firstLine(body: string): string {
  const line = body.split('\n').find((l) => l.trim())?.trim() ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
