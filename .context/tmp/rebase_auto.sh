#!/bin/bash
# Automated rebase driver: auto-resolve version-only package.json conflicts,
# stop on anything else for manual handling.
export GIT_EDITOR=true
GITDIR=$(git rev-parse --git-dir)

for i in $(seq 1 120); do
  conf=$(git diff --name-only --diff-filter=U 2>/dev/null)
  if [ -n "$conf" ]; then
    hard=""
    for f in $conf; do
      case "$f" in
        *package.json)
          python3 "$HOME/.proma/agent-workspaces/proma-mit/project/.context/tmp/ver_resolve.py" "$f" || hard="$hard $f"
          ;;
        *)
          hard="$hard $f"
          ;;
      esac
    done
    if [ -n "$hard" ]; then
      echo "== STOP: manual conflict:$hard"
      echo "== AT: $(git log -1 --format='%h %s' REBASE_HEAD 2>/dev/null)"
      exit 2
    fi
    git add -A
  fi
  out=$(git rebase --continue 2>&1)
  rc=$?
  if [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; then
    continue
  fi
  if [ $rc -eq 0 ]; then
    echo "== REBASE DONE at $(git log -1 --oneline)"
    exit 0
  fi
  echo "== rebase exited rc=$rc: $out"
  exit 1
done
echo "== MAX ITER"
exit 1
