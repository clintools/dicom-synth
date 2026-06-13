import type {
  DatasetLayout,
  DatasetSpec,
  EntrySpec,
  FileSpec,
  Modality,
  ParametricEdgeCase,
  ParametricSpec,
  ParametricStudies,
  Range,
  SeriesSpec,
  StudySpec,
  TransferSyntax,
  ViolationClass,
} from './types.js'

// Image-generating types: accept the image-only fields and can be grouped into series.
const TYPE_CAPABILITIES = {
  'valid-image': { image: true },
  'invalid-uid-image': { image: true },
  'vendor-warnings-image': { image: true },
  'fake-signature': { image: false },
  'non-dicom': { image: false },
  dicomdir: { image: false },
} as const satisfies Record<FileSpec['type'], { image: boolean }>

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

const VALID_TRANSFER_SYNTAXES = {
  'explicit-vr-little-endian': true,
  'implicit-vr-little-endian': true,
} as const satisfies Record<TransferSyntax, true>

// 512 MB — prevents accidental OOM from unreasonably large pixel sizing.
const MAX_PIXEL_BYTES = 512 * 1024 * 1024

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

function validatePositiveInt(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(
      `${path}: must be a positive integer; got ${JSON.stringify(value)}`,
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

function validateSizeKbLimit(kb: number, path: string): void {
  if (kb * 1024 > MAX_PIXEL_BYTES) {
    throw new Error(`${path}: exceeds the 512 MB limit`)
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

function validateEntry(entry: unknown, path: string): EntrySpec {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${path}: must be an object`)
  }

  const e = entry as Record<string, unknown>

  validateEnum(e.type, TYPE_CAPABILITIES, `${path}.type`)

  const type = e.type as FileSpec['type']
  const caps = TYPE_CAPABILITIES[type]

  if ('count' in e) validatePositiveInt(e.count, `${path}.count`)

  for (const field of [
    'modality',
    'rows',
    'columns',
    'frames',
    'targetSizeKb',
    'tags',
    'violations',
    'transferSyntax',
  ] as const) {
    if (!caps.image && field in e)
      throw new Error(`${path}.${field}: not supported for type "${type}"`)
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

function validateTags(tags: unknown, path: string): void {
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    throw new Error(`${path}: must be an object`)
  }
  for (const key of Object.keys(tags as object)) {
    validateTagKey(key, path)
  }
}

function validateSeries(series: unknown, path: string): SeriesSpec {
  if (typeof series !== 'object' || series === null || Array.isArray(series)) {
    throw new Error(`${path}: must be an object`)
  }

  const s = series as Record<string, unknown>

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

  const rawEntries = (r.entries as unknown[]) ?? []
  const rawStudies = (r.studies as unknown[]) ?? []
  if (rawEntries.length === 0 && rawStudies.length === 0) {
    throw new Error(
      'DatasetSpec: must contain at least one of "entries" or "studies" (non-empty)',
    )
  }

  const entries = rawEntries.map((entry, i) =>
    validateEntry(entry, `entries[${i}]`),
  )
  const studies = rawStudies.map((study, i) =>
    validateStudy(study, `studies[${i}]`),
  )

  if ('seed' in r) validateSeed(r.seed, 'DatasetSpec.seed')

  if ('layout' in r) {
    validateEnum(r.layout, VALID_LAYOUTS, 'DatasetSpec.layout')
  }

  return {
    ...(entries.length > 0 ? { entries } : {}),
    ...(studies.length > 0 ? { studies } : {}),
    ...(r.seed !== undefined ? { seed: r.seed as number } : {}),
    ...(r.layout !== undefined ? { layout: r.layout as DatasetLayout } : {}),
  }
}

function validateRange(value: unknown, path: string): Range {
  if (typeof value === 'number') {
    validatePositiveInt(value, path)
    return value
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `${path}: must be a positive integer or { min, max }; got ${JSON.stringify(value)}`,
    )
  }
  const r = value as Record<string, unknown>
  validatePositiveInt(r.min, `${path}.min`)
  validatePositiveInt(r.max, `${path}.max`)
  if ((r.min as number) > (r.max as number)) {
    throw new Error(`${path}: min (${r.min}) must be ≤ max (${r.max})`)
  }
  return value as Range
}

function rangeMax(range: Range): number {
  return typeof range === 'number' ? range : range.max
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
  const e = validateEntry(edgeCase, path) as Record<string, unknown>

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

  if ('layout' in r) {
    validateEnum(r.layout, VALID_LAYOUTS, 'ParametricSpec.layout')
  }

  return {
    studies,
    ...(edgeCases.length > 0 ? { edgeCases } : {}),
    ...(r.seed !== undefined ? { seed: r.seed as number } : {}),
    ...(r.layout !== undefined ? { layout: r.layout as DatasetLayout } : {}),
  }
}
