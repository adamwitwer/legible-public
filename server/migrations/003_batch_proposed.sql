-- Cached segmentation for the review step. Derived from pages.ocr_json, so it can
-- always be recomputed without re-calling the OCR API — which is the point of
-- keeping OCR (expensive, per page) separate from segmentation (cheap, derived).
alter table batches add column if not exists proposed jsonb;
