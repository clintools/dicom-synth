#!/usr/bin/env node
// Derive a synthetic stand-in for a real DICOM dataset — same shape and volume,
// none of the content. Safe to keep in dev; safe to replace prod test data with.
//
// It copies the source tree's structure (nesting, file sizes, modalities, stray
// non-DICOM files, UID links) and regenerates it with invented patients,
// studies, series and scanners. No original UID, tag value, or path name is
// carried over.
//
// It also adds variation a clean archive would not give you: occasional stray
// and malformed files, a few non-conformant images, mixed transfer syntaxes,
// and trailing-dot directory names.
//
// Re-running on the same source produces the same dataset, byte for byte.
//
// Usage:
//   pnpm build
//   node examples/derive-varied-dataset.mjs <source-dir> <out-dir> [name]
//
// Tune or switch off any of the variation with the rate constants below.

import {
  describeDirectory,
  writeCollectionFromSpec,
} from '../dist/esm/index.js'

// Depth-indexed directory labels, replacing describe's anonymous dir-NNN. The
// default matches the trial layout convert-data-shape.mjs documents; a level
// missing from a given branch shifts the labels beneath it, so treat them as
// readable positions, not semantics.
const LABELS = ['SITE', 'SUBJ', 'VISIT', 'MOD', 'PHASE', 'SERIES']
const SUBJECT_DEPTH = 1

// Vendor strings are real (a pipeline dispatches on them); anything naming a
// place or person is obviously synthetic.
const SCANNERS = [
  ['SIEMENS', 'Biograph Vision 600'],
  ['GE MEDICAL SYSTEMS', 'Discovery MI'],
  ['Philips', 'Vereos'],
  ['UNITED IMAGING', 'uMI 780'],
]
const VISITS = ['BASELINE', 'DAY 1', 'DAY 2', 'DAY 5', 'FOLLOW-UP']
const SERIES_DESCRIPTIONS = {
  CT: ['CT AC 3.0 B31f', 'CT WB 5.0', 'CT TOPOGRAM'],
  PT: ['PET WB AC', 'PET WB NAC', 'PET STATIC 60MIN'],
  MR: ['T1 VIBE DIXON', 'T2 HASTE', 'DWI B800'],
  CR: ['CHEST PA', 'CHEST LAT'],
}

// Variation rates — roughly "one in N". 0 disables that layer. Tuned for a
// full trial dataset: across 20k files that is ~100 strays and ~20 bad images.
// Lower them hard (20 / 10) when trying this on a handful of files, or nothing
// will fire and it will look broken.
const STRAY_RATE = 200 // stray non-image file, per image file
const VIOLATION_RATE = 1000 // deliberately non-conformant image, per image file
const IMPLICIT_VR_RATE = 6 // series written implicit-VR, per series

// Stray files a real archive accumulates, plus two malformed images. Each is a
// complete entry: modality is baked in where the type accepts it, since
// non-DICOM types reject it.
const STRAYS = [
  { type: 'non-dicom', targetSizeKb: 12 },
  { type: 'fake-signature' },
  { type: 'dicomdir' },
  { type: 'invalid-uid-image', modality: 'PT', targetSizeKb: 48 },
  { type: 'vendor-warnings-image', modality: 'CT', targetSizeKb: 48 },
]
const VIOLATIONS = [
  'uid-too-long',
  'non-conformant-uid',
  'vr-max-length-exceeded',
  'missing-type1-tag',
]

// Trailing dots on every directory — a known Chrome File System Access
// failure, so they belong in an upload test. Empty the array for plain paths.
const PATH_QUIRKS = ['trailing-dot']

const [source, outDir, name = '89Zr-TLX000-000-synth'] = process.argv.slice(2)
if (!source || !outDir) {
  console.error(
    'Usage: node examples/derive-varied-dataset.mjs <source-dir> <out-dir> [name]',
  )
  process.exit(1)
}

// Identifier stem: the name's trial-code segment (the longest one mixing
// letters and digits), so subjects read as TLX000-004.
const stem =
  name
    .split(/[^A-Za-z0-9]+/)
    .filter((s) => /[A-Za-z]/.test(s) && /\d/.test(s))
    .sort((a, b) => b.length - a.length)[0]
    ?.toUpperCase() ?? 'SYNTH'

// FNV-1a, so every draw is stable for a given UID and independent of traversal
// order — the same source tree always yields the same synthetic dataset.
function hash(key) {
  let h = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const pick = (list, key) => list[hash(key) % list.length]
const oneIn = (n, key) => n > 0 && hash(key) % n === 0

const pad = (n) => String(n).padStart(3, '0')

// SeriesNumber restarts per study, as it does in a real archive.
const seriesNumbers = new Map()
function seriesNumber(study, series) {
  let numbers = seriesNumbers.get(study)
  if (!numbers) {
    numbers = new Map()
    seriesNumbers.set(study, numbers)
  }
  if (!numbers.has(series)) numbers.set(series, numbers.size + 1)
  return numbers.get(series)
}

// One pass: name the directories and stamp every image file. Visit order comes
// from directory position so a subject's studies progress in time; everything
// else is drawn from the hashed UID it belongs to.
let subjects = 0
function stamp(nodes, depth, subject, visit) {
  let ordinal = 0
  const strays = []
  for (const node of nodes) {
    if (Array.isArray(node.children)) {
      ordinal++
      // Subject directories are numbered globally, not per site, so the path
      // agrees with the PatientID stamped beneath it.
      const nested = depth === SUBJECT_DEPTH ? ++subjects : subject
      node.name = `${LABELS[depth] ?? 'DIR'}-${pad(depth === SUBJECT_DEPTH ? nested : ordinal)}`
      stamp(
        node.children,
        depth + 1,
        nested,
        depth === SUBJECT_DEPTH + 1 ? ordinal : visit,
      )
      continue
    }
    const study = node.tags?.StudyInstanceUID
    if (!study) continue // non-DICOM placeholder: no tags, no group
    const series = node.tags.SeriesInstanceUID
    const modality = node.modality ?? 'CT'
    const [manufacturer, model] = pick(SCANNERS, study)
    node.tags = {
      ...node.tags,
      PatientID: `${stem}-${pad(subject)}`,
      PatientName: `SYNTH^${pad(subject)}`,
      PatientSex: pick(['M', 'F'], `sex${subject}`),
      AccessionNumber: `ACC${pad(subject)}${pad(visit)}`,
      StudyDescription: `${VISITS[(visit - 1) % VISITS.length]} ${modality}`,
      StudyDate: `2026${pad((visit % 12) + 1).slice(1)}${pad((subject % 28) + 1).slice(1)}`,
      SeriesNumber: seriesNumber(study, series),
      SeriesDescription: pick(
        SERIES_DESCRIPTIONS[modality] ?? [modality],
        series,
      ),
      Manufacturer: manufacturer,
      ManufacturerModelName: model,
    }

    // Variation, drawn per file from its own UID. large-image entries accept
    // neither violations nor transferSyntax, so only touch plain images.
    const sop = node.tags.SOPInstanceUID ?? series
    if (node.type === 'valid-image') {
      if (oneIn(IMPLICIT_VR_RATE, `vr${series}`)) {
        node.transferSyntax = 'implicit-vr-little-endian'
      }
      if (oneIn(VIOLATION_RATE, `bad${sop}`)) {
        node.violations = [pick(VIOLATIONS, sop)]
      }
    }
    // Unnamed, so the writer assigns a positional name and nothing collides.
    if (oneIn(STRAY_RATE, `stray${sop}`)) strays.push({ ...pick(STRAYS, sop) })
  }
  nodes.push(...strays)
}

const { spec, stats } = describeDirectory(source, { captureTree: true })
stamp(spec.tree, 0, 1, 1)
spec.seed = 20260730 // fixed, so re-running reproduces the dataset byte for byte
if (PATH_QUIRKS.length) spec.pathQuirks = PATH_QUIRKS

const manifest = await writeCollectionFromSpec(spec, `${outDir}/${name}`)
console.error(
  `Described ${stats.dicomFiles} DICOM + ${stats.nonDicomFiles} non-DICOM file(s), ` +
    `skipped ${stats.skipped}`,
)
console.error(
  `Wrote ${manifest.length} file(s) for ${subjects} subject(s) to ${outDir}/${name}`,
)
