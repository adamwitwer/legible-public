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
staged=$(git diff --cached --name-only --diff-filter=ACM)
[ -z "$staged" ] && exit 0

say() { printf '\033[31mblocked:\033[0m %s\n' "$1" >&2; fail=1; }

# 1. Directories that must never be committed.
while IFS= read -r f; do
  case "$f" in
    inbox/*)
      [ "$f" = "inbox/README.md" ] || say "$f — inbox/ holds real notebook pages" ;;
    .data/*)
      say "$f — .data/ holds local page blobs" ;;
  esac
done <<< "$staged"

# 2. images/ is the four invented samples. Nothing else goes in.
while IFS= read -r f; do
  case "$f" in
    images/*)
      case "$f" in
        images/1.jpeg|images/2.jpeg|images/3.jpeg|images/4.jpeg) ;;
        *) say "$f — images/ holds only the four sample pages" ;;
      esac ;;
  esac
done <<< "$staged"

# 3. Any other image or PDF anywhere in the tree is suspect: a screenshot of the
#    app is a screenshot of real notes.
while IFS= read -r f; do
  case "$f" in
    images/*) ;;
    *.jpg|*.jpeg|*.png|*.heic|*.HEIC|*.pdf|*.webp)
      say "$f — images and PDFs may show real notes; commit only if you have looked at it" ;;
  esac
done <<< "$staged"

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
