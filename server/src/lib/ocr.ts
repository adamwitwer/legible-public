import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';

/**
 * Every rule below was earned from the sample pages in images/ — see the
 * Phase 0 findings in ARCHITECTURE.md. They are not general OCR advice; they
 * describe this notebook.
 */
const SYSTEM = `You transcribe photographs of handwritten notebook pages into structured JSON.

The writer prints rather than writes cursive, on dot-grid paper, in dark ink. Pages are
photographed in order, one page per image.

TRANSCRIPTION
- Transcribe to markdown. Cascading indentation is structural: render it as nested lists.
- A brace grouping several lines into one conclusion becomes a nested list under that
  conclusion, plus a bracketed note like [brace groups the three items above].
- Struck-through text is usually the pen slipping, occasionally the writer changing their
  mind. Tell them apart by what follows the strike:
  - A false start, a misspelling, a doubled word or a stray mark that is immediately
    rewritten is PENMANSHIP. Drop it silently and transcribe only the corrected text.
    "~~goog~~ good", "~~Anser~~ Answer", "~~repar~~ repair", "~~&~~ calendar" are all noise.
  - Text struck and replaced with something DIFFERENT, or struck and abandoned, is a
    RETRACTION. Transcribe it wrapped in ~~tildes~~ — the change of mind is the point.
    "~~Aug 2~~" and a struck-out figure or name both matter.
  - A struck word you cannot read carries nothing. Drop it; never emit "~~[?]~~", and do
    not list it under "illegible".
- Underlining in the body is emphasis. Transcribe the underlined words as PLAIN TEXT with
  no markup at all — never <u> tags, bold or italics. The app renders body text literally,
  so a tag shows up as characters mid-sentence and breaks phrase search across the words it
  wraps. (An underlined name in the MARGIN is a different thing — that is a speaker, and it
  is handled under MARGINALIA below.)
- Describe sketches, arrows and diagrams in [square brackets] so they stay searchable.
  An elbow arrow leading to a conclusion is usually "↳".
- Never transcribe faint, low-contrast or mirrored text: that is the reverse of the page
  showing through the paper, and it appears on nearly every page.
- If a word is genuinely illegible write [?] and list it in "illegible". Do not guess at
  proper nouns; a wrong name is worse than a marked gap.

NOTE BOUNDARIES
- A page is not a note. A note is an entry that may span several pages.
- A note is one SESSION of writing: a single meeting, or a conversation with one person.
  It is NOT a topic. A meeting that moves through five subjects is still one note.
- A NEW NOTE MUST CARRY A DATE. This is the single deciding test. A header names a person
  or a meeting AND is accompanied by a date, on the same line or immediately beside it.
  Examples:
    "Aug 1   Meeting Title"    → new note (date + title)
    "Aug 2   The Second Coming" → new note (date + title)
    "Priya  Sep 3"             → new note (person + date)
    "Gus — 9/12"               → new note (person + date)
- A NAME ALONE IS NOT A NEW NOTE, however heading-like it looks — however short the line,
  however left-aligned, however much white space sits above it. Without a date it is a
  subject inside the note already in progress, and starts_note MUST be false:
    "Tell me"                  → a subject within the note above, NOT a new note
    "The vanishing spies"      → a subject within the note above
    "Wren ——"                  → a subject within the note above
    "Elena"                    → a subject within the note above
    "Donor ideas"              → a subject within the same meeting
    "TRP / Velo — parts side"  → a subject within the same meeting
- A date written in the BODY of a note is not a header date. A date belongs to a header
  only when it sits on the header line itself. These must NOT become a note's date_text:
    "- Bo — Gus   Sep 5"       → a bullet referring to a meeting, inside the note above
    "to Oct 15 / team Wren"    → planning text, inside the note above
    "~~Aug 2~~"                → struck: a date abandoned, inside the note above
  If the date is part of a sentence, a bullet, or a struck-through line, it is body text.
  A struck date is never a header date, however heading-like its position.
- A page with no header at all always continues the previous note.
- A new note CAN start halfway down a page while the previous note finishes above it, when
  a DATED header appears partway down. Emit one block per note-start, in reading order, and
  set starts_note=false for a block that continues the previous note.
- When you are genuinely unsure, CONTINUE the previous note rather than starting a new one.

DATES
- Report the date exactly as written in date_text ("Aug 1"), and do not invent a year:
  these pages almost never carry one. Set date_precision to what was actually written.

MARGINALIA
- Text in the margins is separate from the body and carries its own meaning. Do not merge
  it into the transcript flow.
- Classify it: "speaker" (a name, often underlined, attributing the adjacent lines),
  "question" (a name or phrase with a question mark — someone to follow up with),
  "qualifier" (a phrase modifying the adjacent line, e.g. "lower than 80%"), or "note".
- Record which side it sits on, its rotation in degrees (margin text is sometimes written
  at 90°, read it anyway), and anchor it to the body line it sits beside.
- Only record margin text that contains actual words. Stray dashes, ticks and marks are
  not annotations; ignore them.
- Two margin notes stacked together and reading as one thought (for example a name over a
  second name, both with question marks) are one annotation, not two.`;

export type OcrBlock = {
  starts_note: boolean;
  title: string | null;
  date_text: string | null;
  date_precision: 'day' | 'month' | 'year' | null;
  transcript: string;
};

export type OcrAnnotation = {
  side: 'left' | 'right' | 'top' | 'bottom';
  rotation: number;
  kind: 'speaker' | 'question' | 'qualifier' | 'note';
  anchor: string | null;
  text: string;
};

export type OcrResult = {
  blocks: OcrBlock[];
  annotations: OcrAnnotation[];
  confidence: number;
  illegible: string[];
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks', 'annotations', 'confidence', 'illegible'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['starts_note', 'title', 'date_text', 'date_precision', 'transcript'],
        properties: {
          starts_note: { type: 'boolean' },
          title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          date_text: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          // A nullable enum must be expressed as anyOf; a ['string','null'] union
          // with an enum containing null is rejected by schema validation.
          date_precision: {
            anyOf: [{ type: 'string', enum: ['day', 'month', 'year'] }, { type: 'null' }],
          },
          transcript: { type: 'string' },
        },
      },
    },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['side', 'rotation', 'kind', 'anchor', 'text'],
        properties: {
          side: { type: 'string', enum: ['left', 'right', 'top', 'bottom'] },
          rotation: { type: 'integer' },
          kind: { type: 'string', enum: ['speaker', 'question', 'qualifier', 'note'] },
          anchor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          text: { type: 'string' },
        },
      },
    },
    confidence: { type: 'number' },
    illegible: { type: 'array', items: { type: 'string' } },
  },
} as const;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.anthropicApiKey || undefined }));

export async function readPage(
  image: Buffer,
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp',
  context?: { pageNumber: number; totalPages: number; previousTitle?: string | null },
): Promise<{ result: OcrResult; model: string; usage: unknown }> {
  const hint = context
    ? `\n\nThis is page ${context.pageNumber} of ${context.totalPages} in this batch.${
        context.previousTitle
          ? ` The previous page belonged to a note titled "${context.previousTitle}". If this page carries no new header, it continues that note.`
          : ''
      }`
    : '';

  const message = await anthropic().messages.create({
    model: env.ocrModel,
    max_tokens: 8000,
    system: SYSTEM,
    thinking: { type: 'adaptive' },
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } },
          { type: 'text', text: `Transcribe this page.${hint}` },
        ],
      },
    ],
  });

  const text = message.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('no text block in OCR response');

  return {
    result: JSON.parse(text.text) as OcrResult,
    model: message.model,
    usage: message.usage,
  };
}
