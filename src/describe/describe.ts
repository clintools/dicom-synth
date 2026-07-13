import { createHash } from 'node:crypto'
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from 'node:fs'
import { basename, extname, join, relative, sep } from 'node:path'
import { toArrayBuffer } from '../bytes.js'
import { buildHexToKeyword } from '../dicomDictionary.js'
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
  TreeNode,
} from '../schema/types.js'
import {
  HEX_TAG_RE,
  isPrivateHexTag,
  positionalName,
  validateDatasetSpec,
} from '../schema/validate.js'
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
  // Capture ALL private (odd-group) elements as-is — creators, scalars,
  // nested private sequences — as raw { vr, value } forms from the parsed
  // raw dict (their VRs survive only there). Off by default: private blocks
  // routinely carry PHI/device detail, and handling that is the caller's
  // responsibility, like keepTags. UI-VR leaves are still hashed under
  // preserveUids; JSON-unrepresentable payloads (binary/NaN/null) are skipped
  // and counted. Individual private tags can instead be named in keepTags.
  keepPrivateTags?: boolean
  // Capture the real directory structure as a generic `tree` spec instead of
  // the compact studies/series form: anonymised directory names, one node per
  // file (kind + size; extension kept for non-DICOM), grouping carried by
  // hashed per-file Study/SeriesInstanceUID tags. Non-DICOM files are captured
  // as sized placeholders rather than skipped. Requires preserveUids (the
  // default) — without UIDs the captured tree would lose all grouping.
  captureTree?: boolean
}

export type DescribeResult = {
  spec: DatasetSpec
  stats: {
    dicomFiles: number
    skipped: number // non-DICOM, unparseable, or missing grouping UIDs
    unknownModality: number // Modality present but not CT/PT/MR/CR
    // Files captured as sized non-dicom placeholders (captureTree only —
    // without it they count as skipped).
    nonDicomFiles: number
    // Private elements skipped because their payload is JSON-unrepresentable
    // (binary bytes, or the NaN/null dcmjs emits for unparseable values).
    privateBinarySkipped: number
  }
}

// The two capture routes resolved from keepTags/keepPrivateTags: keyword tags
// are copied from the naturalised record; private hex tags come from the raw
// dict (as raw { vr, value } forms), either named individually or all of them.
type KeepPlan = {
  keywords: string[]
  privateHex: Set<string>
  allPrivate: boolean
  capturingPrivate: boolean
}

function buildKeepPlan(options: DescribeOptions): KeepPlan {
  const { keywords, privateHex } = options.keepTags
    ? resolveKeepTags(options.keepTags)
    : { keywords: [], privateHex: new Set<string>() }
  const allPrivate = options.keepPrivateTags === true
  return {
    keywords,
    privateHex,
    allPrivate,
    capturingPrivate: allPrivate || privateHex.size > 0,
  }
}

// Resolve keepTags entries to DICOM keyword names, mapping hex tags via dcmjs
// and rejecting unknown even-group tags (hex or keyword) so typos surface
// rather than silently matching nothing. Private (odd-group) hex tags have no
// dictionary entry — they route to raw-dict capture instead. Coupled
// (modality-preset) and UID-VR keywords are dropped with a warning — the
// former is reproduced from the `modality` field, the latter is handled by
// the hash-derived UID path.
function resolveKeepTags(keepTags: string[]): {
  keywords: string[]
  privateHex: Set<string>
} {
  const nameMap = dcmjsAny.data.DicomMetaDictionary.nameMap
  let hexToKeyword: Map<string, string> | undefined
  const kept: string[] = []
  const privateHex = new Set<string>()
  for (const tag of keepTags) {
    let keyword: string
    if (HEX_TAG_RE.test(tag)) {
      if (isPrivateHexTag(tag)) {
        privateHex.add(tag.toUpperCase())
        continue
      }
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
  return { keywords: kept, privateHex }
}

// Values a JSON spec cannot carry faithfully: binary payloads (dcmjs parses
// OB/OW/UN as ArrayBuffers), null/undefined components, and non-finite
// numbers (dcmjs parses an unparseable DS as NaN, which JSON would silently
// turn into null) — skipped and counted rather than silently normalised.
function isUnrepresentableValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (typeof value === 'number' && !Number.isFinite(value)) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  )
}

// A raw-dict element → the spec's raw { vr, value } form, recursing into SQ
// items; null (counted) when the element cannot ride a JSON spec.
function toRawCapture(
  el: RawDictElement,
  skipped: { count: number },
): { vr: string; value: unknown } | null {
  const vr = el.vr
  if (typeof vr !== 'string') {
    skipped.count++
    return null
  }
  if (vr === 'SQ') {
    const items: Record<string, { vr: string; value: unknown }>[] = []
    for (const item of el.Value ?? []) {
      if (typeof item !== 'object' || item === null) continue
      const converted: Record<string, { vr: string; value: unknown }> = {}
      for (const [tag, nested] of Object.entries(item)) {
        if (!HEX_TAG_RE.test(tag)) continue
        const capture = toRawCapture(nested as RawDictElement, skipped)
        if (capture) converted[tag.toUpperCase()] = capture
      }
      // An emptied item still marks its position, preserving item count.
      items.push(converted)
    }
    return { vr, value: items }
  }
  const values = el.Value ?? []
  if (values.some(isUnrepresentableValue)) {
    skipped.count++
    return null
  }
  return { vr, value: values.length === 1 ? values[0] : values }
}

// The file's private (odd-group) elements as raw forms — all of them, or only
// the tags named in the keep plan.
function capturePrivateTags(
  rawDict: Record<string, RawDictElement>,
  keep: KeepPlan,
  skipped: { count: number },
): Record<string, unknown> | undefined {
  const captured: Record<string, unknown> = {}
  let found = false
  for (const [tag, el] of Object.entries(rawDict)) {
    if (!HEX_TAG_RE.test(tag) || !isPrivateHexTag(tag)) continue
    if (!keep.allPrivate && !keep.privateHex.has(tag.toUpperCase())) continue
    const capture = toRawCapture(el, skipped)
    if (capture) {
      captured[tag.toUpperCase()] = capture
      found = true
    }
  }
  return found ? captured : undefined
}

// Hash the UI-VR leaves inside a captured raw form (the same one-map policy as
// the keyword sweep: no real UID leaves the dataset), leaving other VRs as-is.
function hashRawCaptureUids(
  capture: { vr: string; value: unknown },
  salt: string,
  map: Map<string, string>,
): { vr: string; value: unknown } {
  if (capture.vr === 'UI') {
    // Same gate as the keyword sweep (collectUidOriginals): only string
    // leaves are UIDs — anything else is a malformed value, passed through
    // rather than fed to the hasher.
    return isUidLeaf(capture.value)
      ? { vr: 'UI', value: hashUidValue(capture.value, salt, map) }
      : capture
  }
  if (capture.vr === 'SQ') {
    const items = capture.value as Record<
      string,
      { vr: string; value: unknown }
    >[]
    return {
      vr: 'SQ',
      value: items.map((item) =>
        Object.fromEntries(
          Object.entries(item).map(([tag, nested]) => [
            tag,
            hashRawCaptureUids(nested, salt, map),
          ]),
        ),
      ),
    }
  }
  return capture
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

type RawDictElement = { vr?: string; Value?: unknown[] }

// The naturalised (keyword-keyed) record drives grouping and tag capture; the
// raw dict is kept alongside because it is the only faithful view of private
// elements (naturalisation drops their VRs — an empty _vrMap).
export type ParsedFile = {
  record: Record<string, unknown>
  rawDict: Record<string, RawDictElement>
}

function parseParts(ab: ArrayBuffer): ParsedFile {
  const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
  return {
    record: dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict),
    rawDict: parsed.dict as Record<string, RawDictElement>,
  }
}

function parseFull(path: string): ParsedFile | null {
  try {
    return parseParts(toArrayBuffer(readFileSync(path)))
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
export function readHeaderOnly(path: string): ParsedFile | null {
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
    return parseParts(toArrayBuffer(headerOnly))
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
  // Private elements captured as raw { vr, value } forms during the walk;
  // UI leaves hashed and the forms merged into `tags` post-walk, like
  // uidOriginals.
  privateTags?: Record<string, unknown>
}

// Merge a record's captured private raw forms into its tags — UI leaves
// hashed when a salt is in play, verbatim otherwise (preserveUids: false).
function mergePrivateTags(
  rec: FileRecord,
  salt: string | undefined,
  uidMap: Map<string, string>,
): void {
  if (!rec.privateTags) return
  const hashed = Object.fromEntries(
    Object.entries(rec.privateTags).map(([tag, capture]) => [
      tag,
      salt === undefined
        ? capture
        : hashRawCaptureUids(
            capture as { vr: string; value: unknown },
            salt,
            uidMap,
          ),
    ]),
  )
  rec.tags = mergeTags(rec.tags, hashed)
}

// Stat + parse one scanned file, header-only above the in-memory cap (never
// loaded whole). Returns null when the file cannot be captured at all —
// unreadable, or beyond the 50 GB reproduction ceiling.
function scanFile(path: string): {
  size: number
  large: boolean
  parsed: ParsedFile | null
} | null {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return null
  }
  if (size > MAX_STREAM_BYTES) return null
  const large = size > MAX_PIXEL_BYTES
  return { size, large, parsed: large ? readHeaderOnly(path) : parseFull(path) }
}

// The record's preset modality; 'unsupported' when Modality is present but has
// no preset (counted by callers, emitted as the default).
function presetModalityOf(
  record: Record<string, unknown>,
): Modality | 'unsupported' | undefined {
  if (typeof record.Modality !== 'string') return undefined
  return SUPPORTED_MODALITIES.has(record.Modality as Modality)
    ? (record.Modality as Modality)
    : 'unsupported'
}

// Hash a record's captured UIDs into its tags. A kept tag can collide with the
// sweep (e.g. a kept sequence that carries UID references); the hashed value
// wins — no original UID ever leaves — but the user asked for verbatim, so the
// collision is collected for a warning.
function hashRecordUids(
  rec: FileRecord,
  salt: string,
  uidMap: Map<string, string>,
  sweptKeepTags: Set<string>,
): void {
  if (!rec.uidOriginals) return
  if (rec.tags) {
    for (const keyword of Object.keys(rec.uidOriginals)) {
      if (keyword in rec.tags) sweptKeepTags.add(keyword)
    }
  }
  rec.tags = mergeTags(rec.tags, hashUidTags(rec.uidOriginals, salt, uidMap))
}

function warnPrivateBinarySkipped(count: number): void {
  if (count > 0) {
    console.warn(
      `describe: ${count} private element(s) with binary payloads were not captured — binary values cannot ride a JSON spec`,
    )
  }
}

function warnSweptKeepTags(sweptKeepTags: Set<string>): void {
  for (const keyword of sweptKeepTags) {
    console.warn(
      `describe: keep-tag "${keyword}" contains UID references — kept as its hashed UID skeleton, not verbatim (disable with preserveUids: false)`,
    )
  }
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

// One directory of the captured tree; files stay in sorted-path order so the
// emitted spec is deterministic.
type TreeDirAccum = {
  dirs: Map<string, TreeDirAccum>
  files: TreeLeaf[]
}

type DicomLeaf = {
  kind: 'dicom'
  rec: FileRecord
  studyUid: string
  seriesUid: string
}
type TreeLeaf = DicomLeaf | { kind: 'other'; bytes: number; ext: string }

function dirAccumFor(root: TreeDirAccum, dirs: string[]): TreeDirAccum {
  let node = root
  for (const name of dirs) {
    let child = node.dirs.get(name)
    if (!child) {
      child = { dirs: new Map(), files: [] }
      node.dirs.set(name, child)
    }
    node = child
  }
  return node
}

// A short alphanumeric extension is structural (a consumer may dispatch on
// .csv/.log); anything else could carry meaning from the original name and is
// dropped with the rest of it.
const SAFE_EXTENSION_RE = /^\.[A-Za-z0-9]{1,8}$/

function safeExtension(path: string): string {
  const ext = extname(basename(path))
  return SAFE_EXTENSION_RE.test(ext) ? ext : ''
}

// Emit the captured tree with every original name anonymised: directories are
// unnamed (the writer assigns positional dir-NNN), DICOM files take the
// writer's synthetic names, and non-DICOM files get file-NNN plus their
// (structural) extension.
function emitTree(acc: TreeDirAccum): TreeNode[] {
  const nodes: TreeNode[] = []
  let otherOrdinal = 0
  for (const leaf of acc.files) {
    if (leaf.kind === 'other') {
      otherOrdinal++
      const name = `${positionalName('file', otherOrdinal)}${leaf.ext}`
      nodes.push(
        leaf.bytes > 0
          ? { type: 'non-dicom', name, targetBytes: leaf.bytes }
          : { type: 'non-dicom', name, content: '' },
      )
    } else {
      nodes.push(entryOf({ ...leaf.rec, count: 1 }))
    }
  }
  for (const sub of acc.dirs.values()) {
    nodes.push({ children: emitTree(sub) })
  }
  return nodes
}

// Tree capture: mirrors the real directory structure instead of grouping into
// studies/series. Grouping still survives — every DICOM node carries its
// hashed Study/SeriesInstanceUID as tags, so the regenerated files share the
// same (synthetic) group UIDs without role markers. sizeTolerance is ignored:
// the tree emits one node per file, so there is nothing to fold.
function describeTree(
  dir: string,
  options: DescribeOptions,
  keep: KeepPlan,
): DescribeResult {
  const root: TreeDirAccum = { dirs: new Map(), files: [] }
  const stats = {
    dicomFiles: 0,
    skipped: 0,
    unknownModality: 0,
    nonDicomFiles: 0,
    privateBinarySkipped: 0,
  }
  const privateSkipped = { count: 0 }
  const studyUids = new Set<string>()
  const dicomLeaves: DicomLeaf[] = []

  for (const path of [...walkFiles(dir)].sort()) {
    const scanned = scanFile(path)
    if (!scanned) {
      stats.skipped++
      continue
    }
    const { size, large, parsed } = scanned
    const record = parsed?.record
    const studyUid = record?.StudyInstanceUID
    const seriesUid = record?.SeriesInstanceUID
    const relDirs = relative(dir, path).split(sep).slice(0, -1)

    if (
      !record ||
      typeof studyUid !== 'string' ||
      typeof seriesUid !== 'string'
    ) {
      // Not reproducible as a placeholder: non-dicom is capped at the
      // in-memory limit.
      if (large) {
        stats.skipped++
        continue
      }
      stats.nonDicomFiles++
      dirAccumFor(root, relDirs).files.push({
        kind: 'other',
        bytes: size,
        ext: safeExtension(path),
      })
      continue
    }
    stats.dicomFiles++
    studyUids.add(studyUid)

    const preset = presetModalityOf(record)
    if (preset === 'unsupported') stats.unknownModality++
    const modality = preset === 'unsupported' ? undefined : preset

    // Tree files sit outside role-marked series, so the writer will not stamp
    // InstanceNumber — carry the source's value so instance order round-trips.
    const instanceNumber =
      typeof record.InstanceNumber === 'number'
        ? { InstanceNumber: record.InstanceNumber }
        : typeof record.InstanceNumber === 'string'
          ? { InstanceNumber: escapeTagTemplate(record.InstanceNumber) }
          : undefined
    const leaf: DicomLeaf = {
      kind: 'dicom',
      rec: {
        large,
        bytes: size,
        modality,
        tags: mergeTags(
          instanceNumber,
          keep.keywords.length ? extractTags(record, keep.keywords) : undefined,
        ),
        uidOriginals: collectUidOriginals(record),
        privateTags:
          keep.capturingPrivate && parsed
            ? capturePrivateTags(parsed.rawDict, keep, privateSkipped)
            : undefined,
      },
      studyUid,
      seriesUid,
    }
    dirAccumFor(root, relDirs).files.push(leaf)
    dicomLeaves.push(leaf)
  }

  if (root.files.length === 0 && root.dirs.size === 0) {
    throw new Error(`describe: no files found in ${dir}`)
  }

  const salt = options.uidSalt ?? deriveSalt([...studyUids])
  const uidMap = new Map<string, string>()
  const sweptKeepTags = new Set<string>()
  for (const { rec, studyUid, seriesUid } of dicomLeaves) {
    hashRecordUids(rec, salt, uidMap, sweptKeepTags)
    mergePrivateTags(rec, salt, uidMap)
    rec.tags = mergeTags(rec.tags, {
      StudyInstanceUID: hashUidVia(uidMap, salt, studyUid),
      SeriesInstanceUID: hashUidVia(uidMap, salt, seriesUid),
    })
  }
  warnSweptKeepTags(sweptKeepTags)
  stats.privateBinarySkipped = privateSkipped.count
  warnPrivateBinarySkipped(privateSkipped.count)

  const spec: DatasetSpec = { tree: emitTree(root), uidSalt: salt }
  validateDatasetSpec(spec)
  return { spec, stats }
}

// Scans a DICOM directory tree and emits a concrete DatasetSpec describing its
// shape: studies/series grouped by their UIDs, per-file size as targetSizeKb,
// and modality. Tags are only included when named in options.keepTags.
export function describeDirectory(
  dir: string,
  options: DescribeOptions = {},
): DescribeResult {
  const keep = buildKeepPlan(options)

  const preserveUids = options.preserveUids ?? true
  if (options.captureTree) {
    if (!preserveUids) {
      throw new Error(
        'describe: captureTree requires preserveUids — the captured tree carries its grouping as hashed UID tags',
      )
    }
    return describeTree(dir, options, keep)
  }
  // One map for the whole tree — same source UID → same synthetic everywhere.
  const uidMap = new Map<string, string>()

  // Per-file records are needed for the instances form (kept/private tags)
  // and for hashed per-file UIDs; otherwise we collapse on the fly (see
  // SeriesAccum).
  const useRecords =
    keep.keywords.length > 0 || preserveUids || keep.capturingPrivate

  const tolerance = options.sizeTolerance ?? 0
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error(
      `describe: sizeTolerance must be a non-negative fraction; got ${JSON.stringify(options.sizeTolerance)}`,
    )
  }

  const studies = new Map<string, StudyAccum>()
  const stats = {
    dicomFiles: 0,
    skipped: 0,
    unknownModality: 0,
    nonDicomFiles: 0,
    privateBinarySkipped: 0,
  }
  const privateSkipped = { count: 0 }

  // Sort paths for deterministic output independent of filesystem order.
  for (const path of [...walkFiles(dir)].sort()) {
    const scanned = scanFile(path)
    if (!scanned) {
      stats.skipped++
      continue
    }
    const { size, large, parsed } = scanned
    const record = parsed?.record
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

    const preset = presetModalityOf(record)
    if (preset === 'unsupported') stats.unknownModality++
    const modality = preset === 'unsupported' ? undefined : preset

    const keptTags = keep.keywords.length
      ? extractTags(record, keep.keywords)
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
      privateTags:
        keep.capturingPrivate && parsed
          ? capturePrivateTags(parsed.rawDict, keep, privateSkipped)
          : undefined,
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
  // UIDs gathered during the walk. Hash each file's captured UIDs into its
  // tags, and merge captured private raw forms (UI leaves hashed under the
  // same salt; verbatim when preserveUids is off).
  const salt = preserveUids
    ? (options.uidSalt ?? deriveSalt([...studies.keys()]))
    : undefined
  if (salt !== undefined || keep.capturingPrivate) {
    const sweptKeepTags = new Set<string>()
    for (const study of studies.values()) {
      for (const series of study.values()) {
        if (!Array.isArray(series)) continue
        for (const rec of series) {
          if (salt !== undefined) {
            hashRecordUids(rec, salt, uidMap, sweptKeepTags)
          }
          mergePrivateTags(rec, salt, uidMap)
        }
      }
    }
    warnSweptKeepTags(sweptKeepTags)
  }
  stats.privateBinarySkipped = privateSkipped.count
  warnPrivateBinarySkipped(privateSkipped.count)

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
