#!/usr/bin/env node
import {
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCasesFromJson,
} from '../dist/esm/index.js'

const id = process.argv[2]
if (!id) {
  console.error('Usage: dicom-synth-fetch <case-id>')
  process.exit(1)
}

const record = loadCasesFromJson(defaultPublicCasesPath()).find(
  (c) => c.id === id,
)
if (!record) {
  console.error(`Unknown case id: ${id}`)
  process.exit(1)
}

const outPath = await fetchPublicCaseToCache(record)
console.log(outPath)
