#!/usr/bin/env bash
# Pre-commit hook — fast, focused checks (<10s target).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/hooks/lib.sh
source "$REPO_ROOT/scripts/hooks/lib.sh"

skip_if_merge_or_rebase

echo "🔹 Running lint-staged..."
pnpm exec lint-staged

if staged_matches '\.(ts|tsx|mts|cts|json)$'; then
  echo "🔹 Running typecheck..."
  pnpm typecheck
else
  echo "⏭️  Skipping typecheck (no staged TS/JSON files)"
fi

echo "✓ Pre-commit validation completed"
