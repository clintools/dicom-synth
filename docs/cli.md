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

Scan stats (DICOM/skipped/unsupported-modality counts) are written to stderr. See the [describe tool](./describe.md) for behaviour details.

## `dicom-synth-fetch`

Fetches a public fixture by id into the content-addressed cache — see [public fixtures](./public-fixtures.md).
