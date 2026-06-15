import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type {
  DatasetSpec,
  DicomTagOverrides,
  EntrySpec,
  FileSpec,
  PathQuirk,
  StudySpec,
} from '../schema/types.js'
import { buildBufferForSpec } from '../syntheticFixtures/generator.js'
import type { UidSet } from '../syntheticFixtures/uid.js'
import {
  makeGroupUidGenerator,
  makeUidGenerator,
} from '../syntheticFixtures/uid.js'
import { applyViolations } from '../syntheticFixtures/violations.js'

export type GeneratedFile = {
  filename: string
  // Path relative to the collection root — equals filename except for grouped
  // files under layout: 'hierarchical' (study-NNN/series-NNN/NNNNN.dcm).
  relativePath: string
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

function entryCount(entries: EntrySpec[]): number {
  return entries.reduce((sum, e) => sum + (e.count ?? 1), 0)
}

function studyFileCount(studies: StudySpec[]): number {
  return studies.reduce(
    (sum, study) =>
      sum +
      (study.count ?? 1) *
        study.series.reduce((s, series) => s + entryCount(series.entries), 0),
    0,
  )
}

// Layer 1 — single file, no I/O.
// options.index: position within a collection (defaults to 0 for ad-hoc calls).
// options.seed:  drives the seeded PRNG for UID generation; omit for random UIDs.
// options.padWidth: zero-pad digit width for the filename index (defaults to 3).
// options.uid:   overrides individual UIDs — how the collection layer threads
//                shared study/series UIDs into grouped files.
export async function generateFile(
  spec: FileSpec,
  options?: {
    index?: number
    seed?: number
    padWidth?: number
    uid?: Partial<UidSet>
  },
): Promise<GeneratedFile> {
  const index = options?.index ?? 0
  const padWidth = options?.padWidth ?? 3
  const uidGen = makeUidGenerator(options?.seed)
  const uid = { ...uidGen(index), ...options?.uid }

  let buffer = buildBufferForSpec(spec, uid)

  const violations = 'violations' in spec ? spec.violations : undefined
  if (violations?.length) {
    buffer = applyViolations(buffer, violations)
  }

  const name = filename(spec.type, index, padWidth)
  return {
    filename: name,
    relativePath: name,
    buffer,
    type: spec.type,
    index,
  }
}

// FNV-1a — stable per-string hash so a given path component always picks the
// same decoration, keeping a series' files under one directory.
function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const UNICODE_TOKENS = ['é', 'ü', 'ñ', '日', '™', 'Ω']
const NEST_DEPTH = 8
const LONG_NAME_TARGET = 200 // stays under the 255-byte component limit

// Decorate a relative path with edge-case quirks. Component decorations are
// derived from the component string (not the file index), so files sharing a
// directory keep sharing it.
function applyPathQuirks(
  relativePath: string,
  quirks: PathQuirk[],
): { relativePath: string; filename: string } {
  const segments = relativePath.split('/')
  let dirs = segments.slice(0, -1)
  const leaf = segments[segments.length - 1] as string

  const dot = leaf.lastIndexOf('.')
  let stem = dot > 0 ? leaf.slice(0, dot) : leaf
  const ext = dot > 0 ? leaf.slice(dot) : ''

  const unicode = (s: string) =>
    `${s}${UNICODE_TOKENS[hashString(s) % UNICODE_TOKENS.length]}`
  const has = (q: PathQuirk) => quirks.includes(q)

  if (has('deep-nesting')) {
    dirs = [...dirs, ...Array.from({ length: NEST_DEPTH }, (_, i) => `d${i}`)]
  }
  if (has('unicode')) {
    dirs = dirs.map(unicode)
    stem = unicode(stem)
  }
  if (has('long-name')) {
    const pad = (s: string) =>
      s.length < LONG_NAME_TARGET
        ? s + 'x'.repeat(LONG_NAME_TARGET - s.length)
        : s
    stem = pad(stem)
    // Pad the deepest directory too (the long-component / long-path boundary),
    // but only one component so the total path stays within OS limits.
    if (dirs.length > 0) {
      const last = dirs.length - 1
      dirs = dirs.map((d, i) => (i === last ? pad(d) : d))
    }
  }

  let newLeaf = stem + ext
  if (has('trailing-dot')) {
    // No directories (flat) — apply the trailing dot to the file instead.
    if (dirs.length > 0) dirs = dirs.map((d) => `${d}.`)
    else newLeaf += '.'
  }

  return { relativePath: [...dirs, newLeaf].join('/'), filename: newLeaf }
}

// Grouped-file naming under layout: 'hierarchical'.
function hierarchicalName(
  studyOrdinal: number,
  seriesIndex: number,
  instanceNumber: number,
): { filename: string; relativePath: string } {
  const pad3 = (n: number) => String(n).padStart(3, '0')
  const name = `${String(instanceNumber).padStart(5, '0')}.dcm`
  return {
    filename: name,
    relativePath: `study-${pad3(studyOrdinal + 1)}/series-${pad3(seriesIndex + 1)}/${name}`,
  }
}

// Layer 2 — collection stream, no I/O.
// Flat entries keep their own study/series UIDs per file. Grouped studies share
// a StudyInstanceUID per study copy and a SeriesInstanceUID per series, threaded
// through the generator's UidSet channel; user-supplied tags still win.
export async function* generateCollectionFromSpec(
  spec: DatasetSpec,
): AsyncGenerator<GeneratedFile> {
  const flatEntries = spec.entries ?? []
  const studies = spec.studies ?? []
  const totalFiles = entryCount(flatEntries) + studyFileCount(studies)
  const padWidth = String(totalFiles).length
  const hierarchical = spec.layout === 'hierarchical'
  const quirks = spec.pathQuirks ?? []

  const decorate = (file: GeneratedFile): GeneratedFile =>
    quirks.length === 0
      ? file
      : { ...file, ...applyPathQuirks(file.relativePath, quirks) }

  let globalIndex = 0

  for (const entry of flatEntries) {
    const { count = 1, ...fileSpec } = entry as FileSpec & { count?: number }
    for (let i = 0; i < count; i++) {
      yield decorate(
        await generateFile(fileSpec as FileSpec, {
          index: globalIndex,
          seed: spec.seed,
          padWidth,
        }),
      )
      globalIndex++
    }
  }

  const groupUids = makeGroupUidGenerator(spec.seed)
  let studyOrdinal = 0
  for (const study of studies) {
    const copies = study.count ?? 1
    for (let copy = 0; copy < copies; copy++) {
      const studyUid = groupUids.study(studyOrdinal)
      for (const [seriesIndex, series] of study.series.entries()) {
        const seriesUid = groupUids.series(studyOrdinal, seriesIndex)
        let instanceNumber = 0
        for (const entry of series.entries) {
          const { count = 1, ...fileSpec } = entry
          for (let i = 0; i < count; i++) {
            instanceNumber++
            const tags: DicomTagOverrides = {
              InstanceNumber: instanceNumber,
              ...study.tags,
              ...series.tags,
              ...fileSpec.tags,
            }
            const file = await generateFile(
              { ...fileSpec, tags },
              {
                index: globalIndex,
                seed: spec.seed,
                padWidth,
                uid: { study: studyUid, series: seriesUid },
              },
            )
            yield decorate(
              hierarchical
                ? {
                    ...file,
                    ...hierarchicalName(
                      studyOrdinal,
                      seriesIndex,
                      instanceNumber,
                    ),
                  }
                : file,
            )
            globalIndex++
          }
        }
      }
      studyOrdinal++
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
  const createdDirs = new Set<string>([root])
  for await (const file of generateCollectionFromSpec(spec)) {
    const filePath = resolve(root, file.relativePath)
    const dir = dirname(filePath)
    if (!createdDirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      createdDirs.add(dir)
    }
    await writeFile(filePath, file.buffer)
    manifest.push({ path: filePath, type: file.type, index: file.index })
  }
  return manifest
}
