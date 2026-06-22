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

Keys are either DICOM keyword names (PascalCase, e.g. `"Modality"`) or 8-hex-character tag strings (e.g. `"00080060"`). Unknown hex tags produce a console warning and are skipped.

```ts
import type { DicomTagOverrides } from 'dicom-synth'
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
