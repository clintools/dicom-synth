#!/usr/bin/env tsx
/**
 * Write deterministic synthetic DICOM fixtures to a directory.
 *
 *   pnpm write:synthetic -- ./out/fixtures
 */
import { resolve } from 'node:path'
import defaultSpec from '../examples/default.json' with { type: 'json' }
import { validateDatasetSpec, writeCollectionFromSpec } from '../src/index.js'

const outDir = resolve(process.argv[2] ?? './fixtures/synthetic')
const spec = validateDatasetSpec(defaultSpec)
const manifest = await writeCollectionFromSpec(spec, outDir)
for (const entry of manifest) {
  console.log(`wrote ${entry.path} — ${entry.type}`)
}
