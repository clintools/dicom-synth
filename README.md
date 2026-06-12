# dicom-synth

Schema-driven **synthetic DICOM fixture generation** and **public fixture** fetch/cache. Portable and independent of any consumer (e.g. [dicom-curate](https://github.com/clintools/dicom-curate)).

## Disclaimer

⚠️ Still in early release. APIs may change without notice. Version 2+ will be the first stable release ⚠️

## Install

```bash
pnpm add dicom-synth
pnpm add dcmjs   # peer dependency (^0.51.1)
```

---

## Synthetic fixtures

Generation is a three-layer API. Each layer is a thin wrapper over the one below.

### Layer 1 — single file, no I/O

```ts
import { generateFile } from 'dicom-synth'

const { buffer, filename, type, index } = await generateFile({ type: 'valid-image' })
// buffer: Buffer ready to write or pass to a parser
// filename: 'valid-image-000.dcm'
```

With options:

```ts
const { buffer } = await generateFile(
  { type: 'valid-image', tags: { PatientID: 'P001' }, violations: ['uid-too-long'] },
  { seed: 42, index: 7 },
)
```

Write a single file to disk:

```ts
import { writeFileSync } from 'node:fs'
import { generateFile } from 'dicom-synth'

const { buffer, filename } = await generateFile({ type: 'valid-image' })
writeFileSync(`./out/${filename}`, buffer)
```

### Layer 2 — collection stream, no I/O

```ts
import { generateCollectionFromSpec } from 'dicom-synth'

for await (const file of generateCollectionFromSpec({
  entries: [
    { type: 'valid-image', count: 10 },
    { type: 'invalid-uid-image', count: 3 },
  ],
  seed: 42,
})) {
  console.log(file.filename, file.buffer.length)
}
```

Files are yielded one at a time — safe to pipe without buffering the entire collection.

### Layer 3 — disk writer

```ts
import { writeCollectionFromSpec } from 'dicom-synth'

const manifest = await writeCollectionFromSpec(
  { entries: [{ type: 'valid-image', count: 5 }], seed: 42 },
  './fixtures/generated',
)
// manifest: Array<{ path: string; type: string; index: number }>
```

---

## Usage patterns

### Ephemeral fixtures in tests (CI)

Generate into a temp directory per test run — nothing committed, works in any CI environment:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCollectionFromSpec } from 'dicom-synth'

const dir = await mkdtemp(join(tmpdir(), 'synth-'))
try {
  await writeCollectionFromSpec(
    { entries: [{ type: 'valid-image', count: 3 }], seed: 42 },
    dir,
  )
  // run pipeline against dir
} finally {
  await rm(dir, { recursive: true, force: true })
}
```

Use a fixed `seed` in CI so UID values are identical across runs and any diff is meaningful.

### Static generation (commit schema, not binaries)

Commit a `dataset.json` schema to your repo. Add a script to regenerate fixtures on demand:

```json
// package.json
{
  "scripts": {
    "fixtures:generate": "dicom-synth-generate --schema dataset.json --out fixtures/dicom"
  }
}
```

```bash
pnpm fixtures:generate     # regenerate
```

Commit `dataset.json` and `.gitignore` the output directory. Fixtures are regenerated locally or in a dedicated CI job — never stored as binaries in version control.

### Calling the CLI from a consumer project

After installing `dicom-synth`, the `dicom-synth-generate` binary is available via your package manager:

```bash
# pnpm
pnpm exec dicom-synth-generate --schema dataset.json --out ./out

# npm / npx
npx dicom-synth-generate --schema dataset.json --out ./out

# one-off without installing
pnpm --package=dicom-synth dlx dicom-synth-generate --schema dataset.json --out ./out
```

### In-process pipeline (no disk I/O)

Use layer 2 when passing generated files directly to a parser or pipeline without writing to disk:

```ts
import { generateCollectionFromSpec, type GeneratedFile } from 'dicom-synth'

const files: GeneratedFile[] = []
for await (const file of generateCollectionFromSpec({ entries: [{ type: 'valid-image', count: 5 }] })) {
  files.push(file)
}
```

---

## Schema reference

### `DatasetSpec`

```ts
import type { DatasetSpec } from 'dicom-synth'

type DatasetSpec = {
  entries: EntrySpec[]   // one or more entry specs; must not be empty
  seed?: number          // optional: fixed seed for deterministic UID generation
}
```

`seed` makes UID generation fully deterministic across runs. Omit it for random UIDs.

### `EntrySpec`

An `EntrySpec` is a `FileSpec` plus an optional `count` field (how many times to generate it):

```json
{ "type": "valid-image", "count": 10 }
```

`count` defaults to 1 and must be a positive integer. It is a collection-layer concern — `generateFile` does not accept `count`.

### `FileSpec` type catalogue

| Type | Description | Conformance |
|---|---|---|
| `valid-image` | Standards-valid CT image; numeric UIDs, complete meta header | strict |
| `invalid-uid-image` | CT with non-numeric UIDs (letters in UID components) | edge |
| `vendor-warnings-image` | CT with empty `Laterality` and `PatientWeight = 0` — produces dciodvfy warnings | edge |
| `large-image` | CT with configurable pixel dimensions; `rows` and `columns` required | strict |
| `fake-signature` | 200-byte buffer with `XXXX` at preamble offset — no DICM magic | edge |
| `non-dicom` | Arbitrary text buffer; no extension in filename | edge |
| `dicomdir` | Minimal DICOMDIR file | strict |

**`large-image` fields:**

```json
{ "type": "large-image", "rows": 512, "columns": 512, "frames": 100 }
```

`frames` defaults to 1. A 512×512×100 CT produces a buffer of ~52 MB.

**`non-dicom` fields:**

```json
{ "type": "non-dicom", "content": "not a dicom file" }
```

`content` defaults to `"not dicom"`.

### Tag overrides (`tags`)

Available on `valid-image`, `invalid-uid-image`, `vendor-warnings-image`, and `large-image`.

```json
{
  "type": "valid-image",
  "tags": {
    "PatientID": "P001",
    "PatientName": "DOE^JANE",
    "00081030": "Research Protocol A"
  }
}
```

Keys are either DICOM keyword names (PascalCase, e.g. `"Modality"`) or 8-hex-character tag strings (e.g. `"00080060"`). Unknown hex tags produce a console warning and are skipped.

```ts
import type { DicomTagOverrides } from 'dicom-synth'
```

### Transfer syntax (`transferSyntax`)

Available on `valid-image`, `invalid-uid-image`, `vendor-warnings-image`, and `large-image`.

| Value | `TransferSyntaxUID` in meta header |
|---|---|
| `explicit-vr-little-endian` (default) | `1.2.840.10008.1.2.1` |
| `implicit-vr-little-endian` | `1.2.840.10008.1.2` |


### Violation injection (`violations`)

Available on `valid-image`, `invalid-uid-image`, `vendor-warnings-image`, and `large-image`. Violations are applied as post-processing transforms to an otherwise valid buffer.

| Violation | Effect | Detectable by dciodvfy |
|---|---|---|
| `uid-too-long` | Sets `SOPInstanceUID` to a 65-character value (limit is 64) | yes |
| `non-conformant-uid` | Sets `SOPInstanceUID` to a UID with a leading-zero component | yes |
| `vr-max-length-exceeded` | Sets `StudyDescription` to a 65-character value (LO limit is 64) | yes |
| `missing-type1-tag` | Removes `SOPClassUID` (Type 1 mandatory attribute) | yes |
| `missing-meta-header` | Strips the 128-byte preamble and DICM prefix | yes |
| `malformed-sq-delimiter` | Appends a sequence delimiter tag with a non-zero length field | yes |

Tag-level violations are applied before byte-level violations. Byte-level violations may produce a buffer that cannot be re-parsed.

```json
{ "type": "valid-image", "violations": ["uid-too-long", "missing-meta-header"] }
```

```ts
import type { ViolationClass } from 'dicom-synth'
```

### Schema validation

```ts
import { validateDatasetSpec } from 'dicom-synth'

const spec = validateDatasetSpec(JSON.parse(rawJson)) // throws on invalid input
```

The validator throws with a human-readable message on any structural error.

### Full schema example

```json
{
  "entries": [
    { "type": "valid-image",           "count": 10, "tags": { "PatientID": "P001" }, "transferSyntax": "explicit-vr-little-endian" },
    { "type": "invalid-uid-image",     "count": 3 },
    { "type": "vendor-warnings-image", "count": 2 },
    { "type": "large-image",           "count": 1, "rows": 512, "columns": 512, "frames": 100 },
    { "type": "valid-image",           "count": 1, "violations": ["uid-too-long", "missing-meta-header"] },
    { "type": "fake-signature",     "count": 5 },
    { "type": "non-dicom",          "count": 2, "content": "garbage" },
    { "type": "dicomdir",           "count": 1 }
  ],
  "seed": 42
}
```

---

## CLI

```bash
# From a schema file
dicom-synth-generate --schema dataset.json --out ./fixtures/generated

# Inline schema
dicom-synth-generate --schema-inline '{"entries":[{"type":"valid-image","count":5}]}' --out ./out

# Default output directory is ./fixtures/generated
dicom-synth-generate --schema dataset.json
```

The default schema (`examples/default.json`) generates one each of `valid-image`, `invalid-uid-image`, and `vendor-warnings-image`:

```bash
dicom-synth-generate --schema examples/default.json --out /tmp/out
# Wrote 3 file(s) to /tmp/out
#   valid-image: 1
#   invalid-uid-image: 1
#   vendor-warnings-image: 1
```

Schema validation errors exit with code 1 and a descriptive message.

---

## Public fixtures

Catalog metadata lives in `data/public-cases.json`. Fetched binaries are cached at `~/.cache/dicom-synth-testcases/<sha256>/file.dcm`.

### Load and fetch

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

### CI caching

The fetch cache is keyed by SHA-256 so cached files are safe to restore across CI runs. To avoid re-downloading on every run, cache the default cache root:

```yaml
# GitHub Actions example
- uses: actions/cache@v4
  with:
    path: ~/.cache/dicom-synth-testcases
    key: dicom-public-fixtures-${{ hashFiles('node_modules/dicom-synth/dist/data/public-cases.json') }}
```

### Published CLI

```bash
pnpm --package=dicom-synth@latest dlx dicom-synth-fetch pydicom-CT-small
```

### Local development

```bash
pnpm fetch:public-case -- pydicom-CT-small
```

---

## Source layout

| Path | Responsibility |
|---|---|
| `src/schema/types.ts` | All public TypeScript types (`FileSpec`, `DatasetSpec`, `ViolationClass`, etc.) |
| `src/schema/validate.ts` | `validateDatasetSpec` — validates a raw JSON value against the schema |
| `src/syntheticFixtures/generator.ts` | Internal buffer builders keyed on `FileSpec` type |
| `src/syntheticFixtures/uid.ts` | Seeded and random UID generation |
| `src/syntheticFixtures/violations.ts` | Post-processing violation injection |
| `src/collection/writer.ts` | Three-layer API — `generateFile`, `generateCollectionFromSpec`, `writeCollectionFromSpec` |
| `src/public-fixtures/catalog.ts` | Load bundled public case catalogue |
| `src/public-fixtures/fetch.ts` | Fetch, SHA-256 verify, content-addressed cache |
| `bin/dicom-synth-generate.mjs` | Published generate CLI (requires `pnpm build`) |
| `bin/dicom-synth-fetch.mjs` | Published fetch CLI (requires `pnpm build`) |
| `examples/default.json` | Default `DatasetSpec` — one each of `valid-image`, `invalid-uid-image`, `vendor-warnings-image` |

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm code:quality
```

| Script | Purpose |
|---|---|
| `pnpm write:synthetic` | Write `examples/default.json` to `fixtures/generated` |
| `pnpm fetch:public-case` | Fetch one public case by id |
| `pnpm hooks:pre-commit` | Reproduce commit hook locally |
| `pnpm hooks:pre-push` | Reproduce push hook locally |

Git hooks: see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Future development

- **Multi-series study layouts** — shared `StudyInstanceUID` across files via a `studies` top-level key; no breaking schema change needed
- **Compressed transfer syntaxes** — JPEG-LS, JPEG 2000, RLE
- **Modality presets** — MR, PET, CR profiles beyond CT
- **Private fixture catalogues** — same SHA-256 fetch/cache pattern for credentials-backed sources (e.g. S3)

---

## License

Apache-2.0
