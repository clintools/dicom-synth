# Synthetic fixtures

[← Documentation index](../README.md#documentation)

Generation is a three-layer API. Each layer is a thin wrapper over the one below.

## Layer 1 — single file, no I/O

```ts
import { generateFile } from 'dicom-synth'

const { buffer, filename, type, index } = await generateFile({ type: 'valid-image' })
// buffer: Uint8Array ready to write or pass to a parser
// filename: 'valid-image-000.dcm'
```

With options:

```ts
const { buffer } = await generateFile(
  { type: 'valid-image', tags: { PatientID: 'P001' }, violations: ['uid-too-long'] },
  { seed: 42, index: 7 },
)
```

Write a single file to disk:

```ts
import { writeFileSync } from 'node:fs'
import { generateFile } from 'dicom-synth'

const { buffer, filename } = await generateFile({ type: 'valid-image' })
writeFileSync(`./out/${filename}`, buffer)
```

## Layer 2 — collection stream, no I/O

```ts
import { generateCollectionFromSpec } from 'dicom-synth'

for await (const file of generateCollectionFromSpec({
  entries: [
    { type: 'valid-image', count: 10 },
    { type: 'invalid-uid-image', count: 3 },
  ],
  seed: 42,
})) {
  console.log(file.filename, file.buffer.length)
}
```

Files are yielded one at a time — safe to pipe without buffering the entire collection.

## Layer 3 — disk writer

```ts
import { writeCollectionFromSpec } from 'dicom-synth'

const manifest = await writeCollectionFromSpec(
  { entries: [{ type: 'valid-image', count: 5 }], seed: 42 },
  './fixtures/generated',
)
// manifest: Array<{ path: string; type: string; index: number }>
```

The shape of the spec these accept is the [schema reference](./schema-reference.md).

## Usage patterns

### Ephemeral fixtures in tests (CI)

Generate into a temp directory per test run — nothing committed, works in any CI environment:

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeCollectionFromSpec } from 'dicom-synth'

const dir = await mkdtemp(join(tmpdir(), 'synth-'))
try {
  await writeCollectionFromSpec(
    { entries: [{ type: 'valid-image', count: 3 }], seed: 42 },
    dir,
  )
  // run pipeline against dir
} finally {
  await rm(dir, { recursive: true, force: true })
}
```

Use a fixed `seed` in CI so UID values are identical across runs and any diff is meaningful.

### Static generation (commit schema, not binaries)

Commit a `dataset.json` schema to your repo. Add a script to regenerate fixtures on demand:

```json
// package.json
{
  "scripts": {
    "fixtures:generate": "dicom-synth-generate --schema dataset.json --out fixtures/dicom"
  }
}
```

```bash
pnpm fixtures:generate     # regenerate
```

Commit `dataset.json` and `.gitignore` the output directory. Fixtures are regenerated locally or in a dedicated CI job — never stored as binaries in version control.

### Calling the CLI from a consumer project

After installing `dicom-synth`, the `dicom-synth-generate` binary is available via your package manager:

```bash
# pnpm
pnpm exec dicom-synth-generate --schema dataset.json --out ./out

# npm / npx
npx dicom-synth-generate --schema dataset.json --out ./out

# one-off without installing
pnpm --package=dicom-synth dlx dicom-synth-generate --schema dataset.json --out ./out
```

See the [CLI reference](./cli.md) for all commands and flags.

### In-process pipeline (no disk I/O)

Use layer 2 when passing generated files directly to a parser or pipeline without writing to disk:

```ts
import { generateCollectionFromSpec, type GeneratedFile } from 'dicom-synth'

const files: GeneratedFile[] = []
for await (const file of generateCollectionFromSpec({ entries: [{ type: 'valid-image', count: 5 }] })) {
  files.push(file)
}
```
