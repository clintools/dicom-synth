import { randomBytes } from 'node:crypto'
import {
  PARAMETRIC_STREAM_OFFSET,
  seededStream,
} from '../syntheticFixtures/uid.js'
import type {
  DatasetSpec,
  EntrySpec,
  ParametricSpec,
  Range,
  SeriesEntrySpec,
  SeriesSpec,
  StudySpec,
} from './types.js'
import { validateParametricSpec } from './validate.js'

function sample(next: () => number, range: Range): number {
  if (typeof range === 'number') return range
  return range.min + (next() % (range.max - range.min + 1))
}

const BYTES_PER_MB = 1024 * 1024

// Samples a byte range at MB granularity. Byte spans (up to ~50 GB) exceed the
// 32-bit draw, which a plain modulo would silently truncate; bucketing by MB
// keeps the span within 32 bits so the full range is reachable.
function sampleBytes(next: () => number, range: Range): number {
  if (typeof range === 'number') return range
  const spanMb = Math.floor((range.max - range.min) / BYTES_PER_MB) + 1
  return range.min + (next() % spanMb) * BYTES_PER_MB
}

function pick<T>(next: () => number, items: T[]): T {
  return items[next() % items.length] as T
}

// Uniform draw in [0, 1).
function fraction(next: () => number): number {
  return next() / 0x100000000
}

// Resolves a range-based ParametricSpec into a concrete DatasetSpec — pure and
// deterministic for a given seed. The seed (drawn randomly when omitted) is
// embedded in the output, so the resolved spec is saveable and re-runnable.
export function resolveParametricSpec(spec: ParametricSpec): DatasetSpec {
  const validated = validateParametricSpec(spec)
  const seed = validated.seed ?? randomBytes(4).readUInt32BE(0)
  const next = seededStream(seed, PARAMETRIC_STREAM_OFFSET, 0, 0)
  const params = validated.studies

  const studies: StudySpec[] = []
  let totalFiles = 0

  const studyCount = sample(next, params.count)
  for (let st = 0; st < studyCount; st++) {
    const seriesCount = sample(next, params.seriesPerStudy)
    const series: SeriesSpec[] = []
    for (let se = 0; se < seriesCount; se++) {
      const fileCount = sample(next, params.filesPerSeries)
      totalFiles += fileCount
      const modality = params.modalities
        ? pick(next, params.modalities)
        : undefined

      const base: SeriesEntrySpec = {
        type: 'valid-image',
        ...(modality !== undefined ? { modality } : {}),
      }
      const entries: SeriesEntrySpec[] = []
      if (
        params.fileSizeKb !== undefined &&
        typeof params.fileSizeKb !== 'number'
      ) {
        // Range: sample per file so sizes vary within the series.
        for (let f = 0; f < fileCount; f++) {
          entries.push({
            ...base,
            targetSizeKb: sample(next, params.fileSizeKb),
          })
        }
      } else {
        entries.push({
          ...base,
          ...(params.fileSizeKb !== undefined
            ? { targetSizeKb: params.fileSizeKb }
            : {}),
          ...(fileCount > 1 ? { count: fileCount } : {}),
        })
      }

      // Disk-only large-image members, sharing the series modality. Only draws
      // when configured, so specs without it resolve identically as before.
      if (
        params.largeFilesPerSeries !== undefined &&
        params.largeFileBytes !== undefined
      ) {
        const largeCount = sample(next, params.largeFilesPerSeries)
        const largeBase: SeriesEntrySpec = {
          type: 'large-image',
          targetBytes: 0,
          ...(modality !== undefined ? { modality } : {}),
        }
        if (typeof params.largeFileBytes === 'number') {
          // Fixed size: one counted entry.
          if (largeCount > 0) {
            entries.push({
              ...largeBase,
              targetBytes: params.largeFileBytes,
              ...(largeCount > 1 ? { count: largeCount } : {}),
            })
          }
        } else {
          // Range: sample per file so sizes vary within the series.
          for (let lf = 0; lf < largeCount; lf++) {
            entries.push({
              ...largeBase,
              targetBytes: sampleBytes(next, params.largeFileBytes),
            })
          }
        }
      }

      series.push({ entries })
    }
    studies.push({
      series,
      ...(params.tags !== undefined ? { tags: params.tags } : {}),
    })
  }

  const entries: EntrySpec[] = []
  for (const edgeCase of validated.edgeCases ?? []) {
    const { frequency, ...entry } = edgeCase
    if (frequency === undefined) {
      entries.push(entry)
      continue
    }
    // Per-file draw. Resolved spec records the actual count.
    let drawn = 0
    for (let i = 0; i < totalFiles; i++) {
      if (fraction(next) < frequency) drawn++
    }
    if (drawn > 0) entries.push({ ...entry, count: drawn })
  }

  return {
    ...(entries.length > 0 ? { entries } : {}),
    studies,
    seed,
    ...(validated.layout !== undefined ? { layout: validated.layout } : {}),
  }
}
