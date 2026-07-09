import { createHash } from 'node:crypto'
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
  SeriesInstances,
  SeriesSpec,
  StudySpec,
} from '../schema/types.js'
import { validateDatasetSpec } from '../schema/validate.js'
import { escapeTagTemplate } from '../syntheticFixtures/tagTemplate.js'
import { hashUid } from '../syntheticFixtures/uid.js'

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
  // Relative size tolerance (fraction, e.g. 0.05 = ±5%) for collapsing
  // near-identical files: sizes within a bucket fold into one entry/value,
  // trading exact byte fidelity for a smaller spec. Default 0 = exact sizes.
  // Applied to normal images only; large files keep their exact targetBytes.
  sizeTolerance?: number
  // Preserve DICOM cross-file links PHI-safely (default true): every UID-valued
  // attribute is replaced by hashUid(uidSalt, original), so the same source UID
  // maps to the same synthetic UID everywhere (FrameOfReferenceUID stays shared,
  // etc.) and no original UID is emitted. Set false for shape-only, freshly
  // minted UIDs.
  preserveUids?: boolean
  // UID hashing salt (recorded in the emitted spec). When absent it is derived
  // from the dataset's own study UIDs, so a given tree always hashes to the same
  // synthetic UIDs (reproducible) while different datasets get disjoint UID
  // namespaces automatically. Pass an explicit salt to override that.
  uidSalt?: string
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

// DICOM standard UIDs (SOP classes, transfer syntaxes) share the org root and
// must not be hashed — they identify structure, not the subject.
const DICOM_ORG_ROOT = '1.2.840.10008.'
// Group UIDs are emitted at study/series level; SOPClassUID comes from the
// modality preset — none are swept into per-file tags. Top level only: the
// same keywords inside a sequence item are references and must be hashed.
const UID_SWEEP_EXCLUDE = new Set([
  'StudyInstanceUID',
  'SeriesInstanceUID',
  'SOPClassUID',
])

// Memoised: the dictionary is static, and the sweep looks the same keywords up
// per item per file across a whole dataset scan.
const vrCache = new Map<string, string | undefined>()
function vrOf(keyword: string): string | undefined {
  if (vrCache.has(keyword)) return vrCache.get(keyword)
  const nm = dcmjsAny.data.DicomMetaDictionary.nameMap
  const vr = (nm?.[keyword] ?? nm?.[`RETIRED_${keyword}`])?.vr as
    | string
    | undefined
  vrCache.set(keyword, vr)
  return vr
}

// Hash a source UID through the shared map so the same original always maps to
// the same synthetic (referential integrity by construction).
function hashUidVia(
  map: Map<string, string>,
  salt: string,
  original: string,
): string {
  let synthetic = map.get(original)
  if (synthetic === undefined) {
    synthetic = hashUid(salt, original)
    map.set(original, synthetic)
  }
  return synthetic
}

function isUidLeaf(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((v) => typeof v === 'string'))
  )
}

// True when a UI-VR leaf carries at least one UID that would be hashed —
// well-known org-root UIDs alone do not count.
function hasHashableUid(value: string | string[]): boolean {
  const uids = typeof value === 'string' ? [value] : value
  return uids.some((v) => !v.startsWith(DICOM_ORG_ROOT))
}

// Prunes a naturalised sequence to its UID reference skeleton: UI-VR leaves are
// kept (well-known org-root UIDs verbatim as scaffolding, the rest hashed
// later), nested sequences recurse, and every other attribute is dropped — so
// only hashed UIDs ever leave the dataset. Items (and whole sequences) with
// nothing hashable are dropped entirely.
function pruneUidSequence(
  value: unknown,
): Record<string, unknown>[] | undefined {
  // dcmjs may naturalise a single-item sequence as a bare object.
  const items = Array.isArray(value) ? value : [value]
  const pruned: Record<string, unknown>[] = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item))
      continue
    const skeleton: Record<string, unknown> = {}
    let hashable = false
    for (const [keyword, v] of Object.entries(item)) {
      if (keyword === '_vrMap') continue
      const vr = vrOf(keyword)
      if (vr === 'UI') {
        if (isUidLeaf(v)) {
          skeleton[keyword] = v
          if (hasHashableUid(v)) hashable = true
        }
      } else if (vr === 'SQ') {
        const nested = pruneUidSequence(v)
        if (nested) {
          skeleton[keyword] = nested
          hashable = true
        }
      }
    }
    if (hashable) pruned.push(skeleton)
  }
  return pruned.length > 0 ? pruned : undefined
}

// The original values of every UI-VR attribute — scalar, multi-valued, or
// nested inside a sequence (pruned to a UID-only skeleton). Group/class UIDs
// and well-known standard UIDs are excluded. Captured raw during the walk;
// hashed only once the salt is known (see hashUidTags).
function collectUidOriginals(
  record: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const uids: Record<string, unknown> = {}
  let found = false
  for (const [keyword, value] of Object.entries(record)) {
    if (UID_SWEEP_EXCLUDE.has(keyword)) continue
    const vr = vrOf(keyword)
    if (vr === 'UI') {
      if (isUidLeaf(value) && hasHashableUid(value)) {
        uids[keyword] = value
        found = true
      }
    } else if (vr === 'SQ') {
      const pruned = pruneUidSequence(value)
      if (pruned) {
        uids[keyword] = pruned
        found = true
      }
    }
  }
  return found ? uids : undefined
}

// Hash every UID inside a captured value (scalars, arrays, pruned skeletons);
// well-known org-root UIDs pass through verbatim, the rest via the shared map.
function hashUidValue(
  value: unknown,
  salt: string,
  map: Map<string, string>,
): unknown {
  if (typeof value === 'string') {
    return value.startsWith(DICOM_ORG_ROOT)
      ? value
      : hashUidVia(map, salt, value)
  }
  if (Array.isArray(value)) return value.map((v) => hashUidValue(v, salt, map))
  // Captured skeletons hold nothing but UID strings, arrays, and nested items.
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [
      k,
      hashUidValue(v, salt, map),
    ]),
  )
}

function hashUidTags(
  uids: Record<string, unknown>,
  salt: string,
  map: Map<string, string>,
): DicomTagOverrides {
  const tags: DicomTagOverrides = {}
  for (const [keyword, original] of Object.entries(uids)) {
    tags[keyword] = hashUidValue(original, salt, map)
  }
  return tags
}

// Default salt when none is supplied: a digest of the dataset's own (sorted)
// study UIDs. Deterministic for a given tree (reproducible), and disjoint across
// datasets (distinct study UIDs → distinct salt → distinct synthetic namespace).
function deriveSalt(studyUids: string[]): string {
  const h = createHash('sha256')
  for (const uid of [...studyUids].sort()) h.update(uid).update('\n')
  return h.digest('hex')
}

function mergeTags(
  a: DicomTagOverrides | undefined,
  b: DicomTagOverrides | undefined,
): DicomTagOverrides | undefined {
  if (!a) return b
  if (!b) return a
  return { ...a, ...b }
}

// One scanned file: kind, raw byte size, modality (supported presets only), and
// any kept tags. Records stay in instance (sorted-path) order so the emit step
// can choose the compact entries form or the Flywheel instances form per series.
type FileRecord = {
  large: boolean
  bytes: number
  modality?: Modality
  tags?: DicomTagOverrides
  // Raw UID values (scalars, arrays, pruned sequence skeletons) captured during
  // the walk; hashed into `tags` in a post-walk pass once the salt (which may
  // derive from every study UID) is known.
  uidOriginals?: Record<string, unknown>
}

type EntryAccum = {
  modality?: Modality
  large: boolean
  bytes: number
  tags?: DicomTagOverrides
  count: number
}

// Per series we hold EITHER an incremental collapse map (when no tags are kept —
// the instances form can never trigger, so files collapse on the fly and memory
// stays bounded by distinct entries) OR an ordered record list (when tags are
// kept, needed to detect per-instance variation and build the arrays).
type SeriesAccum = Map<string, EntryAccum> | FileRecord[]
type StudyAccum = Map<string, SeriesAccum>

function sizeKbOf(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1024))
}

// Rounds a byte count to the geometric midpoint of its relative bucket, so two
// sizes within ~tolerance land on the same representative and collapse. A
// tolerance of 0 (or a sub-byte input) is a no-op.
function bucketBytes(bytes: number, tolerance: number): number {
  if (tolerance <= 0 || bytes < 1) return bytes
  const factor = 1 + tolerance
  const bucket = Math.floor(Math.log(bytes) / Math.log(factor))
  return Math.max(1, Math.round(factor ** (bucket + 0.5)))
}

// Collapse key: files merge into one counted entry when kind, modality, size,
// and kept tags all match.
function collapseKeyOf(r: FileRecord): string {
  return JSON.stringify([
    r.large,
    r.modality ?? null,
    r.large ? r.bytes : sizeKbOf(r.bytes),
    r.tags ?? null,
  ])
}

function accumulate(byKey: Map<string, EntryAccum>, r: FileRecord): void {
  const key = collapseKeyOf(r)
  const existing = byKey.get(key)
  if (existing) {
    existing.count++
  } else {
    byKey.set(key, {
      modality: r.modality,
      large: r.large,
      bytes: r.bytes,
      tags: r.tags,
      count: 1,
    })
  }
}

// Files above the in-memory cap become disk-only large-image entries (sized by
// targetBytes); others use targetSizeKb. Both derive from the raw byte size.
function entryOf(acc: EntryAccum): SeriesEntrySpec {
  return {
    ...(acc.modality !== undefined ? { modality: acc.modality } : {}),
    ...(acc.large
      ? { type: 'large-image' as const, targetBytes: acc.bytes }
      : { type: 'valid-image' as const, targetSizeKb: sizeKbOf(acc.bytes) }),
    ...(acc.tags !== undefined ? { tags: acc.tags } : {}),
    ...(acc.count > 1 ? { count: acc.count } : {}),
  }
}

// Compact entries form built from an ordered record list; insertion order kept.
function collapseEntries(records: FileRecord[]): SeriesEntrySpec[] {
  const byKey = new Map<string, EntryAccum>()
  for (const r of records) accumulate(byKey, r)
  return [...byKey.values()].map(entryOf)
}

// Cheap value equality for kept tags: scalars (the common case) compare with
// ===; only non-null objects/arrays (e.g. multi-valued or sequence tags) need
// the costlier structural compare. Exported for unit testing.
export function tagValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (
    typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null
  )
    return JSON.stringify(a) === JSON.stringify(b)
  return false
}

// Flywheel form: used only when a kept tag genuinely varies across the series
// AND the series is otherwise uniform enough to express as parallel arrays
// (single kind, single modality, every kept tag present in every file).
// Constant tags hoist to series.tags; varying tags become per-instance arrays
// indexed by file position — preserving cross-tag correlation. Returns null to
// fall back to the entries form.
function tryInstancesForm(records: FileRecord[]): SeriesSpec | null {
  const count = records.length
  if (count === 0) return null
  const large = records[0]?.large ?? false
  const modality = records[0]?.modality

  // Single pass: gather each kept tag's values by file position, count its
  // presence, and bail early if the series is not one kind / one modality.
  const columns = new Map<string, { values: unknown[]; present: number }>()
  for (let i = 0; i < count; i++) {
    const r = records[i] as FileRecord
    if (r.large !== large || r.modality !== modality) return null
    if (!r.tags) continue
    for (const [k, v] of Object.entries(r.tags)) {
      let col = columns.get(k)
      if (!col) {
        col = { values: new Array(count), present: 0 }
        columns.set(k, col)
      }
      col.values[i] = v
      col.present++
    }
  }
  if (columns.size === 0) return null

  const sharedTags: DicomTagOverrides = {}
  const perInstanceTags: Record<string, unknown[]> = {}
  for (const [k, col] of columns) {
    // A tag absent in some files (mixed presence) can't be a clean array.
    if (col.present !== count) return null
    const first = col.values[0]
    if (col.values.every((v) => tagValuesEqual(v, first))) {
      sharedTags[k] = first
    } else {
      perInstanceTags[k] = col.values
    }
  }
  if (Object.keys(perInstanceTags).length === 0) return null // nothing varies

  const instances: SeriesInstances = {
    count,
    ...(large
      ? { targetBytes: records.map((r) => r.bytes) }
      : { targetSizeKb: records.map((r) => sizeKbOf(r.bytes)) }),
    ...(modality !== undefined ? { modality } : {}),
    // perInstanceTags is non-empty here (we returned null above otherwise).
    tags: perInstanceTags,
  }
  return {
    instances,
    ...(Object.keys(sharedTags).length ? { tags: sharedTags } : {}),
  }
}

function buildSeriesSpec(records: FileRecord[]): SeriesSpec {
  return tryInstancesForm(records) ?? { entries: collapseEntries(records) }
}

function seriesSpecFromAccum(accum: SeriesAccum): SeriesSpec {
  return Array.isArray(accum)
    ? buildSeriesSpec(accum)
    : { entries: [...accum.values()].map(entryOf) }
}

// Scans a DICOM directory tree and emits a concrete DatasetSpec describing its
// shape: studies/series grouped by their UIDs, per-file size as targetSizeKb,
// and modality. Tags are only included when named in options.keepTags.
export function describeDirectory(
  dir: string,
  options: DescribeOptions = {},
): DescribeResult {
  const keepKeywords = options.keepTags ? resolveKeepTags(options.keepTags) : []

  const preserveUids = options.preserveUids ?? true
  // One map for the whole tree — same source UID → same synthetic everywhere.
  const uidMap = new Map<string, string>()

  // Per-file records are needed for the instances form (kept tags) and for
  // hashed per-file UIDs; otherwise we collapse on the fly (see SeriesAccum).
  const useRecords = keepKeywords.length > 0 || preserveUids

  const tolerance = options.sizeTolerance ?? 0
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(
      `describe: sizeTolerance must be a non-negative fraction; got ${JSON.stringify(options.sizeTolerance)}`,
    )
  }

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

    const keptTags = keepKeywords.length
      ? extractTags(record, keepKeywords)
      : undefined
    // UIDs are captured raw here and hashed after the walk, once the salt
    // (which may derive from every study UID) is known.
    const uidOriginals = preserveUids ? collectUidOriginals(record) : undefined
    // Large files keep exact targetBytes; normal images bucket by tolerance,
    // clamped to the 512 MB cap so a near-cap file's bucket can't round over it
    // (which would fail validation). Over-cap buckets all clamp to the cap, so
    // they still collapse together.
    const bytes = large
      ? size
      : Math.min(bucketBytes(size, tolerance), MAX_PIXEL_BYTES)
    const fileRecord: FileRecord = {
      large,
      bytes,
      modality,
      tags: keptTags,
      uidOriginals,
    }

    let study = studies.get(studyUid)
    if (!study) {
      study = new Map()
      studies.set(studyUid, study)
    }
    let series = study.get(seriesUid)
    if (!series) {
      series = useRecords ? [] : new Map<string, EntryAccum>()
      study.set(seriesUid, series)
    }
    if (Array.isArray(series)) {
      series.push(fileRecord)
    } else {
      accumulate(series, fileRecord)
    }
  }

  // Salt is known only now: absent an explicit one, it derives from the study
  // UIDs gathered during the walk. Hash each file's captured UIDs into its tags.
  const salt = preserveUids
    ? (options.uidSalt ?? deriveSalt([...studies.keys()]))
    : undefined
  if (salt !== undefined) {
    // A kept tag can collide with the sweep (e.g. a kept sequence that carries
    // UID references); the hashed value wins — no original UID ever leaves —
    // but the user asked for verbatim, so say what happened.
    const sweptKeepTags = new Set<string>()
    for (const study of studies.values()) {
      for (const series of study.values()) {
        if (!Array.isArray(series)) continue
        for (const rec of series) {
          if (rec.uidOriginals) {
            if (rec.tags) {
              for (const keyword of Object.keys(rec.uidOriginals)) {
                if (keyword in rec.tags) sweptKeepTags.add(keyword)
              }
            }
            rec.tags = mergeTags(
              rec.tags,
              hashUidTags(rec.uidOriginals, salt, uidMap),
            )
          }
        }
      }
    }
    for (const keyword of sweptKeepTags) {
      console.warn(
        `describe: keep-tag "${keyword}" contains UID references — kept as its hashed UID skeleton, not verbatim (disable with preserveUids: false)`,
      )
    }
  }

  // With preserveUids, emit the hashed group UIDs at study/series level (the
  // per-file SOP/FrameOfReference UIDs already ride the record tags above).
  const withGroupUid = (spec: SeriesSpec, seriesUid: string): SeriesSpec =>
    salt === undefined
      ? spec
      : {
          ...spec,
          tags: {
            ...spec.tags,
            SeriesInstanceUID: hashUidVia(uidMap, salt, seriesUid),
          },
        }

  const studySpecs: StudySpec[] = [...studies.entries()].map(
    ([studyUid, study]) => ({
      ...(salt !== undefined
        ? { tags: { StudyInstanceUID: hashUidVia(uidMap, salt, studyUid) } }
        : {}),
      series: [...study.entries()].map(([seriesUid, accum]) =>
        withGroupUid(seriesSpecFromAccum(accum), seriesUid),
      ),
    }),
  )

  if (studySpecs.length === 0) {
    throw new Error(`describe: no DICOM series found in ${dir}`)
  }

  const spec: DatasetSpec = {
    studies: studySpecs,
    layout: 'hierarchical',
    ...(salt !== undefined ? { uidSalt: salt } : {}),
  }
  validateDatasetSpec(spec)
  return { spec, stats }
}
