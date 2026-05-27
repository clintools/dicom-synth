import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export type PublicCaseSource =
  | { kind: 'url'; url: string }
  | { kind: 's3'; bucket: string; key: string; version_id?: string }

export type PublicCaseRecord = {
  id: string
  violation_class: string
  source: PublicCaseSource
  sha256: string
  notes?: string
  dciodvfy_skip?: boolean
}

const bundledCatalogPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../data/public-cases.json',
)

/** Path to bundled `public-cases.json` (works from `src/` and `dist/esm/`). */
export function defaultPublicCasesPath(): string {
  return bundledCatalogPath
}

export function loadDefaultCases(): PublicCaseRecord[] {
  return loadCasesFromJson(defaultPublicCasesPath())
}

export function loadCasesFromJson(casesJsonPath: string): PublicCaseRecord[] {
  const j = JSON.parse(readFileSync(casesJsonPath, 'utf8')) as {
    cases?: unknown
  }
  if (!Array.isArray(j.cases)) {
    throw new Error(
      `Invalid catalog in ${casesJsonPath}: expected "cases" array`,
    )
  }
  return j.cases as PublicCaseRecord[]
}

export function loadCaseById(
  casesJsonPath: string,
  id: string,
): PublicCaseRecord {
  const found = loadCasesFromJson(casesJsonPath).find((r) => r.id === id)
  if (!found) {
    throw new Error(`Unknown case id "${id}" in ${casesJsonPath}`)
  }
  return found
}
