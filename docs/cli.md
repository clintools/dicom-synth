# CLI reference

[← Documentation index](../README.md#documentation)

The CLIs are published bins; they require a built `dist/` (`pnpm build`) when run from source.

## `dicom-synth-generate`

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

# Stream a single very large DICOM straight to disk (512 MB – 50 GB)
dicom-synth-generate --large-file huge.dcm --size 10gb --modality PT
```

| Flag | Effect |
|---|---|
| `--schema <path>` / `--schema-inline <json>` / `--parametric <path>` | Input spec (mutually exclusive) |
| `--out <dir>` | Output directory (default `./fixtures/generated`) |
| `--emit-spec <path>` | Write the effective `DatasetSpec` JSON (works for every input mode) |
| `--dry-run` | Generate in memory and print the manifest; nothing is written |
| `--large-file <path> --size <600mb\|50gb>` | Stream one DICOM to disk; `--modality` optional. Mutually exclusive with the spec modes |

**Very large files:** `--large-file` writes a single DICOM of approximately `--size` (512 MB – 50 GB) without buffering it in memory. Files up to ~4 GB are conformant native DICOM; larger files use encapsulated fragments (valid container, zero pixel content — see the [schema reference](./schema-reference.md#very-large-files-writelargeimagefile-512-mb--50-gb)). Generating tens of GB takes real disk and time.

**Reproducibility:** when the spec omits a `seed`, one is drawn and reported on stderr (`Generated with seed <n>`). Pass `--emit-spec` to capture the effective spec — including that seed — so the exact dataset can be re-created later from a tiny JSON, even for very large outputs. Re-running `--schema <emitted>.json` reproduces the identical tree.

The default schema (`examples/default.json`) generates one each of `valid-image`, `invalid-uid-image`, and `vendor-warnings-image`:

```bash
dicom-synth-generate --schema examples/default.json --out /tmp/out
# Wrote 3 file(s) to /tmp/out
#   valid-image: 1
#   invalid-uid-image: 1
#   vendor-warnings-image: 1
```

Schema validation errors exit with code 1 and a descriptive message.

The schema accepted here is the [schema reference](./schema-reference.md); `--parametric` input is the [parametric designer](./parametric.md).

## `dicom-synth-describe`

```bash
# Default: shape + hash-derived UID links, no descriptive tags (PHI-safe)
dicom-synth-describe ./real-dataset

# Save to a file, and keep selected tags (caller owns any PHI in them)
dicom-synth-describe ./real-dataset --out spec.json --keep-tags Manufacturer,00080060

# Read the keep-list from a file (one tag per line, # comments)
dicom-synth-describe ./real-dataset --keep-tags-file keep.txt

# Fold near-identical sizes (±5%) and write a gzip-compressed spec
dicom-synth-describe ./real-dataset --size-tolerance 0.05 --out spec.json.gz

# Shape only, freshly minted UIDs (no link preservation)
dicom-synth-describe ./real-dataset --no-preserve-uids --out spec.json
```

| Flag | Effect |
|---|---|
| `<dir>` | DICOM tree to scan (required) |
| `--out <path>` | Write the `DatasetSpec` JSON (default: stdout); a `.gz` suffix gzips it |
| `--keep-tags <a,b,...>` | Copy the named tags (keywords or 8-hex) verbatim; omit for shape only |
| `--keep-tags-file <path>` | Same allow-list from a file (one tag per line, `#` comments); merged with `--keep-tags` |
| `--size-tolerance <fraction>` | Fold near-identical file sizes (e.g. `0.05` = ±5%) into one entry; default exact. Normal images only — large files keep exact `targetBytes` |
| `--no-preserve-uids` | Disable UID link preservation (on by default); emit shape only with freshly minted UIDs |
| `--uid-salt <hex>` | Pin the hashing salt to a specific namespace; when omitted the salt derives from the dataset's own study UIDs (reproducible, and disjoint across datasets). Cannot combine with `--no-preserve-uids` |
| `--gzip` | Write the spec gzip-compressed (also inferred from a `.gz` `--out` suffix) |

By default UIDs are preserved as hash-derived synthetics — cross-file links (e.g. `FrameOfReferenceUID`) survive with no original UID emitted. Modality-coupled and UID-valued tags are dropped from the keep-list with a warning (see the [describe tool](./describe.md)). Scan stats (DICOM/skipped/unsupported-modality counts) — and the UID salt — are written to stderr.

## `dicom-synth-fetch`

Fetches a public fixture by id into the content-addressed cache — see [public fixtures](./public-fixtures.md).
