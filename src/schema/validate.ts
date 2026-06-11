import type {
  DatasetSpec,
  EntrySpec,
  FileSpec,
  TransferSyntax,
  ViolationClass,
} from './types.js'

const TYPE_CAPABILITIES = {
  'valid-ct': { tags: true, violations: true, transferSyntax: true },
  'invalid-uid-ct': { tags: true, violations: true, transferSyntax: true },
  'vendor-warnings-ct': { tags: true, violations: true, transferSyntax: true },
  'large-ct': { tags: true, violations: true, transferSyntax: true },
  'fake-signature': { tags: false, violations: false, transferSyntax: false },
  'non-dicom': { tags: false, violations: false, transferSyntax: false },
  dicomdir: { tags: false, violations: false, transferSyntax: false },
} as const satisfies Record<
  FileSpec['type'],
  { tags: boolean; violations: boolean; transferSyntax: boolean }
>

const VALID_TRANSFER_SYNTAXES = {
  'explicit-vr-little-endian': true,
  'implicit-vr-little-endian': true,
} as const satisfies Record<TransferSyntax, true>

// 512 MB — prevents accidental OOM from unreasonably large large-ct specs.
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

  if (typeof e.type !== 'string' || !Object.hasOwn(TYPE_CAPABILITIES, e.type)) {
    throw new Error(
      `${path}.type: must be one of ${Object.keys(TYPE_CAPABILITIES).join(', ')}; got ${JSON.stringify(e.type)}`,
    )
  }

  const type = e.type as FileSpec['type']
  const caps = TYPE_CAPABILITIES[type]

  if ('count' in e) {
    if (
      typeof e.count !== 'number' ||
      !Number.isInteger(e.count) ||
      e.count < 1
    ) {
      throw new Error(
        `${path}.count: must be a positive integer; got ${JSON.stringify(e.count)}`,
      )
    }
  }

  if ('transferSyntax' in e) {
    if (!caps.transferSyntax) {
      throw new Error(
        `${path}.transferSyntax: not supported for type "${type}"`,
      )
    }
    if (!Object.hasOwn(VALID_TRANSFER_SYNTAXES, e.transferSyntax as string)) {
      throw new Error(
        `${path}.transferSyntax: must be one of ${Object.keys(VALID_TRANSFER_SYNTAXES).join(', ')}`,
      )
    }
  }

  if (!caps.tags && 'tags' in e)
    throw new Error(`${path}.tags: not supported for type "${type}"`)
  if (!caps.violations && 'violations' in e)
    throw new Error(`${path}.violations: not supported for type "${type}"`)

  if ('tags' in e) {
    if (
      typeof e.tags !== 'object' ||
      e.tags === null ||
      Array.isArray(e.tags)
    ) {
      throw new Error(`${path}.tags: must be an object`)
    }
    for (const key of Object.keys(e.tags as object)) {
      validateTagKey(key, `${path}.tags`)
    }
  }

  if ('violations' in e) {
    if (!Array.isArray(e.violations)) {
      throw new Error(`${path}.violations: must be an array`)
    }
    for (const [i, v] of (e.violations as unknown[]).entries()) {
      if (typeof v !== 'string' || !Object.hasOwn(VALID_VIOLATIONS, v)) {
        throw new Error(
          `${path}.violations[${i}]: must be one of ${Object.keys(VALID_VIOLATIONS).join(', ')}; got ${JSON.stringify(v)}`,
        )
      }
    }
  }

  if (type === 'large-ct') {
    if (typeof e.rows !== 'number' || !Number.isInteger(e.rows) || e.rows < 1) {
      throw new Error(`${path}.rows: must be a positive integer`)
    }
    if (
      typeof e.columns !== 'number' ||
      !Number.isInteger(e.columns) ||
      e.columns < 1
    ) {
      throw new Error(`${path}.columns: must be a positive integer`)
    }
    if ('frames' in e) {
      if (
        typeof e.frames !== 'number' ||
        !Number.isInteger(e.frames) ||
        e.frames < 1
      ) {
        throw new Error(`${path}.frames: must be a positive integer`)
      }
    }
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

export function validateDatasetSpec(raw: unknown): DatasetSpec {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('DatasetSpec: must be a JSON object')
  }

  const r = raw as Record<string, unknown>

  if (!Array.isArray(r.entries)) {
    throw new Error('DatasetSpec.entries: must be an array')
  }
  if (r.entries.length === 0) {
    throw new Error('DatasetSpec.entries: must not be empty')
  }

  const entries = r.entries.map((entry, i) =>
    validateEntry(entry, `entries[${i}]`),
  )

  if ('seed' in r) {
    if (typeof r.seed !== 'number' || !Number.isFinite(r.seed)) {
      throw new Error(
        `DatasetSpec.seed: must be a finite number; got ${JSON.stringify(r.seed)}`,
      )
    }
  }

  return {
    entries,
    ...(r.seed !== undefined ? { seed: r.seed as number } : {}),
  }
}
