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
  entries?: EntrySpec[]              // flat entries — each file gets its own UIDs
  studies?: StudySpec[]              // grouped entries — shared study/series UIDs
  seed?: number                      // optional: fixed seed for deterministic UID generation
  layout?: 'flat' | 'hierarchical'   // optional: directory layout for grouped files
}
```

At least one of `entries` or `studies` must be present and non-empty; both may be used together.

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
| `valid-image` | Standards-valid image (CT by default — see `modality`); numeric UIDs, complete meta header | strict |
| `invalid-uid-image` | Image with non-numeric UIDs (letters in UID components) | edge |
| `vendor-warnings-image` | Image with empty `Laterality` and `PatientWeight = 0` — produces dciodvfy warnings | edge |
| `fake-signature` | 200-byte buffer with `XXXX` at preamble offset — no DICM magic | edge |
| `non-dicom` | Arbitrary text buffer; no extension in filename | edge |
| `dicomdir` | Minimal DICOMDIR file | strict |

**`non-dicom` fields:**

```json
{ "type": "non-dicom", "content": "not a dicom file" }
```

`content` defaults to `"not dicom"`.

### Sizing (`rows`/`columns`/`frames` or `targetSizeKb`)

Available on all image types. Two mutually exclusive mechanisms; omitting both produces a minimal 1×1 image.

**Explicit pixel dimensions** — for geometry-shaped cases (large frames, strips, multi-frame):

```json
{ "type": "valid-image", "rows": 512, "columns": 512, "frames": 100 }
```

`rows` and `columns` must be provided together; `frames` defaults to 1. A 512×512×100 image produces a buffer of ~52 MB.

**Target file size** — for byte-shaped cases (upload limits, memory ceilings):

```json
{ "type": "valid-image", "targetSizeKb": 250000 }
```

Pads `PixelData` so the file lands within ±2% or ±4 KB of the target (whichever is larger), accounting for tag and transfer-syntax overhead. `Rows`/`Columns` stay consistent with the pixel data, so the file remains conformant.

Both mechanisms are capped at 512 MB of pixel data to prevent accidental OOM. A target smaller than the file's fixed overhead (roughly 1 KB) produces the minimal possible file, slightly above target. When sizing fields are set they control `Rows`, `Columns`, and `PixelData` — tag overrides of those keywords do not apply.

### Modality presets (`modality`)

Available on all image types. Defaults to `CT`.

```json
{ "type": "valid-image", "modality": "PT" }
```

Each preset sets the matching SOP Class UID (dataset and meta header), the `Modality` tag, and minimal modality-specific type-1 attributes:

| Modality | SOP Class | Extra attributes |
|---|---|---|
| `CT` (default) | CT Image Storage `…1.1.2` | — |
| `PT` | PET Image Storage `…1.1.128` | `Units`, `DecayCorrection`, `CorrectedImage` |
| `MR` | MR Image Storage `…1.1.4` | `ScanningSequence`, `SequenceVariant` |
| `CR` | CR Image Storage `…1.1.1` | — |

Presets target shape/variance fidelity for pipeline testing, not clinical fidelity. Tag overrides win over preset attributes.

```ts
import type { Modality } from 'dicom-synth'
```

### Study/series grouping (`studies`)

Group files so they share `StudyInstanceUID` (per study) and `SeriesInstanceUID` (per series). `InstanceNumber` increments from 1 within each series. SOP Instance UIDs remain unique per file.

```json
{
  "studies": [
    {
      "tags": { "PatientID": "P001" },
      "series": [
        { "entries": [{ "type": "valid-image", "modality": "CT", "count": 50 }] },
        { "entries": [{ "type": "valid-image", "modality": "PT", "count": 120 }] }
      ]
    },
    { "series": [{ "entries": [{ "type": "valid-image" }] }], "count": 3 }
  ],
  "seed": 42,
  "layout": "hierarchical"
}
```

- `StudySpec.count` generates N copies of the whole study, each with fresh UIDs.
- `tags` may be set at study, series, and entry level — merged into each file, with entry tags winning over series tags, which win over study tags.
- Only image-generating types can appear in a series (`fake-signature`, `non-dicom`, and `dicomdir` are rejected).
- With a `seed`, group UIDs are deterministic; without one they are random but still shared within each group.

```ts
import type { StudySpec, SeriesSpec, SeriesEntrySpec } from 'dicom-synth'
```

### Layout (`layout`)

| Value | Effect |
|---|---|
| `flat` (default) | All files in the output root, named `<type>-<index>[.dcm]` |
| `hierarchical` | Grouped files written as `study-001/series-001/00001.dcm`; flat `entries` stay in the root |

`GeneratedFile.relativePath` carries the layout-aware path for in-process consumers; `filename` is always the basename.

### Path quirks (`pathQuirks`)

Decorate written paths with edge-case names to exercise consumer file handling (e.g. the Chrome File System Access API). Quirks apply to the relative paths the layout already produces — DICOM byte content is unchanged.

```json
{
  "studies": [{ "series": [{ "entries": [{ "type": "valid-image", "count": 3 }] }] }],
  "layout": "hierarchical",
  "pathQuirks": ["trailing-dot", "unicode"]
}
```

| Quirk | Effect |
|---|---|
| `trailing-dot` | Appends `.` to each directory component (`study-001./series-001./…`); on flat output, to the filename |
| `unicode` | Inserts a non-ASCII character into directory and file names |
| `deep-nesting` | Injects extra nested directory levels before the file |
| `long-name` | Pads the filename stem and the deepest directory component toward the 255-byte limit |

Decorations are stable per path component, so a series' files still share one directory. Quirks compose; the result is deterministic and independent of the order they're listed in.

> **Cross-platform:** these names are writable on POSIX (Linux/macOS, where CI runs) but Windows rewrites or rejects several (trailing dots, reserved names, long paths). The intent is to *feed* a downstream consumer (e.g. a browser), not to round-trip on Windows.

```ts
import type { PathQuirk } from 'dicom-synth'
```

### Tag overrides (`tags`)

Available on all image types.

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

Available on all image types.

| Value | `TransferSyntaxUID` in meta header |
|---|---|
| `explicit-vr-little-endian` (default) | `1.2.840.10008.1.2.1` |
| `implicit-vr-little-endian` | `1.2.840.10008.1.2` |


### Violation injection (`violations`)

Available on all image types. Violations are applied as post-processing transforms to an otherwise valid buffer.

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
    { "type": "valid-image",           "count": 1, "rows": 512, "columns": 512, "frames": 100 },
    { "type": "valid-image",           "count": 1, "targetSizeKb": 250000 },
    { "type": "valid-image",           "count": 1, "violations": ["uid-too-long", "missing-meta-header"] },
    { "type": "fake-signature",     "count": 5 },
    { "type": "non-dicom",          "count": 2, "content": "garbage" },
    { "type": "dicomdir",           "count": 1 }
  ],
  "studies": [
    {
      "series": [
        { "entries": [{ "type": "valid-image", "modality": "CT", "count": 50 }] },
        { "entries": [{ "type": "valid-image", "modality": "PT", "count": 120 }] }
      ]
    }
  ],
  "seed": 42,
  "layout": "hierarchical"
}
```

---

## Parametric designer

A `ParametricSpec` describes a dataset by ranges instead of explicit entries. `resolveParametricSpec` resolves it — deterministically for a given seed — into a concrete `DatasetSpec` that can be inspected, saved, and re-run.

```ts
import { resolveParametricSpec, writeCollectionFromSpec } from 'dicom-synth'

const resolved = resolveParametricSpec({
  seed: 42,
  studies: {
    count: { min: 2, max: 4 },          // ranges are inclusive
    seriesPerStudy: { min: 1, max: 3 },
    filesPerSeries: { min: 5, max: 20 },
    fileSizeKb: { min: 100, max: 600 }, // sampled per file
    modalities: ['CT', 'PT'],           // one drawn per series
  },
  edgeCases: [{ type: 'invalid-uid-image', frequency: 0.05 }],
  layout: 'hierarchical',
})
await writeCollectionFromSpec(resolved, './out')
```

- Every field of `studies` accepts a fixed number or an inclusive `{ min, max }` range (`Range`).
- `fileSizeKb` maps to `targetSizeKb`; a fixed value collapses each series into one counted entry, a range samples per file.
- `edgeCases` are `EntrySpec`s appended to the flat `entries` of the resolved spec. With `frequency` (0–1), the count is drawn per file across the whole dataset — the resolved spec records the actual draw. Without it, the entry is appended as-is (use `count` for absolute numbers). At small dataset sizes a low frequency may draw zero occurrences.
- The seed (drawn randomly when omitted) is embedded in the resolved spec, so resolution is always reproducible.

```ts
import type { ParametricSpec, ParametricStudies, ParametricEdgeCase, Range } from 'dicom-synth'
import { validateParametricSpec } from 'dicom-synth'
```

See `examples/parametric.json` for a JSON example and `examples/convert-data-shape.mjs` for converting an exported tree-shape JSON into a `DatasetSpec` (skips non-DICOM files).

---

## Describe tool

`describeDirectory` scans an existing DICOM tree and emits a concrete `DatasetSpec` reproducing its shape — studies/series grouped by their UIDs, per-file size as `targetSizeKb`, and modality. This closes the loop: real tree → spec → regenerate.

```ts
import { describeDirectory, writeCollectionFromSpec } from 'dicom-synth'

const { spec, stats } = describeDirectory('./real-dataset')
// stats: { dicomFiles, skipped, unknownModality }
await writeCollectionFromSpec(spec, './reproduced')
```

- **Shape only by default** — no tags are copied; the regenerated dataset carries fresh UIDs and synthetic identifiers, so it cannot leak PHI from the source.
- **Opt-in tag preservation** — `keepTags` copies the named tags verbatim (some datasets are valuable for testing *precisely because* of their problematic tags):

  ```ts
  describeDirectory('./real-dataset', { keepTags: ['Manufacturer', '00080060'] })
  ```

  ⚠️ Tags are copied exactly as found. If a kept tag contains PHI, handling that PHI is the **caller's responsibility** — the tool extracts only what you name.
- Files in a series collapse into one counted entry only when modality, size, and kept tags all match, so tag/size variation is preserved rather than flattened.
- Non-DICOM, unparseable, or ungroupable files (missing study/series UIDs) are skipped and counted. An unsupported `Modality` is emitted as the default (CT) and counted.

```ts
import type { DescribeOptions, DescribeResult } from 'dicom-synth'
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

# Resolve and generate from a parametric spec; save the resolved DatasetSpec
dicom-synth-generate --parametric examples/parametric.json --out ./out --emit-spec resolved.json

# Preview the manifest (paths, types, sizes) without writing anything
dicom-synth-generate --parametric examples/parametric.json --dry-run
```

| Flag | Effect |
|---|---|
| `--schema <path>` / `--schema-inline <json>` / `--parametric <path>` | Input spec (mutually exclusive) |
| `--out <dir>` | Output directory (default `./fixtures/generated`) |
| `--emit-spec <path>` | Write the resolved `DatasetSpec` JSON (requires `--parametric`) |
| `--dry-run` | Generate in memory and print the manifest; nothing is written |

The default schema (`examples/default.json`) generates one each of `valid-image`, `invalid-uid-image`, and `vendor-warnings-image`:

```bash
dicom-synth-generate --schema examples/default.json --out /tmp/out
# Wrote 3 file(s) to /tmp/out
#   valid-image: 1
#   invalid-uid-image: 1
#   vendor-warnings-image: 1
```

Schema validation errors exit with code 1 and a descriptive message.

### Describe an existing tree

```bash
# Shape only (PHI-safe) — prints the DatasetSpec to stdout
dicom-synth-describe ./real-dataset

# Save to a file, and keep selected tags (caller owns any PHI in them)
dicom-synth-describe ./real-dataset --out spec.json --keep-tags Manufacturer,00080060
```

| Flag | Effect |
|---|---|
| `<dir>` | DICOM tree to scan (required) |
| `--out <path>` | Write the `DatasetSpec` JSON (default: stdout) |
| `--keep-tags <a,b,...>` | Copy the named tags (keywords or 8-hex) verbatim; omit for shape only |

Scan stats (DICOM/skipped/unsupported-modality counts) are written to stderr.

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
| `src/schema/validate.ts` | `validateDatasetSpec` / `validateParametricSpec` — validate raw JSON values against the schema |
| `src/schema/parametric.ts` | `resolveParametricSpec` — seeded `ParametricSpec` → `DatasetSpec` resolution |
| `src/describe/describe.ts` | `describeDirectory` — scan a DICOM tree → `DatasetSpec` |
| `src/syntheticFixtures/generator.ts` | Internal buffer builders keyed on `FileSpec` type |
| `src/syntheticFixtures/uid.ts` | Seeded and random UID generation |
| `src/syntheticFixtures/violations.ts` | Post-processing violation injection |
| `src/collection/writer.ts` | Three-layer API — `generateFile`, `generateCollectionFromSpec`, `writeCollectionFromSpec` |
| `src/public-fixtures/catalog.ts` | Load bundled public case catalogue |
| `src/public-fixtures/fetch.ts` | Fetch, SHA-256 verify, content-addressed cache |
| `bin/dicom-synth-generate.mjs` | Published generate CLI (requires `pnpm build`) |
| `bin/dicom-synth-fetch.mjs` | Published fetch CLI (requires `pnpm build`) |
| `bin/dicom-synth-describe.mjs` | Published describe CLI (requires `pnpm build`) |
| `examples/default.json` | Default `DatasetSpec` — one each of `valid-image`, `invalid-uid-image`, `vendor-warnings-image` |
| `examples/parametric.json` | Example `ParametricSpec` for the `--parametric` CLI path |
| `examples/convert-data-shape.mjs` | Example converter: tree-shape JSON → `DatasetSpec` |

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

- **Dimension edge-case recipes** — documented presets for geometry pathologies (1×65535 strips, high frame counts)
- **Per-file tag variance templating** — patterned overrides like `"PatientID": "P{index}"` for shape replication
- **Compressed transfer syntaxes** — JPEG-LS, JPEG 2000, RLE
- **Private fixture catalogues** — same SHA-256 fetch/cache pattern for credentials-backed sources (e.g. S3)

---

## License

Apache-2.0
