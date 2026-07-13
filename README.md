# dicom-synth

Schema-driven **synthetic DICOM fixture generation** and **public fixture** fetch/cache. Portable and independent of any consumer (e.g. [dicom-curate](https://github.com/clintools/dicom-curate)).

## Install

```bash
pnpm add dicom-synth
pnpm add dcmjs   # peer dependency (^0.51.1)
```

## Quick start

In-process — generate a deterministic collection and use it without touching disk:

```ts
import { generateCollectionFromSpec } from 'dicom-synth'

for await (const file of generateCollectionFromSpec({
  entries: [{ type: 'valid-image', count: 5 }],
  seed: 42,
})) {
  console.log(file.filename, file.buffer.length) // Buffer ready to parse or pipe
}
```

Or from the command line — write fixtures to a directory:

```bash
dicom-synth-generate --schema-inline '{"entries":[{"type":"valid-image","count":5}]}' --out ./out
```

The full input shape (image types, sizing, modalities, grouping, violations, …) is the [schema reference](./docs/schema-reference.md).

## Documentation

| Guide | Covers |
|---|---|
| [Synthetic fixtures](./docs/synthetic-fixtures.md) | The three-layer generation API (`generateFile`, `generateCollectionFromSpec`, `writeCollectionFromSpec`) and usage patterns |
| [Schema reference](./docs/schema-reference.md) | `DatasetSpec` and every field — types, sizing, modality, grouping, layout, path quirks, tags, transfer syntax, violations, validation |
| [Parametric designer](./docs/parametric.md) | Range-based `ParametricSpec` that resolves deterministically into a `DatasetSpec` |
| [Describe tool](./docs/describe.md) | Scan a real DICOM tree → `DatasetSpec` (shape-only by default; opt-in tag preservation) |
| [CLI reference](./docs/cli.md) | `dicom-synth-generate`, `dicom-synth-describe`, `dicom-synth-fetch` |
| [Public fixtures](./docs/public-fixtures.md) | Catalog-backed fetch/cache with SHA-256 verification |
| [Development](./docs/development.md) | Scripts, hooks, and source layout |
| [Examples](./examples/README.md) | Runnable example specs and the shape converter |

## Future development

- **Very large (streamed) files** — synthesise single DICOMs beyond the 512 MB in-memory cap via a disk-only streaming writer
- **Dimension edge-case recipes** — documented presets for geometry pathologies (1×65535 strips, high frame counts)
- **Per-file tag variance templating** — patterned overrides like `"PatientID": "P{index}"` for shape replication
- **Compressed transfer syntaxes** — JPEG-LS, JPEG 2000, RLE
- **Private fixture catalogues** — same SHA-256 fetch/cache pattern for credentials-backed sources (e.g. S3)

## License

Apache-2.0
