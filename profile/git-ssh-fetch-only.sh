#!/bin/sh
# GIT_SSH_COMMAND wrapper: allow ONLY `git-upload-pack` (fetch/clone) over ssh; refuse everything else.
# git invokes: $GIT_SSH_COMMAND [-p port] [-o ..] host "git-upload-pack 'path'"   (command is the LAST argument)
for last; do :; done
LOG="${NIGHTGEM_SSH_LOG:-/dev/null}"
case "$last" in
  git-upload-pack\ *|git-upload-pack|"git upload-pack"*)
    echo "allow: $last" >> "$LOG"
    exec "${NIGHTGEM_SSH_REAL:-/usr/bin/ssh}" "$@" ;;
  *)
    echo "BLOCK: $*" >> "$LOG"
    echo "nightgem: ssh blocked (fetch-only wrapper): $last" >&2
    exit 255 ;;
esac
