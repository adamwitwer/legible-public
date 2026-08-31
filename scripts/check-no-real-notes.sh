#!/usr/bin/env bash
# Pre-commit backstop for a public repo holding a private archive.
#
# Install: npm run hooks
#
# This blocks the mechanical mistakes. It cannot recognise a colleague's name it
# has not been told about, so it is a backstop and not a substitute for reading
# what you are about to commit.
set -uo pipefail

fail=0
say() { printf '\033[31mblocked:\033[0m %s\n' "$1" >&2; fail=1; }

# NUL-delimited, because `git diff --cached --name-only` QUOTES any path with a
# non-ASCII byte or a space and wraps it in literal double quotes:
#
#   "Screenshot 2026-08-31 at 4.45.32\342\200\257PM.png"
#
# A macOS screenshot is exactly that — its timestamp contains U+202F, a narrow
# no-break space. The trailing quote character meant `*.png` did not match and
# the first real screenshot dropped into this repo sailed straight past the
# check that exists to catch it. -z emits raw paths with no quoting.
files=()
while IFS= read -r -d '' f; do files+=("$f"); done \
  < <(git diff --cached --name-only --diff-filter=ACM -z)
[ ${#files[@]} -eq 0 ] && exit 0

for f in "${files[@]}"; do
  # 1. Directories that must never be committed.
  case "$f" in
    inbox/*) [ "$f" = "inbox/README.md" ] || say "$f — inbox/ holds real notebook pages" ;;
    .data/*) say "$f — .data/ holds local page blobs" ;;
  esac

  # 2. images/ is the four invented samples. Nothing else goes in.
  case "$f" in
    images/1.jpeg|images/2.jpeg|images/3.jpeg|images/4.jpeg) ;;
    images/*) say "$f — images/ holds only the four sample pages" ;;
  esac

  # 3. Any other image or PDF anywhere is suspect: a screenshot of the app, or
  #    of a dashboard, is a screenshot of something private.
  case "$f" in
    images/*) ;;
    *.jpg|*.jpeg|*.png|*.heic|*.pdf|*.webp|*.gif|*.tiff|*.JPG|*.JPEG|*.PNG|*.HEIC|*.PDF)
      say "$f — images and PDFs may show real notes; commit only if you have looked at it" ;;
  esac
done

# 4. Names from the real archive, if a local list exists. The list itself is
#    gitignored — a roster of colleagues does not belong in a public repo either.
if [ -f .scrub-names ]; then
  pattern=$(grep -vE '^\s*(#|$)' .scrub-names | paste -sd'|' -)
  if [ -n "$pattern" ]; then
    hits=$(git diff --cached -U0 | grep -E '^\+' | grep -inE "\b(${pattern})\b" || true)
    if [ -n "$hits" ]; then
      say "staged text mentions a name from .scrub-names:"
      printf '%s\n' "$hits" | head -20 >&2
    fi
  fi
else
  printf '\033[33mnote:\033[0m no .scrub-names file — the name check is off.\n' >&2
fi

if [ "$fail" -ne 0 ]; then
  cat >&2 <<'MSG'

Nothing was committed. Unstage the offending path, or if this is a false
positive, commit with --no-verify and be sure you are right.
MSG
  exit 1
fi
exit 0
