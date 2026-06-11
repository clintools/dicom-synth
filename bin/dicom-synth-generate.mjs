#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  validateDatasetSpec,
  writeCollectionFromSpec,
} from '../dist/esm/index.js'

function usage() {
  console.error(
    'Usage: dicom-synth-generate --schema <path> [--out <dir>]\n' +
      '       dicom-synth-generate --schema-inline <json> [--out <dir>]',
  )
  process.exit(1)
}

const args = process.argv.slice(2)

if (args.length === 0) usage()

let rawSpec
let outDir = resolve('./fixtures/generated')

for (let i = 0; i < args.length; i++) {
  if (
    (args[i] === '--schema' || args[i] === '--schema-inline') &&
    args[i + 1]
  ) {
    if (rawSpec !== undefined) {
      console.error(
        'Error: --schema and --schema-inline are mutually exclusive',
      )
      process.exit(1)
    }
    if (args[i] === '--schema') {
      try {
        rawSpec = JSON.parse(readFileSync(resolve(args[++i]), 'utf8'))
      } catch (err) {
        console.error(`Error reading schema file: ${err.message}`)
        process.exit(1)
      }
    } else {
      try {
        rawSpec = JSON.parse(args[++i])
      } catch (err) {
        console.error(`Error parsing inline schema: ${err.message}`)
        process.exit(1)
      }
    }
  } else if (args[i] === '--out' && args[i + 1]) {
    outDir = resolve(args[++i])
  } else {
    console.error(`Unknown argument: ${args[i]}`)
    usage()
  }
}

if (rawSpec === undefined) usage()

let spec
try {
  spec = validateDatasetSpec(rawSpec)
} catch (err) {
  console.error(`Schema validation error: ${err.message}`)
  process.exit(1)
}

let manifest
try {
  manifest = await writeCollectionFromSpec(spec, outDir)
} catch (err) {
  console.error(`Error writing collection: ${err.message}`)
  process.exit(1)
}

// Summary by type
const counts = {}
for (const entry of manifest) {
  counts[entry.type] = (counts[entry.type] ?? 0) + 1
}

console.log(`Wrote ${manifest.length} file(s) to ${outDir}`)
for (const [type, count] of Object.entries(counts)) {
  console.log(`  ${type}: ${count}`)
}
