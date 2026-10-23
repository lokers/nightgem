#!/usr/bin/env bash
# Export the tracked files of a git ref as a fresh, single-commit repository.
#
# Usage:
#   scripts/export-public.sh --dest <dir> --name "<author name>" --email <author email> \
#     [--message "Initial commit"] [--source <repo>] [--ref HEAD] [--skip-scans]
#
# Only tracked files are exported (git archive), so untracked and ignored files
# never are. Secret scans run on the exported tree before anything else. Global
# ignore rules (core.excludesFile) are switched off for the commit, and the
# number of committed files is checked against the tracked files of the ref.
# No remote is ever added: adding it and pushing is a manual step.
#
# Exit codes: 0 success, 1 runtime failure or refusal, 2 usage error.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: export-public.sh --dest <dir> --name "<author name>" --email <author email>
                        [--message "Initial commit"] [--source <repo>] [--ref HEAD]
                        [--skip-scans]
EOF
}

die() {
  echo "export-public: $*" >&2
  exit 1
}

usage_error() {
  echo "export-public: $*" >&2
  usage
  exit 2
}

DEST=""
NAME=""
EMAIL=""
MESSAGE="Initial commit"
SOURCE=""
REF="HEAD"
SKIP_SCANS=0

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || usage_error "option $1 needs a value"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dest) need_value "$@"; DEST="$2"; shift 2 ;;
    --name) need_value "$@"; NAME="$2"; shift 2 ;;
    --email) need_value "$@"; EMAIL="$2"; shift 2 ;;
    --message) need_value "$@"; MESSAGE="$2"; shift 2 ;;
    --source) need_value "$@"; SOURCE="$2"; shift 2 ;;
    --ref) need_value "$@"; REF="$2"; shift 2 ;;
    --skip-scans) SKIP_SCANS=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
done

[ -n "$DEST" ] || usage_error "--dest is required"
[ -n "$NAME" ] || usage_error "--name is required"
[ -n "$EMAIL" ] || usage_error "--email is required"

if [ -z "$SOURCE" ]; then
  SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
fi
[ -d "$SOURCE" ] || die "source is not a directory: $SOURCE"
SOURCE_TOP="$(git -C "$SOURCE" rev-parse --show-toplevel 2>/dev/null)" ||
  die "source is not a git work tree: $SOURCE"
SOURCE_TOP="$(cd -P "$SOURCE_TOP" && pwd -P)"
git -C "$SOURCE" rev-parse --verify --quiet "$REF^{commit}" >/dev/null ||
  die "ref does not resolve to a commit: $REF"

# Resolve DEST to an absolute physical path even if it does not exist yet:
# resolve the nearest existing ancestor, then append the remaining components.
resolve_path() {
  local p="$1" rest=""
  case "$p" in /*) ;; *) p="$PWD/$p" ;; esac
  while [ ! -e "$p" ]; do
    rest="/$(basename "$p")$rest"
    p="$(dirname "$p")"
  done
  if [ -d "$p" ]; then
    p="$(cd -P "$p" && pwd -P)"
  else
    die "dest exists and is not a directory: $1"
  fi
  printf '%s%s\n' "${p%/}" "$rest"
}

DEST_ABS="$(resolve_path "$DEST")"

case "$DEST_ABS/" in
  "$SOURCE_TOP"/*) die "refusing: dest is inside the source work tree ($SOURCE_TOP): $DEST_ABS" ;;
esac
case "$SOURCE_TOP/" in
  "$DEST_ABS"/*) die "refusing: dest contains the source work tree: $DEST_ABS" ;;
esac

if [ -e "$DEST_ABS" ] && [ -n "$(ls -A "$DEST_ABS")" ]; then
  die "refusing: dest exists and is not empty: $DEST_ABS"
fi

if [ "$SKIP_SCANS" -eq 0 ]; then
  missing=""
  command -v gitleaks >/dev/null 2>&1 || missing="$missing gitleaks"
  command -v trufflehog >/dev/null 2>&1 || missing="$missing trufflehog"
  if [ -n "$missing" ]; then
    die "required scanner(s) not found:$missing. Install them with: brew install gitleaks trufflehog (or pass --skip-scans to skip the scans, not recommended)"
  fi
else
  echo "export-public: WARNING: --skip-scans given, secret scans are NOT run" >&2
fi

mkdir -p "$DEST_ABS"
git -C "$SOURCE_TOP" archive --format=tar "$REF" | tar -x -C "$DEST_ABS"

# Scans come before any build or install step.
if [ "$SKIP_SCANS" -eq 0 ]; then
  echo "export-public: running gitleaks"
  gitleaks detect --no-git --source "$DEST_ABS" --redact --exit-code 1 ||
    die "gitleaks reported findings (or failed); nothing was committed"
  echo "export-public: running trufflehog"
  trufflehog filesystem "$DEST_ABS" --fail --no-update ||
    die "trufflehog reported findings (or failed); nothing was committed"
fi

git -c init.templateDir= init -q -b main "$DEST_ABS"

# core.excludesFile=/dev/null: the user's global ignore file must not drop tracked files from the export.
GIT_FLAGS=(
  -c core.excludesFile=/dev/null
  -c core.hooksPath=/dev/null
  -c commit.gpgsign=false
  -c "user.name=$NAME"
  -c "user.email=$EMAIL"
)

# --force: the tree came from `git archive`, so every file in it is tracked in the source even if a tracked
# .gitignore would match it.
git -C "$DEST_ABS" "${GIT_FLAGS[@]}" add -A --force

export GIT_AUTHOR_NAME="$NAME" GIT_AUTHOR_EMAIL="$EMAIL"
export GIT_COMMITTER_NAME="$NAME" GIT_COMMITTER_EMAIL="$EMAIL"
git -C "$DEST_ABS" "${GIT_FLAGS[@]}" commit -q --no-verify -m "$MESSAGE"

COMMIT="$(git -C "$DEST_ABS" rev-parse HEAD)"
FILE_COUNT="$(git -C "$DEST_ABS" ls-files | wc -l | tr -d ' ')"
SOURCE_COUNT="$(git -C "$SOURCE_TOP" ls-tree -r --name-only "$REF" | wc -l | tr -d ' ')"
if [ "$FILE_COUNT" != "$SOURCE_COUNT" ]; then
  echo "export-public: file count mismatch: the export commit has $FILE_COUNT files but $REF tracks $SOURCE_COUNT." >&2
  echo "export-public: files tracked in $REF but missing from the export (< = source only):" >&2
  comm -3 <(git -C "$SOURCE_TOP" ls-tree -r --name-only "$REF" | sort) <(git -C "$DEST_ABS" ls-files | sort) >&2 || true
  die "do not use $DEST_ABS; fix the cause (global or per-repo ignore rules?) and export again"
fi

echo
echo "Export complete: $DEST_ABS"
echo "Commit: $COMMIT"
echo "Log:    $(git -C "$DEST_ABS" log --format='%an <%ae> | %cn <%ce> | %s')"
echo "Files:  $FILE_COUNT (matches the $SOURCE_COUNT tracked files of $REF)"
echo
echo "No remote was added. Add the remote and push manually after your own review."
