#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MAX_PIXEL_BYTES,
  MAX_STREAM_BYTES,
  previewCollection,
  resolveParametricSpec,
  validateDatasetSpec,
  withResolvedSeed,
  writeCollectionFromSpec,
  writeLargeImageFile,
} from '../dist/esm/index.js'

function usage() {
  console.error(
    'Usage: dicom-synth-generate --schema <path> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '       dicom-synth-generate --schema-inline <json> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '       dicom-synth-generate --parametric <path> [--out <dir>] [--emit-spec <path>] [--dry-run]\n' +
      '       dicom-synth-generate --large-file <path> --size <600mb|50gb> [--modality CT|PT|MR|CR]\n' +
      '\n' +
      'A seed is drawn when the spec omits one; pass --emit-spec to capture the\n' +
      'effective spec (seed included) so the dataset can be re-created.\n' +
      '\n' +
      '--large-file streams a single DICOM (512 MB–50 GB) to disk; files above\n' +
      '~4 GB use encapsulated fragments (valid container, zero pixel content).',
  )
  process.exit(1)
}

const SIZE_UNITS = { b: 1, kb: 1024, mb: 1024 * 1024, gb: 1024 * 1024 * 1024 }

function parseSizeToBytes(s) {
  // Unit is required so a bare number (e.g. "600", meant as MB) is not silently
  // read as 600 bytes.
  const m = /^([0-9]*\.?[0-9]+)\s*(b|kb|mb|gb)$/i.exec(s.trim())
  if (!m) {
    throw new Error(
      `invalid --size "${s}" — include a unit, e.g. 600mb or 50gb`,
    )
  }
  return Math.round(Number.parseFloat(m[1]) * SIZE_UNITS[m[2].toLowerCase()])
}

const args = process.argv.slice(2)

if (args.length === 0) usage()

let rawSpec
let specSource
let outDir = resolve('./fixtures/generated')
let emitSpecPath
let dryRun = false
let largeFilePath
let largeFileSize
let largeFileModality

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
  } else if (args[i] === '--large-file' && args[i + 1]) {
    largeFilePath = resolve(args[++i])
  } else if (args[i] === '--size' && args[i + 1]) {
    largeFileSize = args[++i]
  } else if (args[i] === '--modality' && args[i + 1]) {
    largeFileModality = args[++i]
  } else {
    console.error(`Unknown argument: ${args[i]}`)
    usage()
  }
}

if (largeFilePath !== undefined) {
  if (rawSpec !== undefined) {
    console.error('Error: --large-file cannot be combined with a spec mode')
    process.exit(1)
  }
  if (largeFileSize === undefined) {
    console.error('Error: --large-file requires --size')
    usage()
  }
  if (
    largeFileModality !== undefined &&
    !['CT', 'PT', 'MR', 'CR'].includes(largeFileModality)
  ) {
    console.error(`Error: invalid --modality "${largeFileModality}"`)
    process.exit(1)
  }
  let targetBytes
  try {
    targetBytes = parseSizeToBytes(largeFileSize)
  } catch (err) {
    console.error(`Error: ${err.message}`)
    process.exit(1)
  }
  // Validate bounds here so --dry-run reflects what a real run would accept.
  if (targetBytes <= MAX_PIXEL_BYTES) {
    console.error(
      'Error: --size must exceed the 512 MB in-memory limit — use a spec with targetSizeKb for smaller files',
    )
    process.exit(1)
  }
  if (targetBytes > MAX_STREAM_BYTES) {
    console.error('Error: --size exceeds the 50 GB limit')
    process.exit(1)
  }
  if (dryRun) {
    console.log(
      `Dry run: would write ~${(targetBytes / 1024 / 1024).toFixed(1)} MB to ${largeFilePath} — nothing written`,
    )
    process.exit(0)
  }
  try {
    const result = writeLargeImageFile(
      { targetBytes, modality: largeFileModality },
      largeFilePath,
    )
    console.log(
      `Wrote ${(result.bytesWritten / 1024 / 1024).toFixed(1)} MB ${result.encoding} DICOM to ${result.path}`,
    )
  } catch (err) {
    console.error(`Error writing large file: ${err.message}`)
    process.exit(1)
  }
  process.exit(0)
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
    for await (const file of previewCollection(spec)) {
      console.log(
        `${file.relativePath}  (${file.type}, ${(file.approxBytes / 1024).toFixed(1)} KB)`,
      )
      counts[file.type] = (counts[file.type] ?? 0) + 1
      fileCount++
      byteCount += file.approxBytes
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
