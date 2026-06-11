export type TransferSyntax =
  | 'explicit-vr-little-endian'
  | 'implicit-vr-little-endian'

export type DicomTagOverrides = {
  PatientID?: string
  PatientName?: string
  StudyDescription?: string
  SeriesDescription?: string
  // Or any other DICOM keyword name (e.g. "Modality") or 8-hex-char tag (e.g. "00080060")
  [tag: string]: unknown
}

// Each value corresponds to a specific, documented DICOM non-conformance detectable by dciodvfy.
export type ViolationClass =
  | 'uid-too-long' // UID value exceeds 64-character VR limit
  | 'non-conformant-uid' // UID contains a component with a leading zero
  | 'missing-meta-header' // File preamble + DICM prefix absent
  | 'malformed-sq-delimiter' // Sequence delimiter tag has non-zero length field
  | 'vr-max-length-exceeded' // LO field value exceeds 64-character VR limit
  | 'missing-type1-tag' // SOPClassUID (Type 1 mandatory) removed from dataset

type BaseCtSpec = {
  tags?: DicomTagOverrides
  transferSyntax?: TransferSyntax
  violations?: ViolationClass[]
}

export type ValidCtSpec = BaseCtSpec & { type: 'valid-ct' }
export type InvalidUidCtSpec = BaseCtSpec & { type: 'invalid-uid-ct' }
export type VendorCtSpec = BaseCtSpec & { type: 'vendor-warnings-ct' }
export type LargeCtSpec = BaseCtSpec & {
  type: 'large-ct'
  rows: number
  columns: number
  frames?: number
}
export type FakeSignatureSpec = { type: 'fake-signature' }
export type NonDicomSpec = { type: 'non-dicom'; content?: string }
export type DicomdirSpec = { type: 'dicomdir' }

// FileSpec: single-file generation parameters — no count, no seed.
export type FileSpec =
  | ValidCtSpec
  | InvalidUidCtSpec
  | VendorCtSpec
  | LargeCtSpec
  | FakeSignatureSpec
  | NonDicomSpec
  | DicomdirSpec

// EntrySpec: collection-layer wrapper — adds how many times to generate a FileSpec.
// Only DatasetSpec / generateCollectionFromSpec ever sees EntrySpec.
export type EntrySpec = FileSpec & { count?: number }

export type DatasetSpec = {
  entries: EntrySpec[]
  seed?: number
}
