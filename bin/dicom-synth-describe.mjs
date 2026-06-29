#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describeDirectory } from '../dist/esm/index.js'

function usage() {
  console.error(
    'Usage: dicom-synth-describe <dir> [--out <spec.json>] [--keep-tags <a,b,...>] [--keep-tags-file <path>]\n' +
      '\n' +
      'Scans a DICOM tree and emits a DatasetSpec describing its shape\n' +
      '(studies/series, per-file size, modality).\n' +
      '\n' +
      'By default only the shape is reproduced — no tags are copied.\n' +
      '--keep-tags copies the named tags (DICOM keywords or 8-hex tags)\n' +
      "verbatim; if a kept tag holds PHI, handling it is the caller's\n" +
      "responsibility, not this tool's.\n" +
      '--keep-tags-file reads the same allow-list from a file (one tag per\n' +
      'line, # comments); merged with any --keep-tags.',
  )
  process.exit(1)
}

// Parse a keep-tags file: one tag per line, blank lines and # comments ignored.
function parseKeepTagsFile(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
}

const args = process.argv.slice(2)
if (args.length === 0) usage()

let dir
let outPath
const keepTags = []

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out' && args[i + 1]) {
    outPath = resolve(args[++i])
  } else if (args[i] === '--keep-tags' && args[i + 1]) {
    keepTags.push(
      ...args[++i]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    )
  } else if (args[i] === '--keep-tags-file' && args[i + 1]) {
    try {
      keepTags.push(...parseKeepTagsFile(resolve(args[++i])))
    } catch (err) {
      console.error(`Error reading keep-tags file: ${err.message}`)
      process.exit(1)
    }
  } else if (args[i].startsWith('--')) {
    console.error(`Unknown argument: ${args[i]}`)
    usage()
  } else if (dir === undefined) {
    dir = resolve(args[i])
  } else {
    console.error(`Unexpected argument: ${args[i]}`)
    usage()
  }
}

if (dir === undefined) usage()

let result
try {
  result = describeDirectory(dir, keepTags.length ? { keepTags } : {})
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}

const json = `${JSON.stringify(result.spec, null, 2)}\n`
if (outPath) {
  writeFileSync(outPath, json)
  console.error(`Wrote DatasetSpec to ${outPath}`)
} else {
  process.stdout.write(json)
}

const { dicomFiles, skipped, unknownModality } = result.stats
console.error(
  `Described ${dicomFiles} DICOM file(s); skipped ${skipped} non-DICOM/ungroupable file(s)`,
)
if (unknownModality > 0) {
  console.error(
    `  ${unknownModality} file(s) had an unsupported Modality — emitted as default (CT)`,
  )
}
