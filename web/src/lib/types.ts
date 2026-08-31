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
  /** Local only: 1 when this note has unpushed changes. */
  dirty?: 0 | 1;
};
