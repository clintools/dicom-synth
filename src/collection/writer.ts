import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DatasetSpec, FileSpec } from '../schema/types.js'
import { buildBufferForSpec } from '../syntheticFixtures/generator.js'
import { makeUidGenerator } from '../syntheticFixtures/uid.js'
import { applyViolations } from '../syntheticFixtures/violations.js'

export type GeneratedFile = {
  filename: string
  buffer: Buffer
  type: FileSpec['type']
  index: number
}

export type CollectionManifest = Array<{
  path: string
  type: FileSpec['type']
  index: number
}>

const NO_EXTENSION_TYPES = new Set<FileSpec['type']>([
  'fake-signature',
  'non-dicom',
])

function filename(
  type: FileSpec['type'],
  index: number,
  padWidth: number,
): string {
  const padded = String(index).padStart(padWidth, '0')
  const base = `${type}-${padded}`
  return NO_EXTENSION_TYPES.has(type) ? base : `${base}.dcm`
}

// Layer 1 — single file, no I/O.
// options.index: position within a collection (defaults to 0 for ad-hoc calls).
// options.seed:  drives the seeded PRNG for UID generation; omit for random UIDs.
// options.padWidth: zero-pad digit width for the filename index (defaults to 3).
export async function generateFile(
  spec: FileSpec,
  options?: { index?: number; seed?: number; padWidth?: number },
): Promise<GeneratedFile> {
  const index = options?.index ?? 0
  const padWidth = options?.padWidth ?? 3
  const uidGen = makeUidGenerator(options?.seed)
  const uid = uidGen(index)

  let buffer = buildBufferForSpec(spec, uid)

  const violations = 'violations' in spec ? spec.violations : undefined
  if (violations?.length) {
    buffer = applyViolations(buffer, violations)
  }

  return {
    filename: filename(spec.type, index, padWidth),
    buffer,
    type: spec.type,
    index,
  }
}

// Layer 2 — collection stream, no I/O.
// Expands each EntrySpec by count, threads spec.seed and a global file index
// into each generateFile call so UIDs are deterministic and non-colliding.
export async function* generateCollectionFromSpec(
  spec: DatasetSpec,
): AsyncGenerator<GeneratedFile> {
  const totalFiles = spec.entries.reduce((sum, e) => sum + (e.count ?? 1), 0)
  const padWidth = String(totalFiles).length

  let globalIndex = 0
  for (const entry of spec.entries) {
    const { count = 1, ...fileSpec } = entry as FileSpec & { count?: number }
    for (let i = 0; i < count; i++) {
      yield generateFile(fileSpec as FileSpec, {
        index: globalIndex,
        seed: spec.seed,
        padWidth,
      })
      globalIndex++
    }
  }
}

// Layer 3 — disk writer, thin wrapper over Layer 2.
export async function writeCollectionFromSpec(
  spec: DatasetSpec,
  outDir: string,
): Promise<CollectionManifest> {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })

  const manifest: CollectionManifest = []
  for await (const file of generateCollectionFromSpec(spec)) {
    const filePath = resolve(root, file.filename)
    await writeFile(filePath, file.buffer)
    manifest.push({ path: filePath, type: file.type, index: file.index })
  }
  return manifest
}
