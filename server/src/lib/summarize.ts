import { createHash } from 'node:crypto';
import { anthropic } from './anthropic.js';
import { env } from './env.js';

/**
 * SHA-256 of a note body, hex. MIRRORED in web/src/lib/summary.ts: the server
 * stamps the hash of the body it summarized, the client hashes the body it is
 * showing, and a mismatch is what "stale" means. If the two ever disagree on the
 * same text, every summary reads as stale forever. Held by the same test vector
 * in summarize.test.ts and web/src/lib/summary.test.ts.
 */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

export type SummaryInput = {
  kind: 'typed' | 'scan';
  title: string | null;
  writtenOn: string | null;
  body: string;
  /** Margin text, for scans. It never enters the body, so without this a
   *  meeting summary cannot know who said what. */
  annotations: { side: string | null; kind: string | null; anchor: string | null; text: string }[];
};

/**
 * The rules here are the transcription conventions this archive already uses —
 * see the OCR prompt and the Phase 0 findings. A generic "summarize this" gets
 * all three of the dangerous ones wrong: it reports a struck figure as fact,
 * guesses a name into an [?], and loses the speakers in the margin.
 */
const SYSTEM = `You write short summaries of entries in one person's private notebook archive. The summary is for them, later: to recall what an entry was about without rereading it.

Write one or two short paragraphs of plain prose. No headings, lists, bold, or preamble — begin with the substance. Keep names, figures, dates and decisions exactly as written.

The notes use conventions from transcribing handwritten pages:
- ~~Struck text~~ was retracted: a change of mind. Never report a struck figure, date or name as the current fact; mention the change only when it matters.
- [?] marks an illegible word. Leave it a gap. Never guess a name to fill it.
- [Square brackets] otherwise describe a sketch, arrow or diagram.
- Margin annotations, when present, sit beside the body rather than in it. A speaker attributes the lines beside it; a question is someone to follow up with; a qualifier modifies the line it sits next to; a todo is an open task.
- TODO or #todo marks an open task.

Summarize only what is written. Add no advice, interpretation, or context the note does not contain. If the entry is too fragmentary to summarize, say in one sentence what little it holds.`;

export function buildSummaryPrompt(n: SummaryInput): string {
  const parts = [
    `<title>${n.title ?? '(untitled)'}</title>`,
    `<written_on>${n.writtenOn ?? 'unknown'}</written_on>`,
    `<kind>${n.kind === 'scan' ? 'photographed handwritten pages, transcribed' : 'typed'}</kind>`,
    `<body>\n${n.body}\n</body>`,
  ];
  if (n.annotations.length) {
    const lines = n.annotations.map((a) => {
      const where = [a.kind ?? 'note', a.side ? `${a.side} margin` : null, a.anchor ? `beside "${a.anchor}"` : null]
        .filter(Boolean)
        .join(', ');
      return `- [${where}] ${a.text}`;
    });
    parts.push(`<margin_annotations>\n${lines.join('\n')}\n</margin_annotations>`);
  }
  return `Summarize this notebook entry.\n\n${parts.join('\n')}`;
}

/** The model declined. Distinct from a failure: retrying will not change it. */
export class SummaryRefused extends Error {}

export async function summarizeNote(n: SummaryInput): Promise<{ summary: string; model: string }> {
  const message = await anthropic().beta.messages.create({
    model: env.summaryModel,
    max_tokens: 16000,
    system: SYSTEM,
    // Low effort: this is a short restatement, not a reasoning task, and the
    // person is sitting in front of the editor waiting for it.
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    // A note about personnel or money can trip a safety classifier. With
    // fallbacks the API reruns on a fallback model inside the same call rather
    // than returning nothing.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{ role: 'user', content: buildSummaryPrompt(n) }],
  });

  if (message.stop_reason === 'refusal') throw new SummaryRefused('the model declined to summarize this note');
  if (message.stop_reason === 'max_tokens') throw new Error('summary ran past its length limit');

  const summary = message.content
    .flatMap((b) => (b.type === 'text' ? [b.text] : []))
    .join('')
    .trim();
  if (!summary) throw new Error('no text in summary response');
  return { summary, model: message.model };
}
