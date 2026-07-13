import {
  findTemplateTokens,
  TEMPLATE_VOCAB,
} from '../syntheticFixtures/tagTemplate.js'
import { MAX_PIXEL_BYTES, MAX_STREAM_BYTES } from './limits.js'
import type {
  DatasetLayout,
  DatasetSpec,
  EntrySpec,
  FileSpec,
  Modality,
  ParametricEdgeCase,
  ParametricSpec,
  ParametricStudies,
  PathQuirk,
  Range,
  SeriesSpec,
  StudySpec,
  TransferSyntax,
  TreeNode,
  ViolationClass,
} from './types.js'

// Entry fields each type accepts, beyond the universal `type`/`count`. The
// allowlist is authoritative: validateEntry rejects any other field, so a new
// image-only field is added here once rather than to per-type denylists (and
// typos/unknown fields surface instead of being silently ignored).
const IMAGE_FIELDS = [
  'modality',
  'rows',
  'columns',
  'frames',
  'targetSizeKb',
  'tags',
  'violations',
  'transferSyntax',
] as const

const TYPE_CAPABILITIES = {
  'valid-image': { image: true, fields: IMAGE_FIELDS },
  'invalid-uid-image': { image: true, fields: IMAGE_FIELDS },
  'vendor-warnings-image': { image: true, fields: IMAGE_FIELDS },
  'large-image': { image: true, fields: ['targetBytes', 'modality', 'tags'] },
  'fake-signature': { image: false, fields: [] },
  'non-dicom': {
    image: false,
    fields: ['content', 'targetSizeKb', 'targetBytes'],
  },
  dicomdir: { image: false, fields: [] },
} as const satisfies Record<
  FileSpec['type'],
  { image: boolean; fields: readonly string[] }
>

// Image-generating types participate in UID grouping (studies/series and
// role-marked tree directories); other types merely occupy their location.
export function isImageType(type: FileSpec['type']): boolean {
  return TYPE_CAPABILITIES[type].image
}

const VALID_MODALITIES = {
  CT: true,
  PT: true,
  MR: true,
  CR: true,
} as const satisfies Record<Modality, true>

const VALID_LAYOUTS = {
  flat: true,
  hierarchical: true,
} as const satisfies Record<DatasetLayout, true>

const VALID_PATH_QUIRKS = {
  'trailing-dot': true,
  unicode: true,
  'deep-nesting': true,
  'long-name': true,
} as const satisfies Record<PathQuirk, true>

const VALID_TRANSFER_SYNTAXES = {
  'explicit-vr-little-endian': true,
  'implicit-vr-little-endian': true,
} as const satisfies Record<TransferSyntax, true>

// satisfies ensures this stays in sync with the ViolationClass union — a missing
// member is a compile error.
const VALID_VIOLATIONS = {
  'uid-too-long': true,
  'non-conformant-uid': true,
  'missing-meta-header': true,
  'malformed-sq-delimiter': true,
  'vr-max-length-exceeded': true,
  'missing-type1-tag': true,
} as const satisfies Record<ViolationClass, true>

// Accept DICOM keyword names (PascalCase alphanumeric) or 8-hex-char tag strings.
export const HEX_TAG_RE = /^[0-9a-fA-F]{8}$/
const KEYWORD_RE = /^[A-Z][A-Za-z0-9]*$/

// Standard DICOM VR codes per PS3.5 section 6.2 (complete as of 2019, when
// UV/SV/OV were added — the registry changes roughly once a decade). The list
// exists only to catch typos early: without it, dcmjs substitutes UN or
// crashes cryptically at write time. If the standard ever adds a VR, a valid
// spec fails HERE with a clear message — extend this set.
const VALID_VRS = new Set([
  'AE',
  'AS',
  'AT',
  'CS',
  'DA',
  'DS',
  'DT',
  'FL',
  'FD',
  'IS',
  'LO',
  'LT',
  'OB',
  'OD',
  'OF',
  'OL',
  'OV',
  'OW',
  'PN',
  'SH',
  'SL',
  'SQ',
  'SS',
  'ST',
  'SV',
  'TM',
  'UC',
  'UI',
  'UL',
  'UN',
  'UR',
  'US',
  'UT',
  'UV',
])

// A private tag has an odd group number; it has no dictionary entry, so its
// VR must be declared via the raw form.
export function isPrivateHexTag(key: string): boolean {
  return HEX_TAG_RE.test(key) && Number.parseInt(key.slice(0, 4), 16) % 2 === 1
}

// Structural raw-form detection: a plain object carrying a string `vr`.
// Validation pins the exact shape; the generator uses the same predicate.
export function isRawTagValue(
  value: unknown,
): value is { vr: string; value: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).vr === 'string'
  )
}

// The raw form: { vr, value } exactly — vr from the standard VR list, and for
// SQ the value is an array of items, each a map of hex tags to nested raw
// forms. Runs recursively so a malformed nested element fails with its path.
function validateRawTagValue(raw: Record<string, unknown>, path: string): void {
  for (const key of Object.keys(raw)) {
    if (key !== 'vr' && key !== 'value') {
      throw new Error(
        `${path}: raw tag form accepts only "vr" and "value"; got "${key}"`,
      )
    }
  }
  const vr = raw.vr as string
  if (!VALID_VRS.has(vr)) {
    throw new Error(`${path}.vr: "${vr}" is not a standard DICOM VR`)
  }
  if (!('value' in raw)) {
    throw new Error(`${path}.value: is required in the raw tag form`)
  }
  if (vr === 'SQ') {
    if (!Array.isArray(raw.value)) {
      throw new Error(`${path}.value: an SQ raw tag requires an array of items`)
    }
    raw.value.forEach((item, i) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        throw new Error(
          `${path}.value[${i}]: must be an object of hex-tag entries`,
        )
      }
      for (const [tag, nested] of Object.entries(item)) {
        if (!HEX_TAG_RE.test(tag)) {
          throw new Error(
            `${path}.value[${i}]: invalid item tag "${tag}" — SQ items use 8-hex-char tags`,
          )
        }
        if (!isRawTagValue(nested)) {
          throw new Error(
            `${path}.value[${i}].${tag}: SQ item entries must use the raw { vr, value } form`,
          )
        }
        validateRawTagValue(
          nested as Record<string, unknown>,
          `${path}.value[${i}].${tag}`,
        )
      }
    })
  }
}

function validatePositiveInt(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${path}: must be a positive integer; got ${JSON.stringify(value)}`,
    )
  }
}

function validateNonNegativeInt(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `${path}: must be a non-negative integer; got ${JSON.stringify(value)}`,
    )
  }
}

function validateSeed(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `${path}: must be a finite number; got ${JSON.stringify(value)}`,
    )
  }
}

function validateUidSalt(value: unknown, path: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `${path}: must be a non-empty string; got ${JSON.stringify(value)}`,
    )
  }
}

function validateInMemoryByteLimit(bytes: number, path: string): void {
  if (bytes > MAX_PIXEL_BYTES) {
    throw new Error(`${path}: exceeds the 512 MB limit`)
  }
}

function validateSizeKbLimit(kb: number, path: string): void {
  validateInMemoryByteLimit(kb * 1024, path)
}

function validateLargeTargetBytes(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(`${path}: must be an integer; got ${JSON.stringify(value)}`)
  }
  if (value <= MAX_PIXEL_BYTES) {
    throw new Error(
      `${path}: must exceed 512 MB — use targetSizeKb for smaller files`,
    )
  }
  if (value > MAX_STREAM_BYTES) {
    throw new Error(`${path}: exceeds the 50 GB limit`)
  }
}

// large-image is image-generating but disk-only: sized by targetBytes, not
// pixel geometry, so it accepts only modality/tags.
function validateLargeImageEntry(
  e: Record<string, unknown>,
  path: string,
): void {
  if (!('targetBytes' in e)) {
    throw new Error(`${path}.targetBytes: is required for type "large-image"`)
  }
  validateLargeTargetBytes(e.targetBytes, `${path}.targetBytes`)
  if ('modality' in e) {
    validateEnum(e.modality, VALID_MODALITIES, `${path}.modality`)
  }
  if ('tags' in e) validateTags(e.tags, `${path}.tags`)
}

// non-dicom sizing: at most one of content / targetSizeKb / targetBytes.
// Unlike large-image, targetBytes here is an exact in-memory size ≤ 512 MB.
function validateNonDicomEntry(e: Record<string, unknown>, path: string): void {
  const sizing = ['content', 'targetSizeKb', 'targetBytes'].filter(
    (f) => f in e,
  )
  if (sizing.length > 1) {
    throw new Error(
      `${path}: "content", "targetSizeKb" and "targetBytes" are mutually exclusive`,
    )
  }
  if ('content' in e && typeof e.content !== 'string') {
    throw new Error(
      `${path}.content: must be a string; got ${JSON.stringify(e.content)}`,
    )
  }
  if ('targetSizeKb' in e) {
    validatePositiveInt(e.targetSizeKb, `${path}.targetSizeKb`)
    validateSizeKbLimit(e.targetSizeKb as number, `${path}.targetSizeKb`)
  }
  if ('targetBytes' in e) {
    validatePositiveInt(e.targetBytes, `${path}.targetBytes`)
    validateInMemoryByteLimit(e.targetBytes as number, `${path}.targetBytes`)
  }
}

// Validates that `value` is a key of one of the VALID_* lookup tables, throwing
// with the permitted values listed otherwise.
function validateEnum(
  value: unknown,
  valid: Record<string, unknown>,
  path: string,
): void {
  if (typeof value !== 'string' || !Object.hasOwn(valid, value)) {
    throw new Error(
      `${path}: must be one of ${Object.keys(valid).join(', ')}; got ${JSON.stringify(value)}`,
    )
  }
}

function validateTagKey(key: string, path: string): void {
  if (!HEX_TAG_RE.test(key) && !KEYWORD_RE.test(key)) {
    throw new Error(
      `${path}: invalid tag key "${key}" — must be a DICOM keyword name (e.g. "Modality") or an 8-hex-char tag (e.g. "00080060")`,
    )
  }
}

function validateEntry(
  entry: unknown,
  path: string,
  extraAllowedFields: readonly string[] = [],
): EntrySpec {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${path}: must be an object`)
  }

  const e = entry as Record<string, unknown>

  validateEnum(e.type, TYPE_CAPABILITIES, `${path}.type`)

  const type = e.type as FileSpec['type']
  const caps = TYPE_CAPABILITIES[type]

  const allowed = new Set<string>([
    'type',
    'count',
    ...caps.fields,
    ...extraAllowedFields,
  ])
  for (const field of Object.keys(e)) {
    if (!allowed.has(field)) {
      throw new Error(`${path}.${field}: not supported for type "${type}"`)
    }
  }

  if ('count' in e) validatePositiveInt(e.count, `${path}.count`)

  if (type === 'large-image') {
    validateLargeImageEntry(e, path)
    return e as unknown as EntrySpec
  }

  if (type === 'non-dicom') {
    validateNonDicomEntry(e, path)
    return e as unknown as EntrySpec
  }

  if ('transferSyntax' in e) {
    validateEnum(
      e.transferSyntax,
      VALID_TRANSFER_SYNTAXES,
      `${path}.transferSyntax`,
    )
  }

  if ('modality' in e) {
    validateEnum(e.modality, VALID_MODALITIES, `${path}.modality`)
  }

  if ('tags' in e) validateTags(e.tags, `${path}.tags`)

  if ('violations' in e) {
    if (!Array.isArray(e.violations)) {
      throw new Error(`${path}.violations: must be an array`)
    }
    for (const [i, v] of (e.violations as unknown[]).entries()) {
      validateEnum(v, VALID_VIOLATIONS, `${path}.violations[${i}]`)
    }
  }

  const hasDims = 'rows' in e || 'columns' in e || 'frames' in e
  if ('targetSizeKb' in e) {
    if (hasDims) {
      throw new Error(
        `${path}: targetSizeKb cannot be combined with rows/columns/frames — use one sizing mechanism`,
      )
    }
    validatePositiveInt(e.targetSizeKb, `${path}.targetSizeKb`)
    validateSizeKbLimit(e.targetSizeKb as number, `${path}.targetSizeKb`)
  } else if (hasDims) {
    if (!('rows' in e) || !('columns' in e)) {
      throw new Error(`${path}: rows and columns must be provided together`)
    }
    validatePositiveInt(e.rows, `${path}.rows`)
    validatePositiveInt(e.columns, `${path}.columns`)
    if ('frames' in e) validatePositiveInt(e.frames, `${path}.frames`)
    const rows = e.rows as number
    const columns = e.columns as number
    const frames = typeof e.frames === 'number' ? e.frames : 1
    if (rows * columns * frames * 2 > MAX_PIXEL_BYTES) {
      throw new Error(
        `${path}: pixel data (${rows}×${columns}×${frames}×2 bytes) exceeds the 512 MB limit`,
      )
    }
  }

  return e as unknown as EntrySpec
}

// Modality's tag id — matched alongside the keyword so the hex form can't evade
// the coupling guard below.
const MODALITY_TAG = '00080060'

// A preset modality (CT/PT/MR/CR) set via free-form tags would desync from the
// preset-owned SOPClassUID / type-1 attrs — those must use the `modality` field.
// Non-preset modalities (e.g. US, NM) have no preset, so tags stays their only
// route and is allowed. Only validateDatasetSpec enforces this; the low-level
// generateFile primitive trusts its input.
// Applies to plain and raw forms alike — the raw escape hatch does not exempt
// the modality coupling: a preset value written raw would desync
// SOPClassUID/type-1 attributes just the same.
function validateModalityGuard(
  key: string,
  candidate: unknown,
  path: string,
): void {
  const isModalityKey = key === 'Modality' || key.toUpperCase() === MODALITY_TAG
  if (
    isModalityKey &&
    typeof candidate === 'string' &&
    Object.hasOwn(VALID_MODALITIES, candidate)
  ) {
    throw new Error(
      `${path}.${key}: set a preset modality (${Object.keys(VALID_MODALITIES).join('/')}) via the "modality" field, not tags — it is coupled to SOPClassUID and type-1 attributes`,
    )
  }
}

// A single tag value (scalar, or one element of a per-instance array).
function validateTagValue(key: string, value: unknown, path: string): void {
  if (isRawTagValue(value)) {
    if (!HEX_TAG_RE.test(key)) {
      throw new Error(
        `${path}.${key}: the raw { vr, value } form requires an 8-hex-char tag key — keyword tags take plain values`,
      )
    }
    validateRawTagValue(value as Record<string, unknown>, `${path}.${key}`)
    const raw = (value as { value: unknown }).value
    const scalar = Array.isArray(raw) && raw.length === 1 ? raw[0] : raw
    validateModalityGuard(key, scalar, path)
    return
  }
  if (isPrivateHexTag(key)) {
    throw new Error(
      `${path}.${key}: private tags have no dictionary VR — use the raw form, e.g. { "vr": "LO", "value": … }`,
    )
  }
  validateModalityGuard(key, value, path)
  if (typeof value === 'string') {
    for (const name of findTemplateTokens(value)) {
      if (!(TEMPLATE_VOCAB as readonly string[]).includes(name)) {
        throw new Error(
          `${path}.${key}: unknown placeholder "{${name}}" — allowed: ${TEMPLATE_VOCAB.map((v) => `{${v}}`).join(', ')}`,
        )
      }
    }
  }
}

function validateTags(tags: unknown, path: string): void {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    throw new Error(`${path}: must be an object`)
  }
  for (const [key, value] of Object.entries(tags as object)) {
    validateTagKey(key, path)
    validateTagValue(key, value, path)
  }
}

function validateArrayOfLength(
  value: unknown,
  count: number,
  path: string,
): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${path}: must be an array`)
  }
  if (value.length !== count) {
    throw new Error(
      `${path}: length (${value.length}) must equal count (${count})`,
    )
  }
  return value
}

// Flywheel array form: parallel per-instance arrays, each of length `count`.
function validateInstances(instances: unknown, path: string): void {
  if (
    typeof instances !== 'object' ||
    instances === null ||
    Array.isArray(instances)
  ) {
    throw new Error(`${path}: must be an object`)
  }
  const inst = instances as Record<string, unknown>

  validatePositiveInt(inst.count, `${path}.count`)
  const count = inst.count as number

  const hasKb = 'targetSizeKb' in inst
  const hasBytes = 'targetBytes' in inst
  if (hasKb === hasBytes) {
    throw new Error(
      `${path}: exactly one of "targetSizeKb" or "targetBytes" is required`,
    )
  }
  if (hasKb) {
    const sizes = validateArrayOfLength(
      inst.targetSizeKb,
      count,
      `${path}.targetSizeKb`,
    )
    sizes.forEach((kb, i) => {
      validatePositiveInt(kb, `${path}.targetSizeKb[${i}]`)
      validateSizeKbLimit(kb as number, `${path}.targetSizeKb[${i}]`)
    })
  } else {
    const sizes = validateArrayOfLength(
      inst.targetBytes,
      count,
      `${path}.targetBytes`,
    )
    sizes.forEach((b, i) => {
      validateLargeTargetBytes(b, `${path}.targetBytes[${i}]`)
    })
  }

  if ('modality' in inst) {
    if (Array.isArray(inst.modality)) {
      validateArrayOfLength(inst.modality, count, `${path}.modality`).forEach(
        (m, i) => {
          validateEnum(m, VALID_MODALITIES, `${path}.modality[${i}]`)
        },
      )
    } else {
      validateEnum(inst.modality, VALID_MODALITIES, `${path}.modality`)
    }
  }

  if ('tags' in inst) {
    const tags = inst.tags
    if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
      throw new Error(`${path}.tags: must be an object`)
    }
    for (const [key, arr] of Object.entries(tags as object)) {
      validateTagKey(key, `${path}.tags`)
      validateArrayOfLength(arr, count, `${path}.tags.${key}`).forEach(
        (value, i) => {
          validateTagValue(key, value, `${path}.tags[${i}]`)
        },
      )
    }
  }
}

function validateSeries(series: unknown, path: string): SeriesSpec {
  if (typeof series !== 'object' || series === null || Array.isArray(series)) {
    throw new Error(`${path}: must be an object`)
  }

  const s = series as Record<string, unknown>

  const hasEntries = 'entries' in s
  const hasInstances = 'instances' in s
  if (hasEntries === hasInstances) {
    throw new Error(
      `${path}: must have exactly one of "entries" or "instances"`,
    )
  }

  if (hasEntries) {
    if (!Array.isArray(s.entries) || s.entries.length === 0) {
      throw new Error(`${path}.entries: must be a non-empty array`)
    }
    for (let i = 0; i < s.entries.length; i++) {
      const e = validateEntry(s.entries[i], `${path}.entries[${i}]`)
      // Only image-generating types can be grouped (mirrors SeriesEntrySpec).
      if (!TYPE_CAPABILITIES[e.type].image) {
        throw new Error(
          `${path}.entries[${i}].type: "${e.type}" cannot be used inside a series — only image-generating types can be grouped`,
        )
      }
    }
  } else {
    validateInstances(s.instances, `${path}.instances`)
  }

  if ('tags' in s) validateTags(s.tags, `${path}.tags`)

  return s as unknown as SeriesSpec
}

function validateStudy(study: unknown, path: string): StudySpec {
  if (typeof study !== 'object' || study === null || Array.isArray(study)) {
    throw new Error(`${path}: must be an object`)
  }

  const st = study as Record<string, unknown>

  if (!Array.isArray(st.series) || st.series.length === 0) {
    throw new Error(`${path}.series: must be a non-empty array`)
  }

  for (let i = 0; i < st.series.length; i++) {
    validateSeries(st.series[i], `${path}.series[${i}]`)
  }

  if ('count' in st) validatePositiveInt(st.count, `${path}.count`)

  if ('tags' in st) validateTags(st.tags, `${path}.tags`)

  return st as unknown as StudySpec
}

// The one positional-name convention for synthesised tree names: unnamed
// directories (writer and validator must agree) and describe's anonymised
// non-DICOM files.
export function positionalName(prefix: string, ordinal: number): string {
  return `${prefix}-${String(ordinal).padStart(3, '0')}`
}

const VALID_TREE_ROLES = {
  study: true,
  series: true,
} as const

// A single path component written to disk verbatim — must not escape or
// restructure the tree.
function validateNodeName(value: unknown, path: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    /[/\\]/.test(value)
  ) {
    throw new Error(
      `${path}: must be a non-empty name without path separators; got ${JSON.stringify(value)}`,
    )
  }
}

function validateTreeNode(
  node: unknown,
  path: string,
  inStudy: boolean,
  inSeries: boolean,
): void {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new Error(`${path}: must be an object`)
  }
  const n = node as Record<string, unknown>

  if ('children' in n) {
    if ('type' in n) {
      throw new Error(
        `${path}: a node cannot have both "children" (directory) and "type" (file)`,
      )
    }
    if ('name' in n) validateNodeName(n.name, `${path}.name`)
    if ('tags' in n) validateTags(n.tags, `${path}.tags`)

    let childStudy = inStudy
    let childSeries = inSeries
    if ('role' in n) {
      validateEnum(n.role, VALID_TREE_ROLES, `${path}.role`)
      if (n.role === 'study') {
        if (inStudy) {
          throw new Error(
            `${path}.role: a study directory cannot nest inside another study`,
          )
        }
        childStudy = true
      } else {
        if (!inStudy) {
          throw new Error(
            `${path}.role: a series directory requires an enclosing study-role directory`,
          )
        }
        if (inSeries) {
          throw new Error(
            `${path}.role: a series directory cannot nest inside another series`,
          )
        }
        childSeries = true
      }
    }

    if (!Array.isArray(n.children) || n.children.length === 0) {
      throw new Error(`${path}.children: must be a non-empty array`)
    }
    validateTreeChildren(
      n.children,
      `${path}.children`,
      childStudy,
      childSeries,
    )
    return
  }

  const e = validateEntry(node, path, ['name'])
  if ('name' in n) {
    validateNodeName(n.name, `${path}.name`)
    if ((e.count ?? 1) > 1) {
      throw new Error(
        `${path}: "name" cannot be combined with count > 1 — the copies would collide on one path`,
      )
    }
  }
}

// Validates each sibling, then checks their effective on-disk names for
// collisions: explicit names, plus the positional dir-NNN an unnamed directory
// gets (same rule as the writer). Unnamed files are excluded — their synthetic
// names carry a collection-wide index and cannot repeat.
function validateTreeChildren(
  children: unknown[],
  basePath: string,
  inStudy: boolean,
  inSeries: boolean,
): void {
  const claimed = new Map<string, string>()
  let dirOrdinal = 0
  children.forEach((child, i) => {
    const path = `${basePath}[${i}]`
    validateTreeNode(child, path, inStudy, inSeries)
    const n = child as Record<string, unknown>
    let name = 'name' in n ? (n.name as string) : undefined
    if ('children' in n) {
      dirOrdinal++
      name ??= positionalName('dir', dirOrdinal)
    }
    if (name === undefined) return
    const prior = claimed.get(name)
    if (prior !== undefined) {
      throw new Error(
        `${path}: name "${name}" collides with ${prior} — siblings must resolve to distinct paths`,
      )
    }
    claimed.set(name, path)
  })
}

export function validateDatasetSpec(raw: unknown): DatasetSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('DatasetSpec: must be a JSON object')
  }

  const r = raw as Record<string, unknown>

  if ('entries' in r && !Array.isArray(r.entries)) {
    throw new Error('DatasetSpec.entries: must be an array')
  }
  if ('studies' in r && !Array.isArray(r.studies)) {
    throw new Error('DatasetSpec.studies: must be an array')
  }
  if ('tree' in r && !Array.isArray(r.tree)) {
    throw new Error('DatasetSpec.tree: must be an array')
  }

  const rawEntries = (r.entries as unknown[]) ?? []
  const rawStudies = (r.studies as unknown[]) ?? []
  const rawTree = (r.tree as unknown[]) ?? []
  if (
    rawEntries.length === 0 &&
    rawStudies.length === 0 &&
    rawTree.length === 0
  ) {
    throw new Error(
      'DatasetSpec: must contain at least one of "entries", "studies" or "tree" (non-empty)',
    )
  }

  const entries = rawEntries.map((entry, i) =>
    validateEntry(entry, `entries[${i}]`),
  )
  const studies = rawStudies.map((study, i) =>
    validateStudy(study, `studies[${i}]`),
  )
  if (rawTree.length > 0) {
    validateTreeChildren(rawTree, 'tree', false, false)
  }

  if ('seed' in r) validateSeed(r.seed, 'DatasetSpec.seed')

  if ('uidSalt' in r) validateUidSalt(r.uidSalt, 'DatasetSpec.uidSalt')

  if ('layout' in r) {
    validateEnum(r.layout, VALID_LAYOUTS, 'DatasetSpec.layout')
  }

  if ('pathQuirks' in r) {
    if (!Array.isArray(r.pathQuirks)) {
      throw new Error('DatasetSpec.pathQuirks: must be an array')
    }
    for (const [i, q] of (r.pathQuirks as unknown[]).entries()) {
      validateEnum(q, VALID_PATH_QUIRKS, `DatasetSpec.pathQuirks[${i}]`)
    }
  }

  return {
    ...(entries.length > 0 ? { entries } : {}),
    ...(studies.length > 0 ? { studies } : {}),
    ...(rawTree.length > 0 ? { tree: r.tree as TreeNode[] } : {}),
    ...(r.seed !== undefined ? { seed: r.seed as number } : {}),
    ...(r.uidSalt !== undefined ? { uidSalt: r.uidSalt as string } : {}),
    ...(r.layout !== undefined ? { layout: r.layout as DatasetLayout } : {}),
    ...(r.pathQuirks !== undefined
      ? { pathQuirks: r.pathQuirks as PathQuirk[] }
      : {}),
  }
}

function validateRange(
  value: unknown,
  path: string,
  options: { allowZero?: boolean } = {},
): Range {
  const checkInt = options.allowZero
    ? validateNonNegativeInt
    : validatePositiveInt
  if (typeof value === 'number') {
    checkInt(value, path)
    return value
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `${path}: must be an integer or { min, max }; got ${JSON.stringify(value)}`,
    )
  }
  const r = value as Record<string, unknown>
  checkInt(r.min, `${path}.min`)
  checkInt(r.max, `${path}.max`)
  if ((r.min as number) > (r.max as number)) {
    throw new Error(`${path}: min (${r.min}) must be ≤ max (${r.max})`)
  }
  return value as Range
}

function rangeMax(range: Range): number {
  return typeof range === 'number' ? range : range.max
}

function rangeMin(range: Range): number {
  return typeof range === 'number' ? range : range.min
}

function validateParametricStudies(
  studies: unknown,
  path: string,
): ParametricStudies {
  if (
    typeof studies !== 'object' ||
    studies === null ||
    Array.isArray(studies)
  ) {
    throw new Error(`${path}: must be an object`)
  }
  const s = studies as Record<string, unknown>

  for (const field of ['count', 'seriesPerStudy', 'filesPerSeries'] as const) {
    if (!(field in s)) throw new Error(`${path}.${field}: is required`)
    validateRange(s[field], `${path}.${field}`)
  }

  if ('fileSizeKb' in s) {
    validateRange(s.fileSizeKb, `${path}.fileSizeKb`)
    validateSizeKbLimit(rangeMax(s.fileSizeKb as Range), `${path}.fileSizeKb`)
  }

  if ('largeFilesPerSeries' in s) {
    validateRange(s.largeFilesPerSeries, `${path}.largeFilesPerSeries`, {
      allowZero: true,
    })
    if (!('largeFileBytes' in s)) {
      throw new Error(
        `${path}.largeFileBytes: is required when largeFilesPerSeries is set`,
      )
    }
  }

  if ('largeFileBytes' in s) {
    if (!('largeFilesPerSeries' in s)) {
      throw new Error(
        `${path}.largeFilesPerSeries: is required when largeFileBytes is set`,
      )
    }
    validateRange(s.largeFileBytes, `${path}.largeFileBytes`)
    validateLargeTargetBytes(
      rangeMin(s.largeFileBytes as Range),
      `${path}.largeFileBytes (min)`,
    )
    validateLargeTargetBytes(
      rangeMax(s.largeFileBytes as Range),
      `${path}.largeFileBytes (max)`,
    )
  }

  if ('modalities' in s) {
    if (!Array.isArray(s.modalities) || s.modalities.length === 0) {
      throw new Error(`${path}.modalities: must be a non-empty array`)
    }
    for (const [i, m] of (s.modalities as unknown[]).entries()) {
      validateEnum(m, VALID_MODALITIES, `${path}.modalities[${i}]`)
    }
  }

  if ('tags' in s) validateTags(s.tags, `${path}.tags`)

  return s as unknown as ParametricStudies
}

function validateEdgeCase(edgeCase: unknown, path: string): ParametricEdgeCase {
  const e = validateEntry(edgeCase, path, ['frequency']) as Record<
    string,
    unknown
  >

  if ('frequency' in e) {
    if ('count' in e) {
      throw new Error(
        `${path}: frequency cannot be combined with count — frequency draws the count at resolution time`,
      )
    }
    const f = e.frequency
    if (typeof f !== 'number' || !(f >= 0 && f <= 1)) {
      throw new Error(
        `${path}.frequency: must be a number between 0 and 1; got ${JSON.stringify(f)}`,
      )
    }
  }

  return e as unknown as ParametricEdgeCase
}

export function validateParametricSpec(raw: unknown): ParametricSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('ParametricSpec: must be a JSON object')
  }

  const r = raw as Record<string, unknown>

  if (!('studies' in r)) {
    throw new Error('ParametricSpec.studies: is required')
  }
  const studies = validateParametricStudies(r.studies, 'studies')

  const edgeCases: ParametricEdgeCase[] = []
  if ('edgeCases' in r) {
    if (!Array.isArray(r.edgeCases)) {
      throw new Error('ParametricSpec.edgeCases: must be an array')
    }
    for (const [i, e] of (r.edgeCases as unknown[]).entries()) {
      edgeCases.push(validateEdgeCase(e, `edgeCases[${i}]`))
    }
  }

  if ('seed' in r) validateSeed(r.seed, 'ParametricSpec.seed')

  if ('uidSalt' in r) validateUidSalt(r.uidSalt, 'ParametricSpec.uidSalt')

  if ('layout' in r) {
    validateEnum(r.layout, VALID_LAYOUTS, 'ParametricSpec.layout')
  }

  return {
    studies,
    ...(edgeCases.length > 0 ? { edgeCases } : {}),
    ...(r.seed !== undefined ? { seed: r.seed as number } : {}),
    ...(r.uidSalt !== undefined ? { uidSalt: r.uidSalt as string } : {}),
    ...(r.layout !== undefined ? { layout: r.layout as DatasetLayout } : {}),
  }
}
