#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  generateCollectionFromSpec,
  resolveParametricSpec,
  validateDatasetSpec,
  withResolvedSeed,
  writeCollectionFromSpec,
} from '../dist/esm/index.js'

function usage() {
  console.error(
    'Usage: dicom-synth-generate --schema <path> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '       dicom-synth-generate --schema-inline <json> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '       dicom-synth-generate --parametric <path> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '\n' +
      'A seed is drawn when the spec omits one; pass --emit-spec to capture the\n' +
      'effective spec (seed included) so the dataset can be re-created.',
  )
  process.exit(1)
}

const args = process.argv.slice(2)

if (args.length === 0) usage()

let rawSpec
let specSource
let outDir = resolve('./fixtures/generated')
let emitSpecPath
let dryRun = false

function readSpecArg(flag, value) {
  if (rawSpec !== undefined) {
    console.error(
      'Error: --schema, --schema-inline and --parametric are mutually exclusive',
    )
    process.exit(1)
  }
  specSource = flag
  if (flag === '--schema-inline') {
    try {
      rawSpec = JSON.parse(value)
    } catch (err) {
      console.error(`Error parsing inline schema: ${err.message}`)
      process.exit(1)
    }
  } else {
    try {
      rawSpec = JSON.parse(readFileSync(resolve(value), 'utf8'))
    } catch (err) {
      console.error(`Error reading ${flag.slice(2)} file: ${err.message}`)
      process.exit(1)
    }
  }
}

for (let i = 0; i < args.length; i++) {
  if (
    (args[i] === '--schema' ||
      args[i] === '--schema-inline' ||
      args[i] === '--parametric') &&
    args[i + 1]
  ) {
    readSpecArg(args[i], args[++i])
  } else if (args[i] === '--out' && args[i + 1]) {
    outDir = resolve(args[++i])
  } else if (args[i] === '--emit-spec' && args[i + 1]) {
    emitSpecPath = resolve(args[++i])
  } else if (args[i] === '--dry-run') {
    dryRun = true
  } else {
    console.error(`Unknown argument: ${args[i]}`)
    usage()
  }
}

if (rawSpec === undefined) usage()

function printTypeCounts(counts) {
  for (const [type, count] of Object.entries(counts)) {
    console.log(`  ${type}: ${count}`)
  }
}

const seedProvided =
  rawSpec !== null && typeof rawSpec === 'object' && 'seed' in rawSpec

let spec
try {
  spec =
    specSource === '--parametric'
      ? resolveParametricSpec(rawSpec)
      : withResolvedSeed(validateDatasetSpec(rawSpec))
} catch (err) {
  console.error(`Schema validation error: ${err.message}`)
  process.exit(1)
}

// Surface the drawn seed so a run is reproducible even without --emit-spec.
if (!seedProvided) {
  console.error(
    `Generated with seed ${spec.seed} (pass --emit-spec to capture)`,
  )
}

if (emitSpecPath !== undefined) {
  try {
    writeFileSync(emitSpecPath, `${JSON.stringify(spec, null, 2)}\n`)
    console.log(`Wrote resolved spec to ${emitSpecPath}`)
  } catch (err) {
    console.error(`Error writing resolved spec: ${err.message}`)
    process.exit(1)
  }
}

if (dryRun) {
  const counts = {}
  let fileCount = 0
  let byteCount = 0
  try {
    for await (const file of generateCollectionFromSpec(spec)) {
      console.log(
        `${file.relativePath}  (${file.type}, ${(file.buffer.length / 1024).toFixed(1)} KB)`,
      )
      counts[file.type] = (counts[file.type] ?? 0) + 1
      fileCount++
      byteCount += file.buffer.length
    }
  } catch (err) {
    console.error(`Error generating collection: ${err.message}`)
    process.exit(1)
  }
  console.log(
    `Dry run: ${fileCount} file(s), ${(byteCount / 1024).toFixed(1)} KB total — nothing written`,
  )
  printTypeCounts(counts)
} else {
  let manifest
  try {
    manifest = await writeCollectionFromSpec(spec, outDir)
  } catch (err) {
    console.error(`Error writing collection: ${err.message}`)
    process.exit(1)
  }

  const counts = {}
  for (const entry of manifest) {
    counts[entry.type] = (counts[entry.type] ?? 0) + 1
  }
  console.log(`Wrote ${manifest.length} file(s) to ${outDir}`)
  printTypeCounts(counts)
}
