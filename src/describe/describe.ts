import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dcmjs } from '../loadDcmjs.js'
import type {
  DatasetSpec,
  DicomTagOverrides,
  Modality,
  SeriesEntrySpec,
  SeriesSpec,
  StudySpec,
} from '../schema/types.js'
import { validateDatasetSpec } from '../schema/validate.js'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: { readFile: (ab: ArrayBuffer) => { dict: unknown } }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
      nameMap?: Record<string, { tag?: string }>
    }
  }
}

const HEX_TAG_RE = /^[0-9a-fA-F]{8}$/
const SUPPORTED_MODALITIES = new Set<Modality>(['CT', 'PT', 'MR', 'CR'])

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
// silently matching nothing.
function resolveKeepTags(keepTags: string[]): string[] {
  const nameMap = dcmjsAny.data.DicomMetaDictionary.nameMap
  let hexToKeyword: Map<string, string> | undefined
  return keepTags.map((tag) => {
    if (HEX_TAG_RE.test(tag)) {
      hexToKeyword ??= buildHexToKeyword()
      const keyword = hexToKeyword.get(tag.toUpperCase())
      if (!keyword) {
        throw new Error(`describe: unknown hex tag "${tag}"`)
      }
      return keyword
    }
    if (nameMap && !Object.hasOwn(nameMap, tag)) {
      throw new Error(`describe: unknown tag keyword "${tag}"`)
    }
    return tag
  })
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

function parseFile(
  path: string,
): { record: Record<string, unknown>; size: number } | null {
  try {
    const buf = readFileSync(path)
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer
    const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
    const record = dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(
      parsed.dict,
    )
    return { record, size: buf.byteLength }
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
    if (value !== undefined) {
      tags[keyword] = value
      found = true
    }
  }
  return found ? tags : undefined
}

type EntryAccum = {
  modality?: Modality
  targetSizeKb: number
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
    const parsed = parseFile(path)
    const studyUid = parsed?.record.StudyInstanceUID
    const seriesUid = parsed?.record.SeriesInstanceUID
    if (
      !parsed ||
      typeof studyUid !== 'string' ||
      typeof seriesUid !== 'string'
    ) {
      stats.skipped++
      continue
    }
    const { record } = parsed
    stats.dicomFiles++

    let modality: Modality | undefined
    if (typeof record.Modality === 'string') {
      if (SUPPORTED_MODALITIES.has(record.Modality as Modality)) {
        modality = record.Modality as Modality
      } else {
        stats.unknownModality++
      }
    }

    const sizeKb = Math.max(1, Math.round(parsed.size / 1024))
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

    // Collapse files into one counted entry only when modality, size, and kept
    // tags all match — so tag/size variation within a series is preserved.
    const collapseKey = JSON.stringify([modality ?? null, sizeKb, tags ?? null])
    const existing = series.get(collapseKey)
    if (existing) {
      existing.count++
    } else {
      series.set(collapseKey, {
        modality,
        targetSizeKb: sizeKb,
        tags,
        count: 1,
      })
    }
  }

  const studySpecs: StudySpec[] = [...studies.values()].map((study) => {
    const seriesSpecs: SeriesSpec[] = [...study.values()].map((series) => {
      const entries: SeriesEntrySpec[] = [...series.values()].map((acc) => ({
        type: 'valid-image',
        ...(acc.modality !== undefined ? { modality: acc.modality } : {}),
        targetSizeKb: acc.targetSizeKb,
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
