import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MAX_STREAM_BYTES } from '../schema/limits.js'
import type {
  DatasetSpec,
  DicomTagOverrides,
  EntrySpec,
  FileSpec,
  PathQuirk,
  StudySpec,
} from '../schema/types.js'
import { buildBufferForSpec } from '../syntheticFixtures/generator.js'
import { streamLargeImage } from '../syntheticFixtures/streamWrite.js'
import {
  resolveTagTemplates,
  type TagContext,
} from '../syntheticFixtures/tagTemplate.js'
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

// Resolves a file's UID set from (seed, index) with optional shared study/series
// overrides — the single seam used by both the in-memory and streaming paths.
function resolveUid(
  seed: number | undefined,
  index: number,
  override?: Partial<UidSet>,
): UidSet {
  return { ...makeUidGenerator(seed)(index), ...override }
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
    // Resolves placeholder tokens in tag values; index defaults to options.index.
    context?: Partial<TagContext>
  },
): Promise<GeneratedFile> {
  const index = options?.index ?? 0
  const padWidth = options?.padWidth ?? 3
  const uid = resolveUid(options?.seed, index, options?.uid)

  const resolvedSpec =
    'tags' in spec && spec.tags
      ? {
          ...spec,
          tags: resolveTagTemplates(spec.tags, { index, ...options?.context }),
        }
      : spec

  let buffer = buildBufferForSpec(resolvedSpec, uid)

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

// Fills in a drawn seed when the spec has none, so the run is reproducible and
// the seed can be captured (mirrors resolveParametricSpec's seed embedding).
// Generate from the returned spec, then persist it to re-create the dataset.
export function withResolvedSeed(spec: DatasetSpec): DatasetSpec {
  return spec.seed === undefined
    ? { ...spec, seed: randomBytes(4).readUInt32BE(0) }
    : spec
}

// A single file's identity within a collection, resolved (final names, UID
// overrides, merged tags) but not yet materialised — so the disk writer can
// stream large-image entries while the in-memory path builds buffers.
type FilePlan = {
  fileSpec: FileSpec
  index: number
  uidOverride?: Partial<UidSet>
  // Per-file context for resolving tag-value placeholders. Flat entries carry
  // only index; grouped entries also carry study/series/instance positions.
  context: TagContext
  filename: string
  relativePath: string
}

function computeNames(
  type: FileSpec['type'],
  index: number,
  padWidth: number,
  grouped:
    | { studyOrdinal: number; seriesIndex: number; instanceNumber: number }
    | undefined,
  quirks: PathQuirk[],
): { filename: string; relativePath: string } {
  let names: { filename: string; relativePath: string }
  if (grouped) {
    names = hierarchicalName(
      grouped.studyOrdinal,
      grouped.seriesIndex,
      grouped.instanceNumber,
    )
  } else {
    const name = filename(type, index, padWidth)
    names = { filename: name, relativePath: name }
  }
  return quirks.length === 0
    ? names
    : applyPathQuirks(names.relativePath, quirks)
}

// Walks the spec into per-file plans (no I/O, no buffers). Flat entries keep
// their own UIDs; grouped studies share a StudyInstanceUID per study copy and a
// SeriesInstanceUID per series; user-supplied tags still win.
function* planCollection(spec: DatasetSpec): Generator<FilePlan> {
  const flatEntries = spec.entries ?? []
  const studies = spec.studies ?? []
  const totalFiles = entryCount(flatEntries) + studyFileCount(studies)
  const padWidth = String(totalFiles).length
  const hierarchical = spec.layout === 'hierarchical'
  const quirks = spec.pathQuirks ?? []

  let globalIndex = 0

  for (const entry of flatEntries) {
    const { count = 1, ...fileSpec } = entry as FileSpec & { count?: number }
    for (let i = 0; i < count; i++) {
      yield {
        fileSpec: fileSpec as FileSpec,
        index: globalIndex,
        context: { index: globalIndex },
        ...computeNames(
          fileSpec.type,
          globalIndex,
          padWidth,
          undefined,
          quirks,
        ),
      }
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
            yield {
              fileSpec: { ...fileSpec, tags } as FileSpec,
              index: globalIndex,
              uidOverride: { study: studyUid, series: seriesUid },
              context: {
                index: globalIndex,
                studyIndex: studyOrdinal,
                seriesIndex,
                instanceNumber,
              },
              ...computeNames(
                fileSpec.type,
                globalIndex,
                padWidth,
                hierarchical
                  ? { studyOrdinal, seriesIndex, instanceNumber }
                  : undefined,
                quirks,
              ),
            }
            globalIndex++
          }
        }
      }
      studyOrdinal++
    }
  }
}

async function materialisePlan(
  plan: FilePlan,
  seed: number | undefined,
): Promise<GeneratedFile> {
  const file = await generateFile(plan.fileSpec, {
    index: plan.index,
    seed,
    uid: plan.uidOverride,
    context: plan.context,
  })
  return { ...file, filename: plan.filename, relativePath: plan.relativePath }
}

// Layer 2 — collection stream, no I/O. In-memory only: large-image entries are
// disk-only and throw here (via the generator), as they cannot be buffers.
export async function* generateCollectionFromSpec(
  spec: DatasetSpec,
): AsyncGenerator<GeneratedFile> {
  for (const plan of planCollection(spec)) {
    yield await materialisePlan(plan, spec.seed)
  }
}

export type CollectionPreviewItem = {
  relativePath: string
  type: FileSpec['type']
  index: number
  // Exact for buffered entries; targetBytes (approximate) for large-image.
  approxBytes: number
}

// Manifest preview for --dry-run: enumerates every file without writing. Large
// entries report their targetBytes instead of being materialised (they cannot
// be buffers), so a spec containing large-image can still be previewed.
export async function* previewCollection(
  spec: DatasetSpec,
): AsyncGenerator<CollectionPreviewItem> {
  for (const plan of planCollection(spec)) {
    if (plan.fileSpec.type === 'large-image') {
      yield {
        relativePath: plan.relativePath,
        type: 'large-image',
        index: plan.index,
        approxBytes: plan.fileSpec.targetBytes,
      }
    } else {
      const file = await materialisePlan(plan, spec.seed)
      yield {
        relativePath: plan.relativePath,
        type: plan.fileSpec.type,
        index: plan.index,
        approxBytes: file.buffer.length,
      }
    }
  }
}

// Layer 3 — disk writer. Normal entries are buffered then written; large-image
// entries are streamed straight to disk (never held in memory).
export async function writeCollectionFromSpec(
  spec: DatasetSpec,
  outDir: string,
): Promise<CollectionManifest> {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })

  const manifest: CollectionManifest = []
  const createdDirs = new Set<string>([root])
  const ensureDir = (filePath: string) => {
    const dir = dirname(filePath)
    if (!createdDirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      createdDirs.add(dir)
    }
  }

  for (const plan of planCollection(spec)) {
    const filePath = resolve(root, plan.relativePath)
    ensureDir(filePath)

    if (plan.fileSpec.type === 'large-image') {
      const large = plan.fileSpec
      // Guard the one disk path that can silently consume huge space even on an
      // unvalidated spec (streamLargeImage itself enforces no policy bounds).
      if (large.targetBytes > MAX_STREAM_BYTES) {
        throw new Error(
          `large-image targetBytes (${large.targetBytes}) exceeds the 50 GB limit`,
        )
      }
      const uid = resolveUid(spec.seed, plan.index, plan.uidOverride)
      streamLargeImage(filePath, {
        targetBytes: large.targetBytes,
        modality: large.modality,
        uid,
        tags: resolveTagTemplates(large.tags, plan.context),
      })
    } else {
      const file = await materialisePlan(plan, spec.seed)
      await writeFile(filePath, file.buffer)
    }
    manifest.push({
      path: filePath,
      type: plan.fileSpec.type,
      index: plan.index,
    })
  }
  return manifest
}
