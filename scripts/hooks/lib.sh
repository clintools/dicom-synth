#!/usr/bin/env bash
# Shared helpers for Husky git hooks.

set -euo pipefail

skip_if_merge_or_rebase() {
  local git_dir
  git_dir="$(git rev-parse --git-dir 2>/dev/null || echo "")"
  if [[ -z "$git_dir" ]]; then
    return 1
  fi
  if [[ -f "${git_dir}/MERGE_HEAD" ]] || [[ -d "${git_dir}/rebase-merge" ]] || [[ -d "${git_dir}/rebase-apply" ]]; then
    echo "⏭️  Skipping hook during merge/rebase"
    exit 0
  fi
}

staged_matches() {
  local pattern="$1"
  git diff --cached --name-only | grep -qE "$pattern"
}
