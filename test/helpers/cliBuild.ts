import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..')

// The CLI suites spawn the bins, which import from dist/esm — they need a
// build. Locally a missing build skips them (skipIf); in CI that would
// silently mask the whole CLI surface, so fail loudly instead.
export const hasBuild = existsSync(join(repoRoot, 'dist/esm/index.js'))

if (process.env.CI && !hasBuild) {
  throw new Error(
    'CLI tests require dist/esm — run `pnpm build` before `pnpm test` (CI workflows must build before testing)',
  )
}
