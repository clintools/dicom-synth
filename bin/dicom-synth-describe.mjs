#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describeDirectory } from '../dist/esm/index.js'

function usage() {
  console.error(
    'Usage: dicom-synth-describe <dir> [--out <spec.json[.gz]>] [--tree] [--keep-tags <a,b,...>] [--keep-tags-file <path>] [--size-tolerance <fraction>] [--no-preserve-uids] [--uid-salt <hex>] [--gzip]\n' +
      '\n' +
      'Scans a DICOM tree and emits a DatasetSpec describing its shape\n' +
      '(studies/series, per-file size, modality).\n' +
      '\n' +
      'UIDs are preserved by default as hash-derived synthetic UIDs, keeping\n' +
      'cross-file links (FrameOfReferenceUID etc.) without emitting any original\n' +
      'UID. Other tags are not copied unless named.\n' +
      '--tree captures the real directory structure as a generic tree spec\n' +
      '(anonymised names, sized non-DICOM placeholders included) instead of\n' +
      'the compact studies/series form. Requires UID preservation.\n' +
      '--keep-tags copies the named tags (DICOM keywords or 8-hex tags)\n' +
      "verbatim; if a kept tag holds PHI, handling it is the caller's\n" +
      "responsibility, not this tool's.\n" +
      '--keep-tags-file reads the same allow-list from a file (one tag per\n' +
      'line, # comments); merged with any --keep-tags.\n' +
      '--size-tolerance folds near-identical file sizes (fraction, e.g. 0.05\n' +
      '= ±5%) into one entry; default exact.\n' +
      '--no-preserve-uids emits shape only with freshly minted UIDs (no link\n' +
      'preservation).\n' +
      '--uid-salt fixes the hashing salt (hex) for a specific namespace; when\n' +
      "omitted the salt derives from the dataset's own study UIDs (reproducible,\n" +
      'and disjoint across datasets). The salt is reported on stderr.\n' +
      '--gzip (or a .gz --out suffix) writes the spec gzip-compressed.',
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
let sizeTolerance
let preserveUids = true
let uidSalt
let gzip = false
let captureTree = false
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
  } else if (args[i] === '--size-tolerance' && args[i + 1]) {
    sizeTolerance = Number(args[++i])
    if (!Number.isFinite(sizeTolerance) || sizeTolerance < 0) {
      console.error('--size-tolerance must be a non-negative number')
      process.exit(1)
    }
  } else if (args[i] === '--no-preserve-uids') {
    preserveUids = false
  } else if (args[i] === '--tree') {
    captureTree = true
  } else if (args[i] === '--uid-salt' && args[i + 1]) {
    uidSalt = args[++i]
  } else if (args[i] === '--gzip') {
    gzip = true
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

if (uidSalt !== undefined && !preserveUids) {
  console.error('--uid-salt cannot be combined with --no-preserve-uids')
  process.exit(1)
}

let result
try {
  result = describeDirectory(dir, {
    ...(keepTags.length ? { keepTags } : {}),
    ...(sizeTolerance !== undefined ? { sizeTolerance } : {}),
    preserveUids,
    ...(uidSalt !== undefined ? { uidSalt } : {}),
    ...(captureTree ? { captureTree: true } : {}),
  })
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}

const json = `${JSON.stringify(result.spec, null, 2)}\n`
const compress = gzip || outPath?.endsWith('.gz')
if (outPath) {
  writeFileSync(outPath, compress ? gzipSync(json) : json)
  console.error(`Wrote DatasetSpec to ${outPath}`)
} else {
  process.stdout.write(compress ? gzipSync(json) : json)
}

const { dicomFiles, skipped, unknownModality, nonDicomFiles } = result.stats
console.error(
  `Described ${dicomFiles} DICOM file(s); skipped ${skipped} non-DICOM/ungroupable file(s)`,
)
if (nonDicomFiles > 0) {
  console.error(
    `  ${nonDicomFiles} non-DICOM file(s) captured as sized placeholders`,
  )
}
if (result.spec.uidSalt) {
  console.error(
    `  UIDs hash-derived with salt ${result.spec.uidSalt} (reuse via --uid-salt to reproduce)`,
  )
}
if (unknownModality > 0) {
  console.error(
    `  ${unknownModality} file(s) had an unsupported Modality — emitted as default (CT)`,
  )
}
