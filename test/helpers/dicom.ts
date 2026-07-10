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
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
  return {
    meta: dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.meta),
    dataset: dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict),
  }
}
