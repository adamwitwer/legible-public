# inbox

Drop notebook photos here for backfill. **This directory is gitignored** — the images
never enter the repo. Put one notebook (or one contiguous run of pages) in a subdirectory:

    inbox/
      2023-green-notebook/   001.jpeg 002.jpeg …
      2024-moleskine/        001.jpeg 002.jpeg …

Then:

    node scripts/backfill.mjs inbox/2023-green-notebook --dated 2023-09

See `scripts/backfill.mjs --help`.
