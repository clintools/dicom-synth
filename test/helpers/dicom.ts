import { toArrayBuffer } from '../../src/bytes'
import { dcmjs } from '../../src/loadDcmjs'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: {
      readFile: (ab: ArrayBuffer) => { meta: unknown; dict: unknown }
    }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
    }
  }
}

// Parse a generated DICOM buffer into a naturalised (keyword-keyed) dataset.
export function parseNatural(buffer: Buffer): Record<string, unknown> {
  return parseWithMeta(buffer).dataset
}

// Parse both halves of a DICOM file: the file meta group and the dataset.
export function parseWithMeta(buffer: Buffer): {
  meta: Record<string, unknown>
  dataset: Record<string, unknown>
} {
  const parsed = dcmjsAny.data.DicomMessage.readFile(toArrayBuffer(buffer))
  return {
    meta: dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.meta),
    dataset: dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict),
  }
}

export type RawDictElement = { vr: string; Value?: unknown[] }

// The un-naturalised dict, keyed by 8-hex tag — the only faithful view of
// private elements and deliberate mis-encodings (naturalisation drops VRs).
export function parseRawDict(buffer: Buffer): Record<string, RawDictElement> {
  return dcmjsAny.data.DicomMessage.readFile(toArrayBuffer(buffer))
    .dict as Record<string, RawDictElement>
}
