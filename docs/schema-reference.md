# Schema reference

[← Documentation index](../README.md#documentation)

The `DatasetSpec` is the concrete input consumed by [`generateCollectionFromSpec` / `writeCollectionFromSpec`](./synthetic-fixtures.md). For a range-based designer that resolves *into* a `DatasetSpec`, see the [parametric designer](./parametric.md).

## `DatasetSpec`

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

`seed` makes UID generation fully deterministic across runs — the same spec + seed produces a byte-identical collection, so a small spec JSON is enough to re-create even a very large dataset.

Omit `seed` for random UIDs. To keep a random run reproducible, resolve the seed first and persist the result:

```ts
import { withResolvedSeed, writeCollectionFromSpec } from 'dicom-synth'

const effective = withResolvedSeed(spec) // fills in a drawn seed when absent
await writeCollectionFromSpec(effective, './out')
// persist `effective` (it now has a seed) to regenerate later
```

The `dicom-synth-generate` CLI does this automatically and reports the drawn seed — see the [CLI reference](./cli.md).

## `EntrySpec`

An `EntrySpec` is a `FileSpec` plus an optional `count` field (how many times to generate it):

```json
{ "type": "valid-image", "count": 10 }
```

`count` defaults to 1 and must be a positive integer. It is a collection-layer concern — `generateFile` does not accept `count`.

## `FileSpec` type catalogue

| Type | Description | Conformance |
|---|---|---|
| `valid-image` | Standards-valid image (CT by default — see `modality`); numeric UIDs, complete meta header | strict |
| `invalid-uid-image` | Image with non-numeric UIDs (letters in UID components) | edge |
| `vendor-warnings-image` | Image with empty `Laterality` and `PatientWeight = 0` — produces dciodvfy warnings | edge |
| `large-image` | A single DICOM >512 MB (to 50 GB), sized by `targetBytes` and streamed to disk — see below | strict (≤4 GB) |
| `fake-signature` | 200-byte buffer with `XXXX` at preamble offset — no DICM magic | edge |
| `non-dicom` | Arbitrary text buffer; no extension in filename | edge |
| `dicomdir` | Minimal DICOMDIR file | strict |

**`non-dicom` fields:**

```json
{ "type": "non-dicom", "content": "not a dicom file" }
```

`content` defaults to `"not dicom"`.

## Sizing (`rows`/`columns`/`frames` or `targetSizeKb`)

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

## Very large files (`writeLargeImageFile`, 512 MB – 50 GB)

The 512 MB cap applies to the in-memory path, where the whole file is built as one buffer. To produce a single DICOM larger than that, use the **disk-only streaming writer**, which never holds the file in memory (`PixelData` is written in fixed chunks):

```ts
import { writeLargeImageFile } from 'dicom-synth'

// Approximately 10 GB, written to disk without buffering it.
writeLargeImageFile({ targetBytes: 10 * 1024 * 1024 * 1024 }, 'huge.dcm')
```

| Field | Meaning |
|---|---|
| `targetBytes` | Approximate total file size; must be `> 512 MB` and `≤ 50 GB` |
| `modality` | Optional preset (defaults to `CT`) |
| `seed` | Optional; fixes the instance UIDs so the file is reproducible |

The encoding is chosen by size:

- **≤ ~4 GB** — native `OW` `PixelData` with consistent `Rows`/`Columns`. Fully conformant; a defined-length element cannot exceed the 32-bit `0xFFFFFFFE` ceiling.
- **> ~4 GB** — encapsulated, undefined-length `OB` `PixelData` split into fragments (declared transfer syntax: RLE Lossless). The container is structurally valid, but the fragment bytes are zeros, **not real compressed pixel data** — strict decoders may reject the pixels.

The in-memory `generateFile`/`targetSizeKb` path keeps the 512 MB cap unchanged. Generating tens of GB takes real disk and time.

For tests/CI, `streamLargeImage(path, { targetBytes, modality?, seed?, owMaxBytes?, fragmentBytes? })` is the low-level entry behind `writeLargeImageFile`. It applies no size floor, and overriding `owMaxBytes`/`fragmentBytes` forces either the native or encapsulated encoding at KB scale — so both code paths can be exercised inline without writing gigabytes:

```ts
import { streamLargeImage } from 'dicom-synth'

// Forces the encapsulated path in ~16 KB.
const { encoding } = streamLargeImage('frag.dcm', {
  targetBytes: 16384,
  seed: 1,
  owMaxBytes: 1024,
  fragmentBytes: 512,
})
```

### `large-image` entry — a large file *inside* a dataset

To place a large file in a collection (e.g. one big instance within a study/series), use the `large-image` entry type instead of the standalone writer:

```json
{ "type": "large-image", "targetBytes": 10737418240, "modality": "PT" }
```

| Field | Meaning |
|---|---|
| `targetBytes` | Approximate file size; must be `> 512 MB` and `≤ 50 GB` (required) |
| `modality` | Optional preset (defaults to `CT`) |
| `tags` | Optional tag overrides |

- It can sit in a `studies → series` group and shares the group's `StudyInstanceUID`/`SeriesInstanceUID` and `InstanceNumber`, like any image entry.
- It is **disk-only**: `writeCollectionFromSpec` streams it to disk; the in-memory `generateFile`/`generateCollectionFromSpec` reject it (it cannot be a buffer). `--dry-run` reports its `targetBytes` without writing.
- Pixel-geometry fields (`rows`/`columns`/`frames`/`targetSizeKb`) and `violations` are not accepted — sizing is by `targetBytes`.
- `describe` captures real files >512 MB as `large-image` entries (read header-only, so it never loads the pixel data).

## Modality presets (`modality`)

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

## Study/series grouping (`studies`)

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

### Per-instance form (`instances`)

A series carries **exactly one** of `entries` or `instances`. The `instances` form expresses per-file variation as **parallel arrays indexed by instance position**, so file *i* takes the *i*-th element of every array — keeping varying tags correlated with each other and with size, without one entry per file. Constant tags stay on `series.tags` (stored once); only what varies becomes an array. This is what [`describe`](./describe.md) emits when a kept tag varies across a series.

```json
{
  "studies": [{
    "series": [{
      "tags": { "Manufacturer": "ACME" },
      "instances": {
        "count": 3,
        "targetSizeKb": [10, 20, 30],
        "tags": { "PatientID": ["P-A", "P-B", "P-C"] }
      }
    }]
  }]
}
```

- Exactly one of `targetSizeKb` / `targetBytes`; each present array has length `count`.
- `modality` is scalar when the series is one modality (the norm), or a length-`count` array if it varies.
- Each `tags` value is a length-`count` array; file *i* gets element *i*. Shared tags belong on `series.tags`, not here.

```ts
import type { SeriesInstances } from 'dicom-synth'
```

## Layout (`layout`)

| Value | Effect |
|---|---|
| `flat` (default) | All files in the output root, named `<type>-<index>[.dcm]` |
| `hierarchical` | Grouped files written as `study-001/series-001/00001.dcm`; flat `entries` stay in the root |

`GeneratedFile.relativePath` carries the layout-aware path for in-process consumers; `filename` is always the basename.

## Path quirks (`pathQuirks`)

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

## Tag overrides (`tags`)

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

Keys are either DICOM keyword names (PascalCase, e.g. `"PatientID"`) or 8-hex-character tag strings (e.g. `"00080060"`). Unknown hex tags produce a console warning and are skipped.

A **preset** modality (`CT`/`PT`/`MR`/`CR`) cannot be set through `tags` — it is coupled to `SOPClassUID` and the modality type-1 attributes, so it is set via the [`modality`](#modality-presets-modality) field instead, and supplying it in `tags` fails validation. Non-preset modalities (e.g. `US`, `NM`) have no preset, so `tags` stays their only route and is permitted.

```ts
import type { DicomTagOverrides } from 'dicom-synth'
```

### Templated tag values

String tag values may contain placeholder tokens, resolved per file at generation time from the file's position. The same template works on the schema, parametric, and describe paths, so the spec stores *shape*, not per-file values (entries still collapse — no spec bloat) and no real values are emitted.

| Token | Resolves to |
|---|---|
| `{index}` | 0-based position across the whole dataset |
| `{studyIndex}` | 0-based study position (grouped studies only) |
| `{seriesIndex}` | 0-based series position within its study (grouped studies only) |
| `{instanceNumber}` | 1-based `InstanceNumber` within its series (grouped studies only) |

```json
{ "type": "valid-image", "tags": { "PatientID": "P{studyIndex}-{instanceNumber}" } }
```

- A single-brace `{token}` is a placeholder; an unknown token name fails validation. For a **literal** brace, double it — `{{` → `{`, `}}` → `}` (e.g. `"T1 {{flair}}"` → `T1 {flair}`). describe escapes captured values this way, so real brace-containing values round-trip verbatim.
- The three grouping tokens are only available inside `studies`; using one on a flat `entries` item throws at generation.
- Non-string values (numbers, arrays) pass through untouched.

```ts
import { resolveTagTemplates, TEMPLATE_VOCAB, type TagContext } from 'dicom-synth'
```

## Transfer syntax (`transferSyntax`)

Available on all image types.

| Value | `TransferSyntaxUID` in meta header |
|---|---|
| `explicit-vr-little-endian` (default) | `1.2.840.10008.1.2.1` |
| `implicit-vr-little-endian` | `1.2.840.10008.1.2` |

## Violation injection (`violations`)

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

## Schema validation

```ts
import { validateDatasetSpec } from 'dicom-synth'

const spec = validateDatasetSpec(JSON.parse(rawJson)) // throws on invalid input
```

The validator throws with a human-readable message on any structural error.

## Full schema example

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
