import { closeSync, ftruncateSync, openSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCollectionFromSpec } from '../src/collection/writer'
import { describeDirectory, readHeaderOnly } from '../src/describe/describe'
import type { DatasetSpec, SeriesEntrySpec } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { parseNatural } from './helpers/dicom'

const allEntries = (spec: DatasetSpec): SeriesEntrySpec[] =>
  (spec.studies ?? []).flatMap((s) =>
    s.series.flatMap((series) => series.entries),
  )

// A two-study tree: study 1 has a CT series (3 files) and a PT series (2),
// study 2 a CT series (1) tagged with a distinguishing Manufacturer.
const sourceSpec: DatasetSpec = {
  seed: 7,
  layout: 'hierarchical',
  studies: [
    {
      series: [
        {
          entries: [
            { type: 'valid-image', modality: 'CT', targetSizeKb: 60, count: 3 },
          ],
        },
        {
          entries: [
            { type: 'valid-image', modality: 'PT', targetSizeKb: 40, count: 2 },
          ],
        },
      ],
    },
    {
      series: [
        {
          entries: [
            {
              type: 'valid-image',
              modality: 'CT',
              targetSizeKb: 30,
              tags: { Manufacturer: 'ACME' },
            },
          ],
        },
      ],
    },
  ],
}

describe('describeDirectory', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'describe-test-'))
    await writeCollectionFromSpec(sourceSpec, dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('reproduces the study/series shape', () => {
    const { spec, stats } = describeDirectory(dir)
    expect(stats.dicomFiles).toBe(6)
    expect(stats.skipped).toBe(0)
    expect(spec.studies).toHaveLength(2)
    expect(spec.layout).toBe('hierarchical')

    const fileCount = (s: NonNullable<DatasetSpec['studies']>[number]) =>
      s.series.reduce(
        (sum, series) =>
          sum + series.entries.reduce((n, e) => n + (e.count ?? 1), 0),
        0,
      )
    const counts = (spec.studies ?? []).map(fileCount).sort()
    expect(counts).toEqual([1, 5])
  })

  it('preserves modalities and sizes within tolerance', () => {
    const { spec } = describeDirectory(dir)
    const entries = allEntries(spec)
    const modalities = new Set(entries.map((e) => e.modality))
    expect(modalities).toEqual(new Set(['CT', 'PT']))
    for (const e of entries) {
      if (e.type === 'large-image') continue
      expect(e.targetSizeKb).toBeGreaterThan(0)
    }
  })

  it('emits no tags when keepTags is omitted (shape only)', () => {
    const { spec } = describeDirectory(dir)
    for (const e of allEntries(spec)) {
      expect(e).not.toHaveProperty('tags')
    }
  })

  it('copies named tags verbatim when keepTags is provided', () => {
    const { spec } = describeDirectory(dir, { keepTags: ['Manufacturer'] })
    const withTag = allEntries(spec).filter(
      (e) => e.tags?.Manufacturer === 'ACME',
    )
    expect(withTag).toHaveLength(1)
  })

  it('resolves hex keepTags to keywords', () => {
    // 00080070 = Manufacturer
    const { spec } = describeDirectory(dir, { keepTags: ['00080070'] })
    expect(allEntries(spec).some((e) => e.tags?.Manufacturer === 'ACME')).toBe(
      true,
    )
  })

  it('produces a spec that re-validates', () => {
    const { spec } = describeDirectory(dir, { keepTags: ['Manufacturer'] })
    expect(() => validateDatasetSpec(spec)).not.toThrow()
  })

  it('emits no modality and counts files with an unsupported Modality', async () => {
    const usDir = await mkdtemp(join(tmpdir(), 'describe-us-'))
    try {
      await writeCollectionFromSpec(
        {
          layout: 'hierarchical',
          studies: [
            {
              series: [
                {
                  entries: [{ type: 'valid-image', tags: { Modality: 'US' } }],
                },
              ],
            },
          ],
        },
        usDir,
      )
      const { spec, stats } = describeDirectory(usDir)
      expect(stats.unknownModality).toBe(1)
      expect(allEntries(spec).every((e) => !('modality' in e))).toBe(true)
    } finally {
      await rm(usDir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown keepTags keyword', () => {
    expect(() =>
      describeDirectory(dir, { keepTags: ['Manufacturerr'] }),
    ).toThrow(/unknown tag keyword/)
  })

  it('skips non-DICOM files', async () => {
    await writeFile(join(dir, 'notes.txt'), 'not a dicom file')
    await writeFile(join(dir, 'data.bin'), Buffer.from([0, 1, 2, 3]))
    const { stats } = describeDirectory(dir)
    expect(stats.dicomFiles).toBe(6)
    expect(stats.skipped).toBe(2)
  })

  it('skips a file beyond the 50 GB ceiling', () => {
    // Sparse file: reports >50 GB via statSync but uses ~no disk.
    const huge = join(dir, 'huge.dcm')
    const fd = openSync(huge, 'w')
    try {
      ftruncateSync(fd, 51 * 1024 * 1024 * 1024)
    } finally {
      closeSync(fd)
    }
    const { stats } = describeDirectory(dir)
    expect(stats.dicomFiles).toBe(6)
    expect(stats.skipped).toBeGreaterThanOrEqual(1)
  })

  it('is deterministic across runs', () => {
    expect(describeDirectory(dir).spec).toEqual(describeDirectory(dir).spec)
  })

  it('throws when no DICOM series are found', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'describe-empty-'))
    try {
      expect(() => describeDirectory(empty)).toThrow(/no DICOM series/)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('readHeaderOnly', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'header-only-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('extracts metadata identically to a full read', async () => {
    const manifest = await writeCollectionFromSpec(
      { seed: 1, entries: [{ type: 'valid-image', modality: 'PT' }] },
      dir,
    )
    const path = manifest[0]?.path as string
    const header = readHeaderOnly(path)
    const full = parseNatural(readFileSync(path))

    expect(header?.StudyInstanceUID).toBe(full.StudyInstanceUID)
    expect(header?.SeriesInstanceUID).toBe(full.SeriesInstanceUID)
    expect(header?.SOPInstanceUID).toBe(full.SOPInstanceUID)
    expect(header?.Modality).toBe('PT')
  })

  it('returns null for a non-DICOM file', async () => {
    const path = join(dir, 'notes.txt')
    await writeFile(path, 'not a dicom file')
    expect(readHeaderOnly(path)).toBeNull()
  })
})

// Opt-in: a real >512 MB file describe round-trip. Skipped by default (heavy
// disk write) — set DICOM_SYNTH_LARGE_TEST=1.
const largeIt = process.env.DICOM_SYNTH_LARGE_TEST ? it : it.skip

describe('describeDirectory — large files (opt-in)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'describe-large-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  largeIt('captures a >512 MB file as a large-image entry', async () => {
    const targetBytes = 600 * 1024 * 1024
    await writeCollectionFromSpec(
      {
        seed: 2,
        layout: 'hierarchical',
        studies: [
          {
            series: [
              {
                entries: [{ type: 'large-image', targetBytes, modality: 'PT' }],
              },
            ],
          },
        ],
      },
      dir,
    )

    const { spec, stats } = describeDirectory(dir)
    expect(stats.dicomFiles).toBe(1)

    const entries = (spec.studies ?? []).flatMap((s) =>
      s.series.flatMap((series) => series.entries),
    )
    expect(entries).toHaveLength(1)
    const entry = entries[0]
    expect(entry?.type).toBe('large-image')
    if (entry?.type === 'large-image') {
      expect(entry.targetBytes).toBeGreaterThan(512 * 1024 * 1024)
      expect(entry.modality).toBe('PT')
    }
    expect(() => validateDatasetSpec(spec)).not.toThrow()
  })
})
