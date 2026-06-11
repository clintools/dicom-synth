// Schema types

// Collection API
export {
  type CollectionManifest,
  type GeneratedFile,
  generateCollectionFromSpec,
  generateFile,
  writeCollectionFromSpec,
} from './collection/writer.js'
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
export type {
  DatasetSpec,
  DicomdirSpec,
  DicomTagOverrides,
  FakeSignatureSpec,
  FileSpec,
  InvalidUidCtSpec,
  LargeCtSpec,
  NonDicomSpec,
  TransferSyntax,
  ValidCtSpec,
  VendorCtSpec,
  ViolationClass,
} from './schema/types.js'
// Schema validation
export { validateDatasetSpec } from './schema/validate.js'
