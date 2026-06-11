import { dcmjs } from '../../src/loadDcmjs'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: { readFile: (ab: ArrayBuffer) => { dict: unknown } }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
    }
  }
}

// Parse a generated DICOM buffer into a naturalised (keyword-keyed) dataset.
export function parseNatural(buffer: Buffer): Record<string, unknown> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
  return dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict)
}
