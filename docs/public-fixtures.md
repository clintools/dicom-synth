# Public fixtures

[← Documentation index](../README.md#documentation)

Catalog metadata lives in `data/public-cases.json`. Fetched binaries are cached at `~/.cache/dicom-synth-testcases/<sha256>/file.dcm`.

## Load and fetch

```ts
import {
  loadDefaultCases,
  loadCaseById,
  loadCasesFromJson,
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  caseCachePath,
} from 'dicom-synth'

// Load all bundled cases
const cases = loadDefaultCases()

// Load one bundled case by id
const record = loadCaseById(defaultPublicCasesPath(), 'pydicom-CT-small')

// Load a custom catalogue
const custom = loadCasesFromJson('./my-cases.json')

// Fetch to local cache, returns the file path
const path = await fetchPublicCaseToCache(record)

// Resolve the cache path for a known SHA-256 without fetching
const cached = caseCachePath(record.sha256)
```

## CI caching

The fetch cache is keyed by SHA-256 so cached files are safe to restore across CI runs. To avoid re-downloading on every run, cache the default cache root:

```yaml
# GitHub Actions example
- uses: actions/cache@v4
  with:
    path: ~/.cache/dicom-synth-testcases
    key: dicom-public-fixtures-${{ hashFiles('node_modules/dicom-synth/dist/data/public-cases.json') }}
```

## Published CLI

```bash
pnpm --package=dicom-synth@latest dlx dicom-synth-fetch pydicom-CT-small
```

## Local development

```bash
pnpm fetch:public-case -- pydicom-CT-small
```
