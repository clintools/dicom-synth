# Parametric designer

[← Documentation index](../README.md#documentation)

A `ParametricSpec` describes a dataset by ranges instead of explicit entries. `resolveParametricSpec` resolves it — deterministically for a given seed — into a concrete [`DatasetSpec`](./schema-reference.md) that can be inspected, saved, and re-run.

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
    largeFilesPerSeries: { min: 0, max: 1 }, // optional disk-only large members
    largeFileBytes: 10 * 1024 * 1024 * 1024, // ~10 GB each (> 512 MB)
  },
  edgeCases: [{ type: 'invalid-uid-image', frequency: 0.05 }],
  layout: 'hierarchical',
})
await writeCollectionFromSpec(resolved, './out')
```

- Every field of `studies` accepts a fixed number or an inclusive `{ min, max }` range (`Range`).
- `fileSizeKb` maps to `targetSizeKb`; a fixed value collapses each series into one counted entry, a range samples per file.
- `largeFilesPerSeries` adds disk-only [`large-image`](./schema-reference.md#large-image-entry--a-large-file-inside-a-dataset) members to each series (the count may be zero); `largeFileBytes` is the per-file `targetBytes` (> 512 MB, required when `largeFilesPerSeries` is set, and vice versa). A fixed value collapses into one counted entry; a range is sampled per file at MB granularity. Large members share the series modality and stream to disk via `writeCollectionFromSpec`.
- `edgeCases` are `EntrySpec`s appended to the flat `entries` of the resolved spec. With `frequency` (0–1), the count is drawn per file across the whole dataset — the resolved spec records the actual draw. Without it, the entry is appended as-is (use `count` for absolute numbers). At small dataset sizes a low frequency may draw zero occurrences.
- The seed (drawn randomly when omitted) is embedded in the resolved spec, so resolution is always reproducible.

```ts
import type { ParametricSpec, ParametricStudies, ParametricEdgeCase, Range } from 'dicom-synth'
import { validateParametricSpec } from 'dicom-synth'
```

See [`examples/parametric.json`](../examples/parametric.json) for a JSON example and [`examples/convert-data-shape.mjs`](../examples/convert-data-shape.mjs) for converting an exported tree-shape JSON into a generic-tree `DatasetSpec` (mixed DICOM + sized non-DICOM files). The `--parametric` CLI path is documented in the [CLI reference](./cli.md).
