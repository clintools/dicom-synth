import { dcmjs } from '../loadDcmjs.js'
import type { ViolationClass } from '../schema/types.js'
import type { RawElementMap } from './generator.js'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: {
      readFile: (ab: ArrayBuffer) => {
        dict: unknown
        write: (opts?: Record<string, unknown>) => ArrayBuffer
      }
    }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
      denaturalizeDataset: (ds: Record<string, unknown>) => unknown
    }
  }
}

function parseBuffer(buffer: Buffer): {
  dict: unknown
  write: (opts?: Record<string, unknown>) => ArrayBuffer
} {
  // DicomMessage.readFile expects an ArrayBuffer
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  return dcmjsAny.data.DicomMessage.readFile(ab)
}

function reserialize(parsed: {
  dict: unknown
  write: (opts?: Record<string, unknown>) => ArrayBuffer
}): Buffer {
  return Buffer.from(parsed.write({ allowInvalidVRLength: true }))
}

// UID VR limit is 64 chars; this is 65.
const OVERLONG_UID = `2.25.${'0'.repeat(60)}`

// Maps every ViolationClass to its application layer. Adding a new ViolationClass
// to the type union without updating this map is a compile error (satisfies).
const VIOLATION_LEVEL = {
  'uid-too-long': 'tag',
  'non-conformant-uid': 'tag',
  'vr-max-length-exceeded': 'tag',
  'missing-type1-tag': 'tag',
  'missing-meta-header': 'byte',
  'malformed-sq-delimiter': 'byte',
} as const satisfies Record<ViolationClass, 'tag' | 'byte'>

function applyTagLevel(
  buffer: Buffer,
  violations: ViolationClass[],
  rawElements?: RawElementMap,
): Buffer {
  if (violations.length === 0) return buffer

  let parsed: ReturnType<typeof parseBuffer>
  try {
    parsed = parseBuffer(buffer)
  } catch {
    console.warn(
      'dicom-synth: could not parse buffer for tag-level violations — skipping',
    )
    return buffer
  }

  const natural = dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(
    parsed.dict,
  )

  for (const v of violations) {
    switch (v) {
      case 'uid-too-long':
        // Handled after denaturalisation (below) — setting the natural value here
        // would only trigger dcmjs's truncation warning before being overwritten.
        break
      case 'non-conformant-uid':
        // A UID component must not have a leading zero (except the component "0").
        natural.SOPInstanceUID = '2.25.01.234.567'
        break
      case 'vr-max-length-exceeded':
        // LO VR limit is 64 chars; produce a 65-char value.
        natural.StudyDescription = 'X'.repeat(65)
        break
      case 'missing-type1-tag':
        // SOPClassUID is Type 1 (mandatory) for all DICOM IODs.
        delete natural.SOPClassUID
        break
      default:
        throw new Error(
          `dicom-synth: unhandled tag-level violation "${v as string}"`,
        )
    }
  }

  parsed.dict = dcmjsAny.data.DicomMetaDictionary.denaturalizeDataset(natural)

  // The naturalise→denaturalise round-trip drops raw-injected elements
  // (private tags, mis-encodings) — re-apply them so a violated file keeps
  // both. Applied before uid-too-long so an explicitly requested violation
  // still wins on a clashing tag.
  if (rawElements) {
    Object.assign(parsed.dict as Record<string, unknown>, rawElements)
  }

  // denaturalizeDataset truncates over-length UI values to 64 chars regardless of
  // allowInvalidVRLength (that option only governs the write stage), so the
  // over-long UID must be re-assigned on the raw dict after denaturalisation.
  if (violations.includes('uid-too-long')) {
    ;(parsed.dict as Record<string, unknown>)['00080018'] = {
      vr: 'UI',
      Value: [OVERLONG_UID],
    }
  }

  return reserialize(parsed)
}

function applyByteLevel(buffer: Buffer, violations: ViolationClass[]): Buffer {
  let result = buffer

  for (const v of violations) {
    switch (v) {
      case 'missing-meta-header':
        // Strip the 128-byte preamble + 4-byte DICM magic.
        result = result.subarray(132)
        break
      case 'malformed-sq-delimiter': {
        // Append a sequence delimiter tag (FFFE,E0DD) with non-zero length field
        // (must be 00000000 per standard — using 00000004 here is the violation).
        const delimiter = Buffer.alloc(8)
        delimiter.writeUInt16LE(0xfffe, 0)
        delimiter.writeUInt16LE(0xe0dd, 2)
        delimiter.writeUInt32LE(0x00000004, 4)
        result = Buffer.concat([result, delimiter])
        break
      }
      default:
        throw new Error(
          `dicom-synth: unhandled byte-level violation "${v as string}"`,
        )
    }
  }

  return result
}

export function applyViolations(
  buffer: Buffer,
  violations: ViolationClass[],
  rawElements?: RawElementMap,
): Buffer {
  if (violations.length === 0) return buffer

  const tagViolations = violations.filter((v) => VIOLATION_LEVEL[v] === 'tag')
  const byteViolations = violations.filter((v) => VIOLATION_LEVEL[v] === 'byte')

  return applyByteLevel(
    applyTagLevel(buffer, tagViolations, rawElements),
    byteViolations,
  )
}
