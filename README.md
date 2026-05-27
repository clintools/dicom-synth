# dicom-synth

Toolkit for **synthetic DICOM fixtures** and **public fixture** fetch/cache. Portable and independent of any consumer (e.g. [dicom-curate](https://github.com/clintools/dicom-curate)).

## Disclaimer

Pre-1.0.0 — APIs may change without notice.

## Install

```bash
pnpm add dicom-synth
pnpm add dcmjs   # peer dependency (^0.51.1)
```

## Synthetic fixtures (in memory)

```ts
import { buildSyntheticCtBuffer, SYNTHETIC_FIXTURES } from 'dicom-synth'

const buf = buildSyntheticCtBuffer('valid-uid')
// use buf in tests or write to disk
```

Variants (see `SYNTHETIC_FIXTURES` in `src/syntheticFixtures/generator.ts`):

| Variant | Purpose |
|---------|---------|
| `minimal-invalid-uid` | Invalid UID characters (many dciodvfy errors) |
| `valid-uid` | Numeric UIDs only (missing-module noise) |
| `vendor-warnings` | Numeric UIDs plus empty Laterality and zero PatientWeight |

## Write synthetic fixtures to disk

Published CLI:

```bash
pnpm dlx dicom-synth@latest dicom-synth-write ./tmp/fixtures
```

Local development:

```bash
pnpm write:synthetic -- ./out/fixtures
```

## Public fixtures

Catalog metadata lives in `data/public-cases.json` (also importable as `dicom-synth/public-cases.json`). Fetched binaries are cached under `~/.cache/dicom-synth-testcases/<sha256>/file.dcm`.

```ts
import {
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCaseById,
} from 'dicom-synth'

const record = loadCaseById(defaultPublicCasesPath(), 'pydicom-CT-small')
const path = await fetchPublicCaseToCache(record)
```

Published CLI:

```bash
pnpm dlx dicom-synth@latest dicom-synth-fetch pydicom-CT-small
```

Local development:

```bash
pnpm fetch:public-case -- pydicom-CT-small
```

## Use in tests (ephemeral files)

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSyntheticCtBuffer } from 'dicom-synth'

const dir = await mkdtemp(join(tmpdir(), 'synth-'))
try {
  await writeFile(join(dir, 'test.dcm'), buildSyntheticCtBuffer('valid-uid'))
  // run pipeline against dir
} finally {
  await rm(dir, { recursive: true, force: true })
}
```

The same pattern works in CI when `dicom-synth` and `dcmjs` are installed; you do not need to commit `.dcm` binaries in the consumer repo.

## Source layout

| Path | Responsibility |
|------|----------------|
| `src/syntheticFixtures/generator.ts` | Deterministic synthetic CT generation |
| `src/public-fixtures/catalog.ts` | Load bundled public case catalogue |
| `src/public-fixtures/fetch.ts` | Fetch, SHA-256 verify, content-addressed cache |
| `scripts/write-synthetic-fixtures.ts` | Dev CLI for synthetic output |
| `scripts/fetch-public-case.ts` | Dev CLI for public fetch |
| `bin/dicom-synth-write.mjs` | Published write CLI (requires `pnpm build`) |
| `bin/dicom-synth-fetch.mjs` | Published fetch CLI (requires `pnpm build`) |

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm code:quality
```

| Script | Purpose |
|--------|---------|
| `pnpm write:synthetic` | Write all synthetic fixtures to a directory |
| `pnpm fetch:public-case` | Fetch one public case by id |
| `pnpm hooks:pre-commit` | Reproduce commit hook |
| `pnpm hooks:pre-push` | Reproduce push hook |

Git hooks: see [CONTRIBUTING.md](CONTRIBUTING.md).

## Future development

The current release targets stable, deterministic fixtures for conformance basic conformance testing. Planned extensions include:

- **Parameterised synthetic generation** — options for instance count, dimensions, frames, transfer syntax, and modality/profile presets.
- **Stress and scale** — very large pixel payloads, high file counts, and multi-series study layouts for performance and memory testing.
- **Seeded variation** — reproducible pseudo-random datasets (fixed seed) for broader coverage without losing determinism in CI.
- **Conformance modes** — `strict` (standards-valid stress data) vs `edge` (intentional faults for parser and validator hardening).
- **Private fixture catalogues** — same SHA-256 fetch/cache pattern as public fixtures, for credentials-backed sources (e.g. S3).
- **Export helpers** — optional upload or packaging of generated datasets for remote CI or shared test stores.

## License

Apache-2.0
