# Examples

Runnable examples for `dicom-synth`. See the [documentation index](../README.md#documentation) for full guides.

| File | What it is | Used with |
|---|---|---|
| [`default.json`](./default.json) | Minimal `DatasetSpec` — one each of `valid-image`, `invalid-uid-image`, `vendor-warnings-image` | `dicom-synth-generate --schema examples/default.json` |
| [`parametric.json`](./parametric.json) | Example `ParametricSpec` (range-based designer) | `dicom-synth-generate --parametric examples/parametric.json` |
| [`convert-data-shape.mjs`](./convert-data-shape.mjs) | Converter: an exported tree-shape JSON → generic-tree `DatasetSpec` (mixed DICOM + sized non-DICOM) | `node examples/convert-data-shape.mjs <shape.json> [--out spec.json]` |

Relevant docs: [schema reference](../docs/schema-reference.md) · [parametric designer](../docs/parametric.md) · [CLI](../docs/cli.md).
