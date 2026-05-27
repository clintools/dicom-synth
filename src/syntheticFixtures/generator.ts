/**
 * Deterministic synthetic DICOM fixtures.
 * No PHI - patient names and IDs are fixed literals only.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type * as Dcmjs from 'dcmjs'
import { dcmjs } from '../loadDcmjs.js'

const CT_SOP_CLASS = '1.2.840.10008.5.1.4.1.1.2'

export type SyntheticCtVariant =
  | 'minimal-invalid-uid'
  | 'valid-uid'
  | 'vendor-warnings'

const VARIANT_INDEX: Record<SyntheticCtVariant, number> = {
  'minimal-invalid-uid': 0,
  'valid-uid': 1,
  'vendor-warnings': 2,
}

function uidFor(
  variant: SyntheticCtVariant,
  role: 'study' | 'series' | 'sop',
): string {
  const i = VARIANT_INDEX[variant]
  if (variant === 'minimal-invalid-uid') {
    return `2.25.100000000000000000000000000000.${role}.${i}`
  }
  const uidRoots = [
    '1000000000000000000000000000000000001',
    '1000000000000000000000000000000000002',
    '1000000000000000000000000000000000003',
  ] as const
  const roleSuffix = role === 'study' ? 1 : role === 'series' ? 2 : 3
  return `2.25.${uidRoots[i]}.${roleSuffix}`
}

function naturalDataset(variant: SyntheticCtVariant): Record<string, unknown> {
  const studyUID = uidFor(variant, 'study')
  const seriesUID = uidFor(variant, 'series')
  const sopUID = uidFor(variant, 'sop')

  const dataset: Record<string, unknown> = {
    PatientName: 'SYNTH^SUBJECT',
    PatientID: 'SYNTH_PID',
    Modality: 'CT',
    SOPClassUID: CT_SOP_CLASS,
    SOPInstanceUID: sopUID,
    SeriesInstanceUID: seriesUID,
    StudyInstanceUID: studyUID,
    StudyDescription: 'Synthetic study',
    SeriesDescription: 'Synthetic series',
    Rows: 1,
    Columns: 1,
    BitsAllocated: 16,
    BitsStored: 16,
    HighBit: 15,
    SamplesPerPixel: 1,
    PhotometricInterpretation: 'MONOCHROME2',
    PixelRepresentation: 0,
    PixelData: new Uint8Array([0, 0]).buffer,
  }

  if (variant === 'vendor-warnings') {
    dataset.Laterality = ''
    dataset.PatientWeight = '0'
  }

  return dataset
}

export function buildDicomDict(
  variant: SyntheticCtVariant,
): Dcmjs.data.DicomDict {
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: CT_SOP_CLASS,
    MediaStorageSOPInstanceUID: uidFor(variant, 'sop'),
    TransferSyntaxUID: '1.2.840.10008.1.2.1',
    ImplementationClassUID: '1.2.3.4',
    ImplementationVersionName: 'SYNTH',
  }
  const dicomDict = new dcmjs.data.DicomDict(
    dcmjs.data.DicomMetaDictionary.denaturalizeDataset(meta),
  )
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(
    naturalDataset(variant),
  )
  return dicomDict
}

export function buildSyntheticCtBuffer(variant: SyntheticCtVariant): Buffer {
  return Buffer.from(
    buildDicomDict(variant).write({ allowInvalidVRLength: true }),
  )
}

export const SYNTHETIC_FIXTURES: {
  filename: string
  variant: SyntheticCtVariant
  description: string
}[] = [
  {
    filename: 'minimal-ct-0.dcm',
    variant: 'minimal-invalid-uid',
    description: 'Minimal CT with text in UIDs (many dciodvfy errors)',
  },
  {
    filename: 'valid-uid-ct-0.dcm',
    variant: 'valid-uid',
    description: 'Minimal CT with numeric UIDs only (missing-module noise)',
  },
  {
    filename: 'vendor-warnings-ct-0.dcm',
    variant: 'vendor-warnings',
    description: 'Valid UIDs plus empty Laterality and zero PatientWeight',
  },
]

/** Write all catalogue fixtures to a directory (created if missing). */
export function writeSyntheticFixturesToDir(outDir: string): string[] {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })
  const written: string[] = []
  for (const { filename, variant } of SYNTHETIC_FIXTURES) {
    const path = resolve(root, filename)
    writeFileSync(path, buildSyntheticCtBuffer(variant))
    written.push(path)
  }
  return written
}
