#!/usr/bin/env node
// Example: convert a "data shape" JSON (exported tree description of a real
// trial dataset) into a dicom-synth DatasetSpec using the generic `tree`
// structure — the output reproduces the real directory nesting, mixed
// DICOM + non-DICOM files, and per-file sizes.
//
// Shape format walked here:
//   sites[] → patients[] → timepoints[] → modalities[] → <phase>.series →
//   Series_NNNN.files[] ({ name: "NNNNN.dcm", size_kb })
// Any node may also carry a files[] list of its own (logs, CSVs, caches) —
// those become sized `non-dicom` placeholders.
//
// Grouping: each (patient, timepoint, modality) directory is marked
// role: "study"; each Series_NNNN directory role: "series" — the generator
// mints the shared Study/SeriesInstanceUIDs from those markers. Names come
// from the shape JSON verbatim (it is pre-anonymised upstream).
//
// Usage: node examples/convert-data-shape.mjs <data-shape.json> [--out <spec.json>]
// Then:  dicom-synth-generate --schema <spec.json> --out <dir> [--dry-run]

import { readFileSync, writeFileSync } from 'node:fs'

const MODALITY_MAP = { PET: 'PT', CT: 'CT', MR: 'MR', MRI: 'MR', CR: 'CR' }

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
const outValueIndex = outIndex !== -1 ? outIndex + 1 : -1
const outPath = outIndex !== -1 ? args[outValueIndex] : undefined
const inputPath = args.find(
  (a, i) => !a.startsWith('--') && i !== outValueIndex,
)

if (!inputPath || (outIndex !== -1 && !outPath)) {
  console.error(
    'Usage: node examples/convert-data-shape.mjs <data-shape.json> [--out <spec.json>]',
  )
  process.exit(1)
}

const shape = JSON.parse(readFileSync(inputPath, 'utf8'))

let dicomFiles = 0
let nonDicomFiles = 0
let skippedModalities = 0

// A shape file entry → a tree file node. DICOM files become sized images
// (modality applies only inside a mapped-modality subtree); everything else
// becomes a sized non-dicom placeholder.
function fileNode(file, modality) {
  const sizeKb = Math.max(1, Math.round(file.size_kb ?? 1))
  if (file.name?.endsWith('.dcm')) {
    dicomFiles++
    return {
      type: 'valid-image',
      name: file.name,
      ...(modality ? { modality } : {}),
      targetSizeKb: sizeKb,
    }
  }
  nonDicomFiles++
  return {
    type: 'non-dicom',
    ...(file.name ? { name: file.name } : {}),
    targetSizeKb: sizeKb,
  }
}

function fileNodes(node, modality) {
  return (node.files ?? []).map((f) => fileNode(f, modality))
}

// File-less series produce no node — an empty directory is unrepresentable
// (the validator rejects empty children).
function seriesDirs(phase, modality) {
  return Object.entries(phase.series ?? {}).flatMap(([name, seriesNode]) => {
    const children = fileNodes(seriesNode, modality)
    return children.length > 0 ? [{ name, role: 'series', children }] : []
  })
}

// A modality directory → role: "study" (one study per patient/timepoint/
// modality). Phases (processed, raw, …) are plain directories beneath it.
function modalityDir(modalityNode, patient, timepoint) {
  const modality = MODALITY_MAP[modalityNode.name]
  if (!modality) skippedModalities++
  const children = [...fileNodes(modalityNode, modality)]
  for (const [phaseName, phase] of Object.entries(modalityNode)) {
    if (typeof phase !== 'object' || phase === null || !phase.series) continue
    const phaseChildren = [
      ...fileNodes(phase, modality),
      ...seriesDirs(phase, modality),
    ]
    if (phaseChildren.length > 0) {
      children.push({ name: phaseName, children: phaseChildren })
    }
  }
  if (children.length === 0) return undefined
  return {
    name: modalityNode.name,
    role: 'study',
    tags: {
      PatientID: patient.name,
      StudyDescription: `${timepoint.name} ${modalityNode.name}`,
    },
    children,
  }
}

function dir(name, children) {
  return children.length > 0 ? [{ name, children }] : []
}

const tree = [...fileNodes(shape)]
for (const site of shape.sites ?? []) {
  const siteChildren = [...fileNodes(site)]
  for (const patient of site.patients ?? []) {
    const patientChildren = [...fileNodes(patient)]
    for (const timepoint of patient.timepoints ?? []) {
      const timepointChildren = [...fileNodes(timepoint)]
      for (const modalityNode of timepoint.modalities ?? []) {
        const study = modalityDir(modalityNode, patient, timepoint)
        if (study) timepointChildren.push(study)
      }
      patientChildren.push(...dir(timepoint.name, timepointChildren))
    }
    siteChildren.push(...dir(patient.name, patientChildren))
  }
  tree.push(...dir(site.name, siteChildren))
}

if (dicomFiles === 0 && nonDicomFiles === 0) {
  console.error('No files found in shape input')
  process.exit(1)
}
if (skippedModalities > 0) {
  console.error(
    `${skippedModalities} modality node(s) have no preset — their images generate as the default (CT)`,
  )
}

const spec = { tree }
const json = `${JSON.stringify(spec, null, 2)}\n`

if (outPath) {
  writeFileSync(outPath, json)
  console.error(
    `Wrote DatasetSpec (${dicomFiles} DICOM + ${nonDicomFiles} non-DICOM files) to ${outPath}`,
  )
} else {
  process.stdout.write(json)
}
