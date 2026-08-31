import type { OcrBlock, OcrResult } from './ocr.js';

export type PageOcr = { pageId: string; idx: number; shotAt: string | null; ocr: OcrResult };

export type ProposedNote = {
  title: string | null;
  body: string;
  writtenOn: string | null;
  writtenOnPrecision: 'day' | 'month' | 'year' | 'inferred' | 'sequence' | null;
  dateText: string | null;
  pages: { pageId: string; idx: number; startsAt: string | null }[];
  annotations: (OcrResult['annotations'][number] & { pageId: string })[];
};

/** Headers are often written with a trailing dash: "Tell me ——", "Q4 time ——". */
const cleanTitle = (t: string | null): string | null => {
  if (!t) return null;
  const trimmed = t.replace(/[\s\u2013\u2014_-]+$/u, '').trim();
  return trimmed || null;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Resolve "Aug 1" — which is what these pages actually carry — into a date.
 * Order: an explicit year on the page, then the year implied by when the batch
 * was shot, then null. Precision records which of those happened, so `before:`
 * and `after:` can stay honest and the UI can show a guess differently.
 */
export function resolveDate(
  dateText: string | null,
  precision: OcrBlock['date_precision'],
  fallback: Date | null,
): { date: string | null; precision: ProposedNote['writtenOnPrecision'] } {
  if (!dateText) return { date: null, precision: null };

  const explicitYear = /\b(19|20)\d{2}\b/.exec(dateText);
  const monthMatch = /\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/i.exec(dateText);
  const numeric = /\b(\d{1,2})[/-](\d{1,2})(?:[/-]((?:19|20)?\d{2}))?\b/.exec(dateText);

  const pad = (n: number) => String(n).padStart(2, '0');
  const fallbackYear = fallback ? fallback.getFullYear() : null;

  if (monthMatch) {
    const month = MONTHS[monthMatch[1]!.toLowerCase()];
    const day = Number(monthMatch[2]);
    if (month && day >= 1 && day <= 31) {
      const year = explicitYear ? Number(explicitYear[0]) : fallbackYear;
      if (!year) return { date: null, precision: null };
      return {
        date: `${year}-${pad(month)}-${pad(day)}`,
        precision: explicitYear ? 'day' : 'inferred',
      };
    }
  }

  if (numeric) {
    const month = Number(numeric[1]);
    const day = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : fallbackYear;
    if (year && year < 100) year += 2000;
    if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { date: `${year}-${pad(month)}-${pad(day)}`, precision: numeric[3] ? 'day' : 'inferred' };
    }
  }

  // A bare month, or a year on its own.
  const bareMonth = /\b([a-z]{3})[a-z]*\b/i.exec(dateText);
  if (bareMonth && MONTHS[bareMonth[1]!.toLowerCase()]) {
    const year = explicitYear ? Number(explicitYear[0]) : fallbackYear;
    if (year) {
      return {
        date: `${year}-${pad(MONTHS[bareMonth[1]!.toLowerCase()]!)}-01`,
        precision: explicitYear ? 'month' : 'inferred',
      };
    }
  }
  if (explicitYear) return { date: `${explicitYear[0]}-01-01`, precision: 'year' };

  return { date: null, precision: null };
}

/**
 * Fold per-page OCR into proposed notes. A page contributes its blocks in reading
 * order; a block with starts_note begins a new note, so one page can close one
 * note and open another — which sample page 8 actually does.
 */
export function segment(pages: PageOcr[]): ProposedNote[] {
  const notes: ProposedNote[] = [];
  const ordered = [...pages].sort((a, b) => a.idx - b.idx);

  for (const page of ordered) {
    const fallback = page.shotAt ? new Date(page.shotAt) : null;
    const blocks = page.ocr.blocks ?? [];

    for (const block of blocks) {
      const current = notes[notes.length - 1];
      // A new note must carry a date. A bare name — however heading-like it looks — is a
      // subject inside the note already in progress. Enforced here as well as in the
      // prompt so it is a property of the data rather than of the model's judgement on
      // the day, and so it can be re-derived over an existing batch without re-reading a
      // page. The very first block has nothing to continue, so it always opens a note.
      const startsNew = (block.starts_note && !!block.date_text) || !current;

      if (startsNew) {
        const { date, precision } = resolveDate(block.date_text, block.date_precision, fallback);
        notes.push({
          title: cleanTitle(block.title),
          body: block.transcript.trim(),
          writtenOn: date,
          writtenOnPrecision: precision,
          dateText: block.date_text,
          // Only a note that begins partway down a page records an anchor.
          pages: [{
            pageId: page.pageId,
            idx: page.idx,
            startsAt: blocks.indexOf(block) > 0 ? block.transcript.slice(0, 80) : null,
          }],
          annotations: [],
        });
      } else {
        current!.body = `${current!.body}\n\n${block.transcript.trim()}`.trim();
        if (!current!.pages.some((p) => p.pageId === page.pageId)) {
          current!.pages.push({ pageId: page.pageId, idx: page.idx, startsAt: null });
        }
      }
    }

    // Assign margin notes by their anchor, not by page. On a page carrying a
    // boundary, marginalia above the split belongs to the earlier note: a margin
    // note anchored to a line in the upper block stays with the note that block
    // belongs to, even though a different note is what the page ends on.
    const onThisPage = notes.filter((n) => n.pages.some((p) => p.pageId === page.pageId));
    for (const a of page.ocr.annotations ?? []) {
      const byAnchor = a.anchor
        ? onThisPage.find((n) => n.body.toLowerCase().includes(a.anchor!.toLowerCase().slice(0, 40)))
        : undefined;
      const owner = byAnchor ?? onThisPage[onThisPage.length - 1] ?? notes[notes.length - 1];
      owner?.annotations.push({ ...a, pageId: page.pageId });
    }
  }

  return carryDatesForward(notes);
}

/**
 * A notebook is written front to back, so a note with no date on the page was
 * written on or after the last date that does appear. Carry that date forward.
 *
 * Deliberately one-directional. Inheriting backwards from a *later* note would
 * date an entry to a day it cannot have been written on, and the whole point of
 * tracking precision is that `before:` and `after:` stay true. Notes before the
 * first dated entry in a batch keep a null date: nothing has been established
 * yet, and guessing there would be invention rather than inference.
 */
function carryDatesForward(notes: ProposedNote[]): ProposedNote[] {
  let last: string | null = null;
  for (const note of notes) {
    if (note.writtenOn) {
      last = note.writtenOn;
    } else if (last) {
      note.writtenOn = last;
      note.writtenOnPrecision = 'sequence';
    }
  }
  return notes;
}
