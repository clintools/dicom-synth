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

// Each preset sets the matching SOP Class UID and minimal type-1 attributes.
export type Modality = 'CT' | 'PT' | 'MR' | 'CR'

type BaseImageSpec = {
  modality?: Modality // defaults to 'CT'
  // Sizing: rows+columns (+frames), XOR targetSizeKb (~N KB ±2%/±4 KB).
  // Omitting both produces a minimal 1×1 image.
  rows?: number
  columns?: number
  frames?: number
  targetSizeKb?: number
  tags?: DicomTagOverrides
  transferSyntax?: TransferSyntax
  violations?: ViolationClass[]
}

export type ValidImageSpec = BaseImageSpec & { type: 'valid-image' }
export type InvalidUidImageSpec = BaseImageSpec & { type: 'invalid-uid-image' }
export type VendorWarningsImageSpec = BaseImageSpec & {
  type: 'vendor-warnings-image'
}
export type FakeSignatureSpec = { type: 'fake-signature' }
export type NonDicomSpec = { type: 'non-dicom'; content?: string }
export type DicomdirSpec = { type: 'dicomdir' }

// Image-generating specs: carry modality/tags/violations/transferSyntax and
// can participate in study/series grouping.
export type ImageSpec =
  | ValidImageSpec
  | InvalidUidImageSpec
  | VendorWarningsImageSpec

// FileSpec: single-file generation parameters — no count, no seed.
export type FileSpec =
  | ImageSpec
  | FakeSignatureSpec
  | NonDicomSpec
  | DicomdirSpec

// EntrySpec: collection-layer wrapper — adds how many times to generate a FileSpec.
// Only DatasetSpec / generateCollectionFromSpec ever sees EntrySpec.
export type EntrySpec = FileSpec & { count?: number }

// SeriesSpec: files sharing one SeriesInstanceUID. Only image-generating types
// can be grouped — shared UIDs flow through the generator's UidSet channel.
export type SeriesEntrySpec = ImageSpec & { count?: number }

export type SeriesSpec = {
  entries: SeriesEntrySpec[]
  tags?: DicomTagOverrides
}

// StudySpec: series sharing one StudyInstanceUID; count generates N copies of
// the whole study, each with fresh UIDs.
export type StudySpec = {
  series: SeriesSpec[]
  tags?: DicomTagOverrides
  count?: number
}

// hierarchical: grouped files written as study-NNN/series-NNN/NNNNN.dcm.
export type DatasetLayout = 'flat' | 'hierarchical'

export type DatasetSpec = {
  entries?: EntrySpec[]
  studies?: StudySpec[]
  seed?: number
  layout?: DatasetLayout
}

// A fixed value or an inclusive {min, max} sampled at resolution time.
export type Range = number | { min: number; max: number }

export type ParametricStudies = {
  count: Range
  seriesPerStudy: Range
  filesPerSeries: Range
  fileSizeKb?: Range // per-file targetSizeKb; sampled per file when a range
  modalities?: Modality[] // one drawn per series; defaults to CT
  tags?: DicomTagOverrides
}

// frequency: per-file probability (0–1) drawn across the whole dataset, so the
// resolved spec records the actual count. Omit it to append the entry as-is.
export type ParametricEdgeCase = EntrySpec & { frequency?: number }

// Range-based dataset designer — resolveParametricSpec turns this into a
// concrete, re-runnable DatasetSpec.
export type ParametricSpec = {
  seed?: number
  studies: ParametricStudies
  edgeCases?: ParametricEdgeCase[]
  layout?: DatasetLayout
}
