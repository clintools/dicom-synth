#!/usr/bin/env node
// Example: convert a "data shape" JSON (exported tree description of a real
// trial dataset) into a dicom-synth DatasetSpec.
//
// Shape format walked here:
//   sites[] → patients[] → timepoints[] → modalities[] → <phase>.series →
//   Series_NNNN.files[] ({ name: "NNNNN.dcm", size_kb })
//
// Each (patient, timepoint, modality) becomes one study; each Series_NNNN one
// series; per-file size_kb becomes targetSizeKb. Non-DICOM root files (logs,
// CSVs, caches) are skipped — dicom-synth generates DICOM artefacts only.
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

// Collapse a series' file list into entries, grouping equal sizes via count.
function seriesEntries(files, modality) {
  const counts = new Map()
  for (const file of files) {
    if (!file.name?.endsWith('.dcm')) continue
    const sizeKb = Math.max(1, Math.round(file.size_kb ?? 1))
    counts.set(sizeKb, (counts.get(sizeKb) ?? 0) + 1)
  }
  return [...counts.entries()].map(([targetSizeKb, count]) => ({
    type: 'valid-image',
    ...(modality ? { modality } : {}),
    targetSizeKb,
    ...(count > 1 ? { count } : {}),
  }))
}

const studies = []
let skippedModalities = 0

for (const site of shape.sites ?? []) {
  for (const patient of site.patients ?? []) {
    for (const timepoint of patient.timepoints ?? []) {
      for (const modalityNode of timepoint.modalities ?? []) {
        const modality = MODALITY_MAP[modalityNode.name]
        if (!modality) {
          skippedModalities++
          continue
        }
        // Walk every phase (processed, raw, …) that carries a series map.
        const series = []
        for (const phase of Object.values(modalityNode)) {
          if (typeof phase !== 'object' || phase === null || !phase.series)
            continue
          for (const seriesNode of Object.values(phase.series)) {
            const entries = seriesEntries(seriesNode.files ?? [], modality)
            if (entries.length > 0) series.push({ entries })
          }
        }
        if (series.length === 0) continue
        studies.push({
          series,
          tags: {
            PatientID: patient.name,
            StudyDescription: `${timepoint.name} ${modalityNode.name}`,
          },
        })
      }
    }
  }
}

if (studies.length === 0) {
  console.error('No DICOM series found in shape input')
  process.exit(1)
}
if (skippedModalities > 0) {
  console.error(`Skipped ${skippedModalities} modality node(s) with no preset`)
}

const spec = { studies, layout: 'hierarchical' }
const json = `${JSON.stringify(spec, null, 2)}\n`

if (outPath) {
  writeFileSync(outPath, json)
  console.error(`Wrote DatasetSpec (${studies.length} studies) to ${outPath}`)
} else {
  process.stdout.write(json)
}
