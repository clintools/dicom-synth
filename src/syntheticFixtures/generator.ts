import type * as Dcmjs from 'dcmjs'
import { dcmjs } from '../loadDcmjs.js'
import { buildDicomdirBuffer } from '../nonStandardDicom/dicomdir.js'
import type {
  DicomTagOverrides,
  FileSpec,
  Modality,
  TransferSyntax,
} from '../schema/types.js'
import { HEX_TAG_RE } from '../schema/validate.js'
import type { UidSet } from './uid.js'

// SOP Class UID plus the minimal modality-specific type-1 attributes needed
// for shape/variance fidelity (not clinical fidelity).
const MODALITY_PRESETS: Record<
  Modality,
  { sopClassUid: string; attributes: Record<string, unknown> }
> = {
  CT: {
    sopClassUid: '1.2.840.10008.5.1.4.1.1.2', // CT Image Storage
    attributes: {},
  },
  PT: {
    sopClassUid: '1.2.840.10008.5.1.4.1.1.128', // PET Image Storage
    attributes: {
      Units: 'BQML',
      DecayCorrection: 'NONE',
      CorrectedImage: ['ATTN', 'DECY'],
    },
  },
  MR: {
    sopClassUid: '1.2.840.10008.5.1.4.1.1.4', // MR Image Storage
    attributes: {
      ScanningSequence: 'SE',
      SequenceVariant: 'NONE',
    },
  },
  CR: {
    sopClassUid: '1.2.840.10008.5.1.4.1.1.1', // CR Image Storage
    attributes: {},
  },
}

const TRANSFER_SYNTAX_UID: Record<TransferSyntax, string> = {
  'explicit-vr-little-endian': '1.2.840.10008.1.2.1',
  'implicit-vr-little-endian': '1.2.840.10008.1.2',
}

// Build a reverse map from 8-hex-char tag (e.g. "00080060") to DICOM keyword.
// Used to resolve the tags escape hatch at generation time.
function buildTagToKeyword(): Map<string, string> {
  const map = new Map<string, string>()
  const nm = (
    dcmjs as unknown as {
      data?: {
        DicomMetaDictionary?: { nameMap?: Record<string, { tag?: string }> }
      }
    }
  ).data?.DicomMetaDictionary?.nameMap
  if (!nm) return map
  for (const [keyword, info] of Object.entries(nm)) {
    if (info?.tag) {
      const hex = info.tag.replace(/[(,)]/g, '').toUpperCase()
      if (hex.length === 8) map.set(hex, keyword)
    }
  }
  return map
}

const tagToKeyword = buildTagToKeyword()

function applyTagOverrides(
  dataset: Record<string, unknown>,
  tags: DicomTagOverrides | undefined,
): void {
  if (!tags) return
  for (const [key, value] of Object.entries(tags)) {
    if (HEX_TAG_RE.test(key)) {
      const keyword = tagToKeyword.get(key.toUpperCase())
      if (keyword) {
        dataset[keyword] = value
      } else {
        console.warn(`dicom-synth: unknown hex tag "${key}" — skipping`)
      }
    } else {
      dataset[key] = value
    }
  }
}

function buildMeta(
  uid: UidSet,
  modality: Modality,
  transferSyntax: TransferSyntax = 'explicit-vr-little-endian',
): Record<string, unknown> {
  return {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    MediaStorageSOPClassUID: MODALITY_PRESETS[modality].sopClassUid,
    MediaStorageSOPInstanceUID: uid.sop,
    TransferSyntaxUID: TRANSFER_SYNTAX_UID[transferSyntax],
    ImplementationClassUID: '1.2.3.4',
    ImplementationVersionName: 'SYNTH',
  }
}

function buildBaseImageDataset(
  uid: UidSet,
  modality: Modality,
): Record<string, unknown> {
  const preset = MODALITY_PRESETS[modality]
  return {
    PatientName: 'SYNTH^SUBJECT',
    PatientID: 'SYNTH_PID',
    Modality: modality,
    SOPClassUID: preset.sopClassUid,
    SOPInstanceUID: uid.sop,
    SeriesInstanceUID: uid.series,
    StudyInstanceUID: uid.study,
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
    // Declares PixelData's VR explicitly — without it dcmjs logs
    // "No value representation given for PixelData" and falls back to OW anyway.
    _vrMap: { PixelData: 'OW' },
    ...preset.attributes,
  }
}

function serializeDict(
  meta: Record<string, unknown>,
  dataset: Record<string, unknown>,
): Buffer {
  const dicomDict = new dcmjs.data.DicomDict(
    dcmjs.data.DicomMetaDictionary.denaturalizeDataset(
      meta,
    ) as Dcmjs.data.DicomDataset,
  )
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(
    dataset,
  ) as Dcmjs.data.DicomDataset
  return Buffer.from(dicomDict.write({ allowInvalidVRLength: true }))
}

function buildValidImageBuffer(
  uid: UidSet,
  modality: Modality,
  tags?: DicomTagOverrides,
  transferSyntax?: TransferSyntax,
): Buffer {
  const dataset = buildBaseImageDataset(uid, modality)
  applyTagOverrides(dataset, tags)
  return serializeDict(buildMeta(uid, modality, transferSyntax), dataset)
}

function buildInvalidUidImageBuffer(
  uid: UidSet,
  modality: Modality,
  tags?: DicomTagOverrides,
  transferSyntax?: TransferSyntax,
): Buffer {
  // UIDs contain the string "study"/"series"/"sop" — non-numeric, non-conformant.
  const invalidUid = {
    study: `2.25.invalid.study.${uid.study.slice(-6)}`,
    series: `2.25.invalid.series.${uid.series.slice(-6)}`,
    sop: `2.25.invalid.sop.${uid.sop.slice(-6)}`,
  }
  const dataset = buildBaseImageDataset(invalidUid, modality)
  applyTagOverrides(dataset, tags)
  return serializeDict(buildMeta(invalidUid, modality, transferSyntax), dataset)
}

function buildVendorWarningsImageBuffer(
  uid: UidSet,
  modality: Modality,
  tags?: DicomTagOverrides,
  transferSyntax?: TransferSyntax,
): Buffer {
  // Vendor defaults set first so that user tag overrides can win.
  const dataset = buildBaseImageDataset(uid, modality)
  dataset.Laterality = ''
  dataset.PatientWeight = '0'
  applyTagOverrides(dataset, tags)
  return serializeDict(buildMeta(uid, modality, transferSyntax), dataset)
}

function buildLargeImageBuffer(
  uid: UidSet,
  modality: Modality,
  rows: number,
  columns: number,
  frames: number,
  tags?: DicomTagOverrides,
  transferSyntax?: TransferSyntax,
): Buffer {
  const dataset = buildBaseImageDataset(uid, modality)
  dataset.Rows = rows
  dataset.Columns = columns
  dataset.NumberOfFrames = frames
  // 16-bit signed, 2 bytes per pixel
  dataset.PixelData = new Uint8Array(rows * columns * frames * 2).buffer
  applyTagOverrides(dataset, tags)
  return serializeDict(buildMeta(uid, modality, transferSyntax), dataset)
}

function buildFakeSignatureBuffer(): Buffer {
  const buf = Buffer.alloc(200, 0)
  buf.write('XXXX', 128, 4, 'ascii')
  return buf
}

function buildNonDicomBuffer(content = 'not dicom'): Buffer {
  return Buffer.from(content, 'utf8')
}

export function buildBufferForSpec(spec: FileSpec, uid: UidSet): Buffer {
  switch (spec.type) {
    case 'valid-image':
      return buildValidImageBuffer(
        uid,
        spec.modality ?? 'CT',
        spec.tags,
        spec.transferSyntax,
      )
    case 'invalid-uid-image':
      return buildInvalidUidImageBuffer(
        uid,
        spec.modality ?? 'CT',
        spec.tags,
        spec.transferSyntax,
      )
    case 'vendor-warnings-image':
      return buildVendorWarningsImageBuffer(
        uid,
        spec.modality ?? 'CT',
        spec.tags,
        spec.transferSyntax,
      )
    case 'large-image':
      return buildLargeImageBuffer(
        uid,
        spec.modality ?? 'CT',
        spec.rows,
        spec.columns,
        spec.frames ?? 1,
        spec.tags,
        spec.transferSyntax,
      )
    case 'fake-signature':
      return buildFakeSignatureBuffer()
    case 'non-dicom':
      return buildNonDicomBuffer(spec.content)
    case 'dicomdir':
      return buildDicomdirBuffer()
  }
}
