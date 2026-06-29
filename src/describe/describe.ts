import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import { dcmjs } from '../loadDcmjs.js'
import { MAX_PIXEL_BYTES, MAX_STREAM_BYTES } from '../schema/limits.js'
import type {
  DatasetSpec,
  DicomTagOverrides,
  Modality,
  SeriesEntrySpec,
  SeriesSpec,
  StudySpec,
} from '../schema/types.js'
import { validateDatasetSpec } from '../schema/validate.js'
import { escapeTagTemplate } from '../syntheticFixtures/tagTemplate.js'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: { readFile: (ab: ArrayBuffer) => { dict: unknown } }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
      nameMap?: Record<string, { tag?: string; vr?: string }>
    }
  }
}

const HEX_TAG_RE = /^[0-9a-fA-F]{8}$/
const SUPPORTED_MODALITIES = new Set<Modality>(['CT', 'PT', 'MR', 'CR'])

// Modality type-1 preset attributes — owned by the modality preset, so dropped
// from any keep-list (reproduced from the captured `modality` field, not copied
// verbatim). SOPClassUID / *UID tags are excluded via their UI VR below.
// Modality itself is handled per-file in extractTags: reserved only when it is a
// preset value (CT/PT/MR/CR), kept verbatim otherwise (US, NM, …) so non-preset
// datasets round-trip.
const RESERVED_KEEP_KEYWORDS = new Set([
  'Units',
  'DecayCorrection',
  'CorrectedImage',
  'ScanningSequence',
  'SequenceVariant',
])

export type DescribeOptions = {
  // Allow-list of DICOM keyword names ("Manufacturer") or 8-hex tags
  // ("00080060") to copy verbatim into the emitted spec. When omitted, only
  // the dataset shape is reproduced (no tags). Tags are copied exactly as
  // found — if a kept tag contains PHI, handling that PHI is the caller's
  // responsibility, not this tool's.
  keepTags?: string[]
}

export type DescribeResult = {
  spec: DatasetSpec
  stats: {
    dicomFiles: number
    skipped: number // non-DICOM, unparseable, or missing grouping UIDs
    unknownModality: number // Modality present but not CT/PT/MR/CR
  }
}

function buildHexToKeyword(): Map<string, string> {
  const map = new Map<string, string>()
  const nm = dcmjsAny.data.DicomMetaDictionary.nameMap
  if (!nm) return map
  for (const [keyword, info] of Object.entries(nm)) {
    if (info?.tag) {
      const hex = info.tag.replace(/[(,)]/g, '').toUpperCase()
      if (hex.length === 8) map.set(hex, keyword)
    }
  }
  return map
}

// Resolve keepTags entries to DICOM keyword names, mapping hex tags via dcmjs
// and rejecting unknown tags (hex or keyword) so typos surface rather than
// silently matching nothing. Coupled (modality-preset) and UID-VR keywords are
// dropped with a warning — the former is reproduced from the `modality` field,
// the latter is handled by the (forthcoming) hash-derived UID path.
function resolveKeepTags(keepTags: string[]): string[] {
  const nameMap = dcmjsAny.data.DicomMetaDictionary.nameMap
  let hexToKeyword: Map<string, string> | undefined
  const kept: string[] = []
  for (const tag of keepTags) {
    let keyword: string
    if (HEX_TAG_RE.test(tag)) {
      hexToKeyword ??= buildHexToKeyword()
      const mapped = hexToKeyword.get(tag.toUpperCase())
      if (!mapped) {
        throw new Error(`describe: unknown hex tag "${tag}"`)
      }
      keyword = mapped
    } else {
      if (nameMap && !Object.hasOwn(nameMap, tag)) {
        throw new Error(`describe: unknown tag keyword "${tag}"`)
      }
      keyword = tag
    }
    if (RESERVED_KEEP_KEYWORDS.has(keyword)) {
      console.warn(
        `describe: ignoring keep-tag "${keyword}" — modality-coupled tags are reproduced from the modality field`,
      )
      continue
    }
    if (nameMap?.[keyword]?.vr === 'UI') {
      console.warn(
        `describe: ignoring keep-tag "${keyword}" — UID-valued tags are not kept verbatim`,
      )
      continue
    }
    kept.push(keyword)
  }
  return kept
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkFiles(path)
    } else if (entry.isFile()) {
      yield path
    }
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer
}

function naturalize(ab: ArrayBuffer): Record<string, unknown> {
  const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
  return dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict)
}

function parseFull(path: string): Record<string, unknown> | null {
  try {
    return naturalize(toArrayBuffer(readFileSync(path)))
  } catch {
    return null
  }
}

// PixelData (7FE0,0010) explicit-VR headers: tag + "OW" / "OB".
const PIXEL_DATA_OW = Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57])
const PIXEL_DATA_OB = Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42])
// Zero-length OW PixelData, substituted so dcmjs parses the metadata.
const EMPTY_OW_PIXEL_DATA = Buffer.from([
  0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
])
const HEADER_READ_BYTES = 2 * 1024 * 1024

// Finds the PixelData element header, requiring the two reserved bytes after the
// VR to be zero so a coincidental tag+VR byte sequence inside an earlier
// element's value is not mistaken for the element header. Returns the earliest
// valid OW/OB offset, or -1.
function findPixelDataOffset(prefix: Buffer): number {
  let best = -1
  for (const pattern of [PIXEL_DATA_OW, PIXEL_DATA_OB]) {
    for (let from = 0; ; ) {
      const i = prefix.indexOf(pattern, from)
      if (i < 0) break
      if (prefix[i + 6] === 0 && prefix[i + 7] === 0) {
        if (best < 0 || i < best) best = i
        break
      }
      from = i + 1
    }
  }
  return best
}

// Reads a DICOM's metadata without loading its pixel data: a bounded prefix is
// read, truncated at the PixelData element, and parsed with an empty PixelData.
// Lets describe handle multi-GB files (where readFileSync would OOM). Returns
// null for implicit-VR files or any file whose header is not in the prefix.
export function readHeaderOnly(path: string): Record<string, unknown> | null {
  let prefix: Buffer
  try {
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(HEADER_READ_BYTES)
      const n = readSync(fd, buf, 0, HEADER_READ_BYTES, 0)
      prefix = buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }

  const tagIdx = findPixelDataOffset(prefix)
  if (tagIdx < 0) return null

  const headerOnly = Buffer.concat([
    prefix.subarray(0, tagIdx),
    EMPTY_OW_PIXEL_DATA,
  ])
  try {
    return naturalize(toArrayBuffer(headerOnly))
  } catch {
    return null
  }
}

function extractTags(
  record: Record<string, unknown>,
  keepKeywords: string[],
): DicomTagOverrides | undefined {
  const tags: DicomTagOverrides = {}
  let found = false
  for (const keyword of keepKeywords) {
    const value = record[keyword]
    if (value === undefined) continue
    // A preset Modality is reproduced from the captured `modality` field, so it
    // is not kept verbatim; a non-preset Modality (US, NM, …) has no field route
    // and is kept so the dataset round-trips.
    if (
      keyword === 'Modality' &&
      typeof value === 'string' &&
      SUPPORTED_MODALITIES.has(value as Modality)
    ) {
      continue
    }
    // Escape braces so a real value containing them is reproduced verbatim
    // rather than being treated as a {placeholder} during regeneration.
    tags[keyword] = typeof value === 'string' ? escapeTagTemplate(value) : value
    found = true
  }
  return found ? tags : undefined
}

// Files above the in-memory cap become disk-only large-image entries (sized by
// targetBytes); others use targetSizeKb. Both derive from the raw file size.
type EntryAccum = {
  modality?: Modality
  large: boolean
  bytes: number
  tags?: DicomTagOverrides
  count: number
}

// Insertion-ordered maps — collapseKey → entry, seriesUid → series, studyUid → study.
type SeriesAccum = Map<string, EntryAccum>
type StudyAccum = Map<string, SeriesAccum>

// Scans a DICOM directory tree and emits a concrete DatasetSpec describing its
// shape: studies/series grouped by their UIDs, per-file size as targetSizeKb,
// and modality. Tags are only included when named in options.keepTags.
export function describeDirectory(
  dir: string,
  options: DescribeOptions = {},
): DescribeResult {
  const keepKeywords = options.keepTags ? resolveKeepTags(options.keepTags) : []

  const studies = new Map<string, StudyAccum>()
  const stats = { dicomFiles: 0, skipped: 0, unknownModality: 0 }

  // Sort paths for deterministic output independent of filesystem order.
  for (const path of [...walkFiles(dir)].sort()) {
    let size: number
    try {
      size = statSync(path).size
    } catch {
      stats.skipped++
      continue
    }
    // A single file beyond the 50 GB ceiling cannot be reproduced as a
    // large-image entry, so skip it rather than emit an un-revalidatable spec.
    if (size > MAX_STREAM_BYTES) {
      stats.skipped++
      continue
    }
    // Files above the in-memory cap are read header-only (never loaded whole)
    // and captured as disk-only large-image entries.
    const large = size > MAX_PIXEL_BYTES
    const record = large ? readHeaderOnly(path) : parseFull(path)
    const studyUid = record?.StudyInstanceUID
    const seriesUid = record?.SeriesInstanceUID
    if (
      !record ||
      typeof studyUid !== 'string' ||
      typeof seriesUid !== 'string'
    ) {
      stats.skipped++
      continue
    }
    stats.dicomFiles++

    let modality: Modality | undefined
    if (typeof record.Modality === 'string') {
      if (SUPPORTED_MODALITIES.has(record.Modality as Modality)) {
        modality = record.Modality as Modality
      } else {
        stats.unknownModality++
      }
    }

    const sizeKb = Math.max(1, Math.round(size / 1024))
    const tags = keepKeywords.length
      ? extractTags(record, keepKeywords)
      : undefined

    let study = studies.get(studyUid)
    if (!study) {
      study = new Map()
      studies.set(studyUid, study)
    }
    let series = study.get(seriesUid)
    if (!series) {
      series = new Map()
      study.set(seriesUid, series)
    }

    // Collapse files into one counted entry only when kind, modality, size, and
    // kept tags all match — so tag/size variation within a series is preserved.
    const collapseKey = JSON.stringify([
      large,
      modality ?? null,
      large ? size : sizeKb,
      tags ?? null,
    ])
    const existing = series.get(collapseKey)
    if (existing) {
      existing.count++
    } else {
      series.set(collapseKey, { modality, large, bytes: size, tags, count: 1 })
    }
  }

  const studySpecs: StudySpec[] = [...studies.values()].map((study) => {
    const seriesSpecs: SeriesSpec[] = [...study.values()].map((series) => {
      const entries: SeriesEntrySpec[] = [...series.values()].map((acc) => ({
        ...(acc.modality !== undefined ? { modality: acc.modality } : {}),
        ...(acc.large
          ? { type: 'large-image' as const, targetBytes: acc.bytes }
          : {
              type: 'valid-image' as const,
              targetSizeKb: Math.max(1, Math.round(acc.bytes / 1024)),
            }),
        ...(acc.tags !== undefined ? { tags: acc.tags } : {}),
        ...(acc.count > 1 ? { count: acc.count } : {}),
      }))
      return { entries }
    })
    return { series: seriesSpecs }
  })

  if (studySpecs.length === 0) {
    throw new Error(`describe: no DICOM series found in ${dir}`)
  }

  const spec: DatasetSpec = { studies: studySpecs, layout: 'hierarchical' }
  validateDatasetSpec(spec)
  return { spec, stats }
}
