# Describe tool

[← Documentation index](../README.md#documentation)

`describeDirectory` scans an existing DICOM tree and emits a concrete [`DatasetSpec`](./schema-reference.md) reproducing its shape — studies/series grouped by their UIDs, per-file size as `targetSizeKb`, and modality. This closes the loop: real tree → spec → regenerate.

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

The `dicom-synth-describe` CLI is documented in the [CLI reference](./cli.md).
