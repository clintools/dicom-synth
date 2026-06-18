# Development

[← Documentation index](../README.md#documentation)

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

Git hooks: see [CONTRIBUTING.md](../CONTRIBUTING.md).

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
| `examples/` | Runnable examples — see the [examples index](../examples/README.md) |
