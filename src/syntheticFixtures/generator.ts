import type * as Dcmjs from 'dcmjs'
import { buildHexToKeyword } from '../dicomDictionary.js'
import { dcmjs } from '../loadDcmjs.js'
import { buildDicomdirBuffer } from '../nonStandardDicom/dicomdir.js'
import type {
  DicomTagOverrides,
  FileSpec,
  ImageSpec,
  Modality,
  NonDicomSpec,
  TransferSyntax,
} from '../schema/types.js'
import { HEX_TAG_RE, isRawTagValue } from '../schema/validate.js'
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

// Resolves the raw hex tag escape hatch to keywords at generation time.
const tagToKeyword = buildHexToKeyword()

// A dict-level element in dcmjs's raw shape; SQ items are maps of hex tags to
// further RawElements. Assigned verbatim onto the serialised dict, bypassing
// the keyword dictionary — how private tags and deliberate mis-encodings are
// written.
export type RawElement = { vr: string; Value: unknown[] }
export type RawElementMap = Record<string, RawElement>

// Spec raw form ({ vr, value }) → dict form ({ vr, Value: […] }), recursing
// into SQ items. Value shape is validated at the schema boundary.
function toRawElement(raw: { vr: string; value: unknown }): RawElement {
  const value =
    raw.vr === 'SQ'
      ? (raw.value as Record<string, { vr: string; value: unknown }>[]).map(
          (item) =>
            Object.fromEntries(
              Object.entries(item).map(([tag, nested]) => [
                tag.toUpperCase(),
                toRawElement(nested),
              ]),
            ),
        )
      : raw.value
  return { vr: raw.vr, Value: Array.isArray(value) ? value : [value] }
}

// Applies keyword-resolvable overrides to the naturalised dataset and returns
// the raw-form entries (private tags, deliberate mis-encodings) for direct
// dict injection at serialisation. An unknown even-group hex tag with a plain
// value throws — the dictionary cannot supply its VR, so it must use the raw
// form.
export function applyTagOverrides(
  dataset: Record<string, unknown>,
  tags: DicomTagOverrides | undefined,
): RawElementMap | undefined {
  if (!tags) return undefined
  let raw: RawElementMap | undefined
  for (const [key, value] of Object.entries(tags)) {
    if (isRawTagValue(value)) {
      raw ??= {}
      raw[key.toUpperCase()] = toRawElement(value)
    } else if (HEX_TAG_RE.test(key)) {
      const keyword = tagToKeyword.get(key.toUpperCase())
      if (!keyword) {
        throw new Error(
          `dicom-synth: unknown hex tag "${key}" — dictionary tags take plain values; private/unknown tags require the raw { vr, value } form`,
        )
      }
      dataset[keyword] = value
    } else {
      dataset[key] = value
    }
  }
  return raw
}

// The scalar string a raw element would write for a given tag, if any.
function rawScalarString(
  rawElements: RawElementMap | undefined,
  tag: string,
): string | undefined {
  const value = rawElements?.[tag]?.Value
  return value?.length === 1 && typeof value[0] === 'string'
    ? value[0]
    : undefined
}

// PS3.10 requires the file meta group to mirror the dataset's SOP identifiers.
// A tag override that rewrites them (e.g. describe's hashed SOPInstanceUID)
// must flow into the meta header too, or the two diverge. Raw-form overrides
// of the same tags win over the dataset, mirroring their write-time precedence.
export function syncMetaWithDataset(
  meta: Record<string, unknown>,
  dataset: Record<string, unknown>,
  rawElements?: RawElementMap,
): void {
  const sopInstance =
    rawScalarString(rawElements, '00080018') ??
    (typeof dataset.SOPInstanceUID === 'string'
      ? dataset.SOPInstanceUID
      : undefined)
  if (sopInstance !== undefined) {
    meta.MediaStorageSOPInstanceUID = sopInstance
  }
  const sopClass =
    rawScalarString(rawElements, '00080016') ??
    (typeof dataset.SOPClassUID === 'string' ? dataset.SOPClassUID : undefined)
  if (sopClass !== undefined) {
    meta.MediaStorageSOPClassUID = sopClass
  }
}

export function buildMeta(
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

export function buildBaseImageDataset(
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

// rawElements are assigned onto the denaturalised dict verbatim (the
// dictionary would drop or mangle them) — a raw entry for a dictionary tag
// overwrites the naturalised element, which is the mis-encoding escape hatch.
export function serializeDict(
  meta: Record<string, unknown>,
  dataset: Record<string, unknown>,
  rawElements?: RawElementMap,
): Buffer {
  const dicomDict = new dcmjs.data.DicomDict(
    dcmjs.data.DicomMetaDictionary.denaturalizeDataset(
      meta,
    ) as Dcmjs.data.DicomDataset,
  )
  dicomDict.dict = dcmjs.data.DicomMetaDictionary.denaturalizeDataset(
    dataset,
  ) as Dcmjs.data.DicomDataset
  if (rawElements) {
    Object.assign(dicomDict.dict as Record<string, unknown>, rawElements)
  }
  return Buffer.from(dicomDict.write({ allowInvalidVRLength: true }))
}

// US (unsigned short) VR limit for Rows/Columns.
const MAX_DIMENSION = 65535

// targetSizeKb: probe-serialize to measure the non-pixel overhead (varies
// with tags/transfer syntax), then pad PixelData to land at ~targetSizeKb.
function applySizing(
  dataset: Record<string, unknown>,
  meta: Record<string, unknown>,
  spec: ImageSpec,
  rawElements?: RawElementMap,
): void {
  if (spec.targetSizeKb !== undefined) {
    const clampDim = (n: number) =>
      Math.min(MAX_DIMENSION, Math.max(1, Math.round(n)))
    const minimalPixelBytes = (dataset.PixelData as ArrayBuffer).byteLength
    const overhead =
      serializeDict(meta, dataset, rawElements).length - minimalPixelBytes
    const cells = Math.max(
      1,
      Math.round((spec.targetSizeKb * 1024 - overhead) / 2),
    )
    const rows = clampDim(Math.sqrt(cells))
    const columns = clampDim(cells / rows)
    dataset.Rows = rows
    dataset.Columns = columns
    dataset.PixelData = new ArrayBuffer(rows * columns * 2)
  } else if (spec.rows !== undefined && spec.columns !== undefined) {
    dataset.Rows = spec.rows
    dataset.Columns = spec.columns
    if (spec.frames !== undefined) dataset.NumberOfFrames = spec.frames
    // 16-bit pixels, 2 bytes per cell
    dataset.PixelData = new ArrayBuffer(
      spec.rows * spec.columns * (spec.frames ?? 1) * 2,
    )
  }
}

function buildImageBuffer(
  spec: ImageSpec,
  uid: UidSet,
): { buffer: Buffer; rawElements?: RawElementMap } {
  const modality = spec.modality ?? 'CT'

  // UIDs contain the string "study"/"series"/"sop" — non-numeric, non-conformant.
  const effectiveUid =
    spec.type === 'invalid-uid-image'
      ? {
          study: `2.25.invalid.study.${uid.study.slice(-6)}`,
          series: `2.25.invalid.series.${uid.series.slice(-6)}`,
          sop: `2.25.invalid.sop.${uid.sop.slice(-6)}`,
        }
      : uid

  const dataset = buildBaseImageDataset(effectiveUid, modality)
  if (spec.type === 'vendor-warnings-image') {
    // Vendor defaults set first so that user tag overrides can win.
    dataset.Laterality = ''
    dataset.PatientWeight = '0'
  }
  const rawElements = applyTagOverrides(dataset, spec.tags)

  // Sizing after tag overrides so the probe measures the final overhead.
  const meta = buildMeta(effectiveUid, modality, spec.transferSyntax)
  syncMetaWithDataset(meta, dataset, rawElements)
  applySizing(dataset, meta, spec, rawElements)
  return { buffer: serializeDict(meta, dataset, rawElements), rawElements }
}

function buildFakeSignatureBuffer(): Buffer {
  const buf = Buffer.alloc(200, 0)
  buf.write('XXXX', 128, 4, 'ascii')
  return buf
}

// The exact byte size of a sized non-dicom placeholder, or undefined for the
// content/marker forms — lets previews report the size without materialising.
export function sizedNonDicomBytes(spec: NonDicomSpec): number | undefined {
  return (
    spec.targetBytes ??
    (spec.targetSizeKb !== undefined ? spec.targetSizeKb * 1024 : undefined)
  )
}

// Sized form emits deterministic placeholder bytes — real file content is
// never reproduced.
function buildNonDicomBuffer(spec: NonDicomSpec): Buffer {
  const bytes = sizedNonDicomBytes(spec)
  if (bytes !== undefined) return Buffer.alloc(bytes, 'not dicom ')
  return Buffer.from(spec.content ?? 'not dicom', 'utf8')
}

// rawElements accompany image buffers so the violations pass (which re-parses
// through the dictionary and would drop them) can re-apply them.
export function buildBufferForSpec(
  spec: FileSpec,
  uid: UidSet,
): { buffer: Buffer; rawElements?: RawElementMap } {
  switch (spec.type) {
    case 'valid-image':
    case 'invalid-uid-image':
    case 'vendor-warnings-image':
      return buildImageBuffer(spec, uid)
    case 'fake-signature':
      return { buffer: buildFakeSignatureBuffer() }
    case 'non-dicom':
      return { buffer: buildNonDicomBuffer(spec) }
    case 'dicomdir':
      return { buffer: buildDicomdirBuffer() }
    case 'large-image':
      throw new Error(
        'large-image cannot be generated in memory — use writeCollectionFromSpec (disk-only streaming)',
      )
  }
}
