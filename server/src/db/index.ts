import postgres from 'postgres';
import { env } from '../lib/env.js';

export const sql = postgres(env.databaseUrl, {
  max: 10,
  onnotice: () => {},
  transform: { undefined: null },
  types: {
    /**
     * A Postgres `date` is a calendar date, not an instant. The driver's default
     * is to parse it into a JS Date, which re-serializes as UTC midnight
     * ("2026-08-20T00:00:00.000Z") — that renders wrong in the UI and breaks
     * `before:` filters, which compare against plain YYYY-MM-DD. Keep it a string.
     */
    date: {
      to: 1082,
      from: [1082],
      serialize: (x: string) => x,
      parse: (x: string) => x,
    },
  },
});

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
};
