// Schema types

// Collection API
export {
  type CollectionManifest,
  type CollectionPreviewItem,
  type GeneratedFile,
  generateCollectionFromSpec,
  generateFile,
  previewCollection,
  withResolvedSeed,
  writeCollectionFromSpec,
} from './collection/writer.js'
export {
  type DescribeOptions,
  type DescribeResult,
  describeDirectory,
} from './describe/describe.js'
// Public fixture fetch/cache (unchanged)
export {
  defaultPublicCasesPath,
  loadCaseById,
  loadCasesFromJson,
  loadDefaultCases,
  type PublicCaseRecord,
  type PublicCaseSource,
} from './public-fixtures/catalog.js'
export {
  caseCachePath,
  fetchPublicCaseToCache,
  verifySha256,
} from './public-fixtures/fetch.js'
export { MAX_PIXEL_BYTES, MAX_STREAM_BYTES } from './schema/limits.js'
export { resolveParametricSpec } from './schema/parametric.js'
export type {
  DatasetLayout,
  DatasetSpec,
  DicomdirSpec,
  DicomTagOverrides,
  FakeSignatureSpec,
  FileSpec,
  ImageSpec,
  InvalidUidImageSpec,
  LargeFileSpec,
  Modality,
  NonDicomSpec,
  ParametricEdgeCase,
  ParametricSpec,
  ParametricStudies,
  PathQuirk,
  Range,
  SeriesEntrySpec,
  SeriesInstances,
  SeriesSpec,
  StudySpec,
  TransferSyntax,
  ValidImageSpec,
  VendorWarningsImageSpec,
  ViolationClass,
} from './schema/types.js'
// Schema validation
export {
  validateDatasetSpec,
  validateParametricSpec,
} from './schema/validate.js'
export {
  type LargeFileEncoding,
  type LargeFileResult,
  type LargeImageSpec,
  type StreamLargeImageOptions,
  streamLargeImage,
  writeLargeImageFile,
} from './syntheticFixtures/streamWrite.js'
export {
  resolveTagTemplates,
  type TagContext,
  TEMPLATE_VOCAB,
} from './syntheticFixtures/tagTemplate.js'
