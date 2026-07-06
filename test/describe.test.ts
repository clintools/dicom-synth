import {
  closeSync,
  ftruncateSync,
  openSync,
  readdirSync,
  readFileSync,
} from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeCollectionFromSpec } from '../src/collection/writer'
import { describeDirectory, readHeaderOnly } from '../src/describe/describe'
import type { DatasetSpec, SeriesEntrySpec } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { parseNatural } from './helpers/dicom'

const allEntries = (spec: DatasetSpec): SeriesEntrySpec[] =>
  (spec.studies ?? []).flatMap((s) =>
    s.series.flatMap((series) => series.entries ?? []),
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
    const { spec, stats } = describeDirectory(dir, { preserveUids: false })
    expect(stats.dicomFiles).toBe(6)
    expect(stats.skipped).toBe(0)
    expect(spec.studies).toHaveLength(2)
    expect(spec.layout).toBe('hierarchical')

    const fileCount = (s: NonNullable<DatasetSpec['studies']>[number]) =>
      s.series.reduce(
        (sum, series) =>
          sum + (series.entries ?? []).reduce((n, e) => n + (e.count ?? 1), 0),
        0,
      )
    const counts = (spec.studies ?? []).map(fileCount).sort()
    expect(counts).toEqual([1, 5])
  })

  it('preserves modalities and sizes within tolerance', () => {
    const { spec } = describeDirectory(dir, { preserveUids: false })
    const entries = allEntries(spec)
    const modalities = new Set(entries.map((e) => e.modality))
    expect(modalities).toEqual(new Set(['CT', 'PT']))
    for (const e of entries) {
      if (e.type === 'large-image') continue
      expect(e.targetSizeKb).toBeGreaterThan(0)
    }
  })

  it('emits no tags with preserveUids off and keepTags omitted (shape only)', () => {
    const { spec } = describeDirectory(dir, { preserveUids: false })
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

  it('drops preset-modality and UID-VR tags from keepTags', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { spec } = describeDirectory(dir, {
        preserveUids: false,
        keepTags: ['Manufacturer', 'Modality', 'SOPInstanceUID'],
      })
      // Manufacturer survives; preset Modality (CT/PT here) and the UID tag are
      // filtered out.
      expect(
        allEntries(spec).some((e) => e.tags?.Manufacturer === 'ACME'),
      ).toBe(true)
      for (const e of allEntries(spec)) {
        expect(e.tags ?? {}).not.toHaveProperty('Modality')
        expect(e.tags ?? {}).not.toHaveProperty('SOPInstanceUID')
      }
      // Only the UID tag warns (preset Modality is skipped silently per file).
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('keeps a non-preset Modality verbatim so it round-trips', async () => {
    const usDir = await mkdtemp(join(tmpdir(), 'describe-us-keep-'))
    const outDir = await mkdtemp(join(tmpdir(), 'describe-us-out-'))
    try {
      await writeCollectionFromSpec(
        {
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
      const { spec } = describeDirectory(usDir, { keepTags: ['Modality'] })
      expect(allEntries(spec).every((e) => e.tags?.Modality === 'US')).toBe(
        true,
      )
      expect(() => validateDatasetSpec(spec)).not.toThrow()
      const manifest = await writeCollectionFromSpec(spec, outDir)
      const regenerated = parseNatural(
        readFileSync(manifest[0]?.path as string),
      )
      expect(regenerated.Modality).toBe('US')
    } finally {
      await rm(usDir, { recursive: true, force: true })
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('produces a spec that re-validates', () => {
    const { spec } = describeDirectory(dir, { keepTags: ['Manufacturer'] })
    expect(() => validateDatasetSpec(spec)).not.toThrow()
  })

  it('captures a varying kept tag as a correlated instances form', async () => {
    const srcDir = await mkdtemp(join(tmpdir(), 'describe-inst-'))
    const outDir = await mkdtemp(join(tmpdir(), 'describe-inst-out-'))
    try {
      // Source series where PatientID varies per file.
      await writeCollectionFromSpec(
        {
          seed: 5,
          layout: 'hierarchical',
          studies: [
            {
              series: [
                {
                  instances: {
                    count: 3,
                    targetSizeKb: [10, 20, 30],
                    tags: { PatientID: ['A', 'B', 'C'] },
                  },
                },
              ],
            },
          ],
        },
        srcDir,
      )
      const { spec } = describeDirectory(srcDir, { keepTags: ['PatientID'] })
      const series = spec.studies?.[0]?.series[0]
      // Varying tag → instances form (not entries).
      expect(series?.entries).toBeUndefined()
      expect(series?.instances?.tags?.PatientID).toEqual(['A', 'B', 'C'])
      expect(() => validateDatasetSpec(spec)).not.toThrow()
      // Round-trip preserves each file's value in order.
      const manifest = await writeCollectionFromSpec(spec, outDir)
      const ids = manifest.map(
        (m) => parseNatural(readFileSync(m.path)).PatientID,
      )
      expect(ids).toEqual(['A', 'B', 'C'])
    } finally {
      await rm(srcDir, { recursive: true, force: true })
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('hoists a constant tag to series.tags and arrays only the varying one', async () => {
    const srcDir = await mkdtemp(join(tmpdir(), 'describe-part-'))
    try {
      await writeCollectionFromSpec(
        {
          seed: 6,
          layout: 'hierarchical',
          studies: [
            {
              series: [
                {
                  // ImageType (array) is constant across the series; PatientID varies.
                  tags: { ImageType: ['ORIGINAL', 'PRIMARY'] },
                  instances: {
                    count: 3,
                    targetSizeKb: [10, 10, 10],
                    tags: { PatientID: ['A', 'B', 'C'] },
                  },
                },
              ],
            },
          ],
        },
        srcDir,
      )
      const { spec } = describeDirectory(srcDir, {
        keepTags: ['PatientID', 'ImageType'],
      })
      const series = spec.studies?.[0]?.series[0]
      // Varying scalar → per-instance array; constant tag → shared (hoisted to
      // series.tags, not duplicated per instance).
      expect(series?.instances?.tags?.PatientID).toEqual(['A', 'B', 'C'])
      expect(series?.instances?.tags?.ImageType).toBeUndefined()
      expect(series?.tags?.ImageType).toBeDefined()
      expect(() => validateDatasetSpec(spec)).not.toThrow()
    } finally {
      await rm(srcDir, { recursive: true, force: true })
    }
  })

  it('falls back to entries form when a kept tag is present in only some files', async () => {
    const srcDir = await mkdtemp(join(tmpdir(), 'describe-mixed-'))
    try {
      await writeCollectionFromSpec(
        {
          studies: [
            {
              series: [
                {
                  // Manufacturer is set on one file only (it is not a generator default).
                  entries: [
                    { type: 'valid-image', tags: { Manufacturer: 'ACME' } },
                    { type: 'valid-image' },
                  ],
                },
              ],
            },
          ],
        },
        srcDir,
      )
      const { spec } = describeDirectory(srcDir, { keepTags: ['Manufacturer'] })
      const series = spec.studies?.[0]?.series[0]
      expect(series?.instances).toBeUndefined()
      expect(series?.entries).toBeDefined()
    } finally {
      await rm(srcDir, { recursive: true, force: true })
    }
  })

  it('falls back to entries form when modality varies within a series', async () => {
    const srcDir = await mkdtemp(join(tmpdir(), 'describe-multimod-'))
    try {
      await writeCollectionFromSpec(
        {
          studies: [
            {
              series: [
                {
                  // Same series, differing modality, with a varying kept tag.
                  entries: [
                    {
                      type: 'valid-image',
                      modality: 'CT',
                      tags: { Manufacturer: 'A' },
                    },
                    {
                      type: 'valid-image',
                      modality: 'PT',
                      tags: { Manufacturer: 'B' },
                    },
                  ],
                },
              ],
            },
          ],
        },
        srcDir,
      )
      const { spec } = describeDirectory(srcDir, { keepTags: ['Manufacturer'] })
      const series = spec.studies?.[0]?.series[0]
      expect(series?.instances).toBeUndefined()
      expect(series?.entries).toBeDefined()
    } finally {
      await rm(srcDir, { recursive: true, force: true })
    }
  })

  it('folds near-identical sizes with sizeTolerance', async () => {
    const sizeDir = await mkdtemp(join(tmpdir(), 'describe-tol-'))
    try {
      // One series, three slices ~1 KB apart (within ~2%).
      await writeCollectionFromSpec(
        {
          seed: 4,
          studies: [
            {
              series: [
                {
                  entries: [
                    { type: 'valid-image', targetSizeKb: 100 },
                    { type: 'valid-image', targetSizeKb: 101 },
                    { type: 'valid-image', targetSizeKb: 102 },
                  ],
                },
              ],
            },
          ],
        },
        sizeDir,
      )
      // Exact (default) keeps the three distinct sizes as separate entries.
      // preserveUids off so the size axis is tested in isolation (varying UIDs
      // would otherwise force the instances form).
      const exact = allEntries(
        describeDirectory(sizeDir, { preserveUids: false }).spec,
      )
      expect(exact.length).toBeGreaterThan(1)
      // A 10% tolerance folds them into one counted entry.
      const folded = allEntries(
        describeDirectory(sizeDir, { preserveUids: false, sizeTolerance: 0.1 })
          .spec,
      )
      expect(folded).toHaveLength(1)
      expect(folded[0]?.count).toBe(3)
    } finally {
      await rm(sizeDir, { recursive: true, force: true })
    }
  })

  it('rejects a negative sizeTolerance', () => {
    expect(() => describeDirectory(dir, { sizeTolerance: -1 })).toThrow(
      /sizeTolerance/,
    )
  })

  it('keeps a constant kept tag in the compact entries form', () => {
    // study 2's single CT file has Manufacturer 'ACME' (constant) — entries form.
    // preserveUids off: varying per-file UIDs would otherwise drive the
    // instances form regardless of the kept tag.
    const { spec } = describeDirectory(dir, {
      preserveUids: false,
      keepTags: ['Manufacturer'],
    })
    for (const s of spec.studies ?? []) {
      for (const series of s.series) {
        expect(series.instances).toBeUndefined()
      }
    }
  })

  it('round-trips a kept tag value containing braces verbatim', async () => {
    const braceDir = await mkdtemp(join(tmpdir(), 'describe-brace-'))
    const outDir = await mkdtemp(join(tmpdir(), 'describe-brace-out-'))
    try {
      // 'AC{{ME}}' generates a file whose Manufacturer is the literal 'AC{ME}'.
      await writeCollectionFromSpec(
        {
          studies: [
            {
              series: [
                {
                  entries: [
                    {
                      type: 'valid-image',
                      tags: { Manufacturer: 'AC{{ME}}' },
                    },
                  ],
                },
              ],
            },
          ],
        },
        braceDir,
      )
      const { spec } = describeDirectory(braceDir, {
        keepTags: ['Manufacturer'],
      })
      // Re-validation must not choke on the literal braces.
      expect(() => validateDatasetSpec(spec)).not.toThrow()
      // Regenerating reproduces the literal value, not a substituted token.
      const manifest = await writeCollectionFromSpec(spec, outDir)
      const regenerated = parseNatural(
        readFileSync(manifest[0]?.path as string),
      )
      expect(regenerated.Manufacturer).toBe('AC{ME}')
    } finally {
      await rm(braceDir, { recursive: true, force: true })
      await rm(outDir, { recursive: true, force: true })
    }
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

describe('describeDirectory — preserveUids (hash-derived links)', () => {
  // Source: one study, one series, two instances sharing a FrameOfReferenceUID
  // (a numeric UID so dcmjs preserves it). Each file mints its own SOPInstanceUID.
  const linkedSpec: DatasetSpec = {
    seed: 11,
    layout: 'hierarchical',
    studies: [
      {
        series: [
          {
            tags: { FrameOfReferenceUID: '2.25.98765432109876543210987654321' },
            entries: [{ type: 'valid-image', modality: 'CT', count: 2 }],
          },
        ],
      },
    ],
  }

  let srcDir: string

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'describe-uids-'))
    await writeCollectionFromSpec(linkedSpec, srcDir)
  })

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true })
  })

  // Every UID value present in the source tree, so we can assert none leak.
  const sourceUids = (dir: string): Set<string> => {
    const uidKeywords = [
      'StudyInstanceUID',
      'SeriesInstanceUID',
      'SOPInstanceUID',
      'FrameOfReferenceUID',
    ]
    const uids = new Set<string>()
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name)
        if (entry.isDirectory()) {
          walk(p)
        } else {
          const record = parseNatural(readFileSync(p))
          for (const k of uidKeywords) {
            const v = record[k]
            if (typeof v === 'string') uids.add(v)
          }
        }
      }
    }
    walk(dir)
    return uids
  }

  it('preserves a shared FrameOfReferenceUID across regenerated files', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'describe-uids-out-'))
    try {
      const originals = sourceUids(srcDir)
      const { spec } = describeDirectory(srcDir, {
        preserveUids: true,
        uidSalt: 'cafef00d',
      })
      expect(() => validateDatasetSpec(spec)).not.toThrow()

      const manifest = await writeCollectionFromSpec(spec, outDir)
      const records = manifest.map((m) => parseNatural(readFileSync(m.path)))
      expect(records).toHaveLength(2)

      // The link survives: both regenerated files share one FrameOfReferenceUID.
      const fors = new Set(records.map((r) => r.FrameOfReferenceUID))
      expect(fors.size).toBe(1)
      // Distinct SOPInstanceUIDs (per file), one shared SeriesInstanceUID.
      const sops = new Set(records.map((r) => r.SOPInstanceUID))
      expect(sops.size).toBe(2)
      expect(new Set(records.map((r) => r.SeriesInstanceUID)).size).toBe(1)
      expect(new Set(records.map((r) => r.StudyInstanceUID)).size).toBe(1)

      // The synthetic UIDs are hash-derived, not the originals.
      const [forUid] = fors
      expect(originals.has(forUid as string)).toBe(false)
    } finally {
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('emits no original UID anywhere in the spec', () => {
    const originals = sourceUids(srcDir)
    const { spec } = describeDirectory(srcDir, {
      preserveUids: true,
      uidSalt: 'cafef00d',
    })
    const json = JSON.stringify(spec)
    for (const uid of originals) {
      expect(json).not.toContain(uid)
    }
    // The salt is recorded so the run is reproducible.
    expect(spec.uidSalt).toBe('cafef00d')
  })

  it('is reproducible with the same salt and disjoint with a different one', () => {
    const a = describeDirectory(srcDir, {
      preserveUids: true,
      uidSalt: 'aaaa1111',
    }).spec
    const b = describeDirectory(srcDir, {
      preserveUids: true,
      uidSalt: 'aaaa1111',
    }).spec
    expect(a).toEqual(b)

    const c = describeDirectory(srcDir, {
      preserveUids: true,
      uidSalt: 'bbbb2222',
    }).spec
    // Different salt → different UID namespace; nothing shared but the shape.
    const uidsOf = (s: DatasetSpec): Set<string> => {
      const found = new Set<string>()
      const scan = (v: unknown): void => {
        if (typeof v === 'string') {
          if (v.startsWith('2.25.')) found.add(v)
        } else if (Array.isArray(v)) {
          for (const x of v) scan(x)
        } else if (v && typeof v === 'object') {
          for (const x of Object.values(v)) scan(x)
        }
      }
      scan(s.studies)
      return found
    }
    const setA = uidsOf(a)
    const setC = uidsOf(c)
    expect(setA.size).toBeGreaterThan(0)
    for (const uid of setC) expect(setA.has(uid)).toBe(false)
  })

  it('round-trips a single-file series (entries form) with hashed group UIDs', async () => {
    const oneDir = await mkdtemp(join(tmpdir(), 'describe-uids-one-'))
    const outDir = await mkdtemp(join(tmpdir(), 'describe-uids-one-out-'))
    try {
      // One study, one series, one file — takes the entries form, so the hashed
      // SeriesInstanceUID rides series.tags (not the instances form).
      await writeCollectionFromSpec(
        {
          seed: 12,
          layout: 'hierarchical',
          studies: [
            {
              series: [{ entries: [{ type: 'valid-image', modality: 'CT' }] }],
            },
          ],
        },
        oneDir,
      )
      const originals = sourceUids(oneDir)
      const { spec } = describeDirectory(oneDir, {
        preserveUids: true,
        uidSalt: 'cafef00d',
      })
      const series = spec.studies?.[0]?.series[0]
      // Entries form (single file), with the hashed SeriesInstanceUID hoisted to
      // series.tags.
      expect(series?.entries).toBeDefined()
      expect(series?.instances).toBeUndefined()
      expect(typeof series?.tags?.SeriesInstanceUID).toBe('string')
      expect(() => validateDatasetSpec(spec)).not.toThrow()

      // Regeneration applies the hashed group/instance UIDs, and no original leaks.
      const manifest = await writeCollectionFromSpec(spec, outDir)
      const record = parseNatural(readFileSync(manifest[0]?.path as string))
      for (const k of [
        'StudyInstanceUID',
        'SeriesInstanceUID',
        'SOPInstanceUID',
      ]) {
        expect(originals.has(record[k] as string)).toBe(false)
      }
      expect(JSON.stringify(spec)).not.toContain([...originals][0] as string)
    } finally {
      await rm(oneDir, { recursive: true, force: true })
      await rm(outDir, { recursive: true, force: true })
    }
  })

  it('preserves UIDs by default (no options)', () => {
    const originals = sourceUids(srcDir)
    const { spec } = describeDirectory(srcDir)
    expect(typeof spec.uidSalt).toBe('string')
    const json = JSON.stringify(spec)
    for (const uid of originals) expect(json).not.toContain(uid)
  })

  it('derives a reproducible salt from the dataset when none is given', () => {
    const a = describeDirectory(srcDir).spec
    const b = describeDirectory(srcDir).spec
    // Same tree → same derived salt → identical spec.
    expect(typeof a.uidSalt).toBe('string')
    expect(a).toEqual(b)
  })

  it('derives disjoint salts for different datasets', async () => {
    const otherDir = await mkdtemp(join(tmpdir(), 'describe-uids-other-'))
    try {
      // A structurally identical tree but a different seed → different real
      // study UIDs → different derived salt.
      await writeCollectionFromSpec({ ...linkedSpec, seed: 99 }, otherDir)
      const a = describeDirectory(srcDir).spec
      const b = describeDirectory(otherDir).spec
      expect(a.uidSalt).not.toBe(b.uidSalt)
    } finally {
      await rm(otherDir, { recursive: true, force: true })
    }
  })

  it('emits shape only with freshly minted UIDs when preserveUids is off', () => {
    const { spec } = describeDirectory(srcDir, { preserveUids: false })
    expect(spec.uidSalt).toBeUndefined()
    const json = JSON.stringify(spec)
    expect(json).not.toContain('FrameOfReferenceUID')
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
