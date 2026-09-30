#!/usr/bin/env bash
# Merge upstream into the current branch; abort cleanly on conflicts.
# Usage: scripts/sync-upstream.sh [--no-check] [--install]
set -euo pipefail

REMOTE="${UPSTREAM_REMOTE:-upstream}"
REF="${UPSTREAM_REF:-main}"
CHECK=1
INSTALL=0
for arg in "$@"; do
  case "$arg" in
    --no-check) CHECK=0 ;;
    --install) INSTALL=1 ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 64 ;;
  esac
done

cd "$(git rev-parse --show-toplevel)"
BRANCH="$(git symbolic-ref --short HEAD)"
if [ -e "$(git rev-parse --git-path MERGE_HEAD)" ]; then
  echo "A merge is already in progress; finish or abort it first." >&2
  exit 1
fi

# Remember conflict resolutions so repeats resolve themselves.
git config rerere.enabled true
git config rerere.autoupdate true
# Keep our README when upstream edits it (.gitattributes).
git config merge.ours.driver true

# Our only change to the Tauri config is the product name, so a conflict
# there is resolved by taking upstream's file and renaming it again.
BRAND_FILE=src-tauri/tauri.conf.json
BRAND_NAME=Monochrome
rebrand() {
  sed -i -e "s/\"productName\": \"[^\"]*\"/\"productName\": \"$BRAND_NAME\"/" \
    -e "s/\"title\": \"MonoCode\"/\"title\": \"$BRAND_NAME\"/" "$BRAND_FILE"
}

git fetch --quiet "$REMOTE"
INCOMING="$(git rev-list --count "HEAD..$REMOTE/$REF")"
if [ "$INCOMING" -eq 0 ]; then
  echo "$BRANCH is up to date with $REMOTE/$REF."
  exit 0
fi
echo "$INCOMING new commit(s) from $REMOTE/$REF:"
git log --oneline --no-decorate "HEAD..$REMOTE/$REF" | head -40

if ! git merge --no-edit --no-ff "$REMOTE/$REF"; then
  if git diff --name-only --diff-filter=U | grep -qx "$BRAND_FILE"; then
    echo "Taking upstream $BRAND_FILE and renaming it to $BRAND_NAME."
    git checkout --theirs -- "$BRAND_FILE"
    rebrand
    git add "$BRAND_FILE"
  fi
  UNMERGED="$(git diff --name-only --diff-filter=U)"
  if [ -e "$(git rev-parse --git-path MERGE_HEAD)" ] && [ -z "$UNMERGED" ]; then
    echo "All conflicts resolved automatically; committing the merge."
    git commit --no-edit
  else
    echo >&2
    echo "Conflicts, merge aborted. Files:" >&2
    printf '%s\n' "$UNMERGED" | sed 's/^/  /' >&2
    git merge --abort 2>/dev/null || true
    echo "Resolve by hand: git merge $REMOTE/$REF" >&2
    exit 2
  fi
fi
rebrand
if ! git diff --quiet -- "$BRAND_FILE"; then
  echo "Restoring $BRAND_NAME name in $BRAND_FILE."
  git commit --quiet --amend --no-edit -- "$BRAND_FILE"
fi
echo "Merged $REMOTE/$REF into $BRANCH at $(git rev-parse --short HEAD)."

if [ "$CHECK" -eq 1 ]; then
  failed=0
  run_in() {
    local dir="$1"
    shift
    echo "==> ($dir) $*"
    if ! (cd "$dir" && "$@"); then failed=1; echo "FAILED: $*" >&2; fi
  }
  run_in . npx tsc --noEmit
  run_in . npx vitest run
  run_in src-tauri cargo clippy --workspace --all-targets -- -D warnings
  run_in src-tauri env LC_ALL=C cargo test -p monocode --lib
  if [ "$failed" -ne 0 ]; then
    echo >&2
    echo "Checks failed after the merge. Undo with: git reset --hard ORIG_HEAD" >&2
    exit 3
  fi
fi

if [ "$INSTALL" -eq 1 ]; then
  npm run tauri build -- --no-bundle
  install -Dm755 target/release/monocode "$HOME/.local/bin/monochrome"
  echo "Installed $HOME/.local/bin/monochrome"
fi

# SSH machine setup downloads the host from our `host-v<version>` release.
HOST_TAG="host-v$(node -p 'require("./package.json").version')"
if ! git ls-remote --exit-code --tags origin "refs/tags/$HOST_TAG" >/dev/null 2>&1; then
  echo "No $HOST_TAG release yet; after pushing, publish host packages with:"
  echo "  git tag $HOST_TAG && git push origin $HOST_TAG"
fi
echo "Done. Push is manual."
