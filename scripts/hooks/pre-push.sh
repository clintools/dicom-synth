#!/usr/bin/env bash
# Pre-push hook — heavier confidence checks before sharing commits.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/hooks/lib.sh
source "$REPO_ROOT/scripts/hooks/lib.sh"

skip_if_merge_or_rebase

echo "🔹 Running Biome check (errors only)..."
pnpm check:errors

echo "🔹 Building..."
pnpm build

echo "🔹 Running tests..."
pnpm test

echo "✓ Pre-push validation completed"
