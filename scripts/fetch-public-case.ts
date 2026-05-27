#!/usr/bin/env tsx
/**
 * Fetch a public testcase by id into the content-addressed cache.
 *
 *   pnpm fetch:public-case -- pydicom-CT-small
 */
import {
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCaseById,
  type PublicCaseRecord,
} from '../src'

const id = process.argv[2]
if (!id) {
  console.error('Usage: pnpm fetch:public-case -- <case-id>')
  process.exit(1)
}

let record: PublicCaseRecord
try {
  record = loadCaseById(defaultPublicCasesPath(), id)
} catch {
  console.error(`Unknown id: ${id}`)
  process.exit(1)
}

const outPath = await fetchPublicCaseToCache(record)
console.log(outPath)
