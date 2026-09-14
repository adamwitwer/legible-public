export type Note = {
  id: string;
  kind: 'typed' | 'scan';
  title: string | null;
  body: string;
  written_on: string | null;
  written_on_precision: string | null;
  tags: string[];
  ocr_status: string | null;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  seq: string;
  /** An AI summary, present only when one was asked for. Written by the server,
   *  never pushed by the client, and never indexed for search. */
  summary?: string | null;
  /** SHA-256 of the body the summary was made from; see lib/summary.ts. */
  summary_body_hash?: string | null;
  summary_model?: string | null;
  summarized_at?: string | null;
  /** Local only: 1 when this note has unpushed changes. */
  dirty?: 0 | 1;
};
