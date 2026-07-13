import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { GeneratedFile } from '../src/collection/writer'
import {
  generateCollectionFromSpec,
  generateFile,
  withResolvedSeed,
  writeCollectionFromSpec,
} from '../src/collection/writer'
import type { DatasetSpec } from '../src/schema/types'
import { applyViolations } from '../src/syntheticFixtures/violations'
import { parseNatural } from './helpers/dicom'

async function collect(spec: DatasetSpec): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = []
  for await (const f of generateCollectionFromSpec(spec)) {
    files.push(f)
  }
  return files
}

describe('generateFile — layer 1', () => {
  it('returns index 0 when no opts supplied', async () => {
    const { index } = await generateFile({ type: 'valid-image' })
    expect(index).toBe(0)
  })

  it('honours explicit index', async () => {
    const { index } = await generateFile({ type: 'valid-image' }, { index: 7 })
    expect(index).toBe(7)
  })

  it('same seed + index → identical buffers across calls', async () => {
    const a = (
      await generateFile({ type: 'valid-image' }, { seed: 1, index: 0 })
    ).buffer
    const b = (
      await generateFile({ type: 'valid-image' }, { seed: 1, index: 0 })
    ).buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('different seeds → different buffers', async () => {
    const a = (
      await generateFile({ type: 'valid-image' }, { seed: 1, index: 0 })
    ).buffer
    const b = (
      await generateFile({ type: 'valid-image' }, { seed: 2, index: 0 })
    ).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('applies violations when spec includes them', async () => {
    const clean = (await generateFile({ type: 'valid-image' })).buffer
    const violated = applyViolations(clean, ['missing-meta-header'])
    expect(violated.length).toBe(clean.length - 132)
  })
})

describe('generateCollectionFromSpec — layer 2', () => {
  it('yields correct total file count', async () => {
    const files: unknown[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [
        { type: 'valid-image', count: 3 },
        { type: 'fake-signature', count: 2 },
      ],
    })) {
      files.push(f)
    }
    expect(files).toHaveLength(5)
  })

  it('yields unique filenames across the collection', async () => {
    const names: string[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-image', count: 5 }],
    })) {
      names.push(f.filename)
    }
    expect(new Set(names).size).toBe(5)
  })

  it('yields unique buffers for unseeded collections', async () => {
    const buffers: Buffer[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-image', count: 3 }],
    })) {
      buffers.push(f.buffer)
    }
    const [a, b, c] = buffers
    expect(Buffer.compare(a, b)).not.toBe(0)
    expect(Buffer.compare(a, c)).not.toBe(0)
  })

  it('produces deterministic output for a seeded spec', async () => {
    const collect = async () => {
      const bufs: Buffer[] = []
      for await (const f of generateCollectionFromSpec({
        entries: [{ type: 'valid-image', count: 3 }],
        seed: 99,
      })) {
        bufs.push(f.buffer)
      }
      return bufs
    }
    const run1 = await collect()
    const run2 = await collect()
    for (let i = 0; i < run1.length; i++) {
      expect(Buffer.compare(run1[i], run2[i])).toBe(0)
    }
  })

  it('handles entries without explicit count (defaults to 1)', async () => {
    const files: unknown[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-image' }, { type: 'fake-signature' }],
    })) {
      files.push(f)
    }
    expect(files).toHaveLength(2)
  })

  it('zero-pads index width to match total file count', async () => {
    const names: string[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-image', count: 10 }],
    })) {
      names.push(f.filename)
    }
    // 10 files → padWidth 2 → "00" through "09"
    expect(names[0]).toBe('valid-image-00.dcm')
    expect(names[9]).toBe('valid-image-09.dcm')
  })

  it('applies violations to entries that include them', async () => {
    const files: Array<{ buffer: Buffer }> = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-image', violations: ['missing-meta-header'] }],
    })) {
      files.push(f)
    }
    // missing-meta-header strips 132 bytes — buffer must not start with DICM
    expect(files[0].buffer.subarray(0, 4).toString('ascii')).not.toBe('DICM')
  })
})

describe('generateCollectionFromSpec — study/series grouping', () => {
  const groupedSpec: DatasetSpec = {
    studies: [
      {
        series: [
          { entries: [{ type: 'valid-image', count: 3 }] },
          { entries: [{ type: 'valid-image', count: 2 }] },
        ],
      },
      { series: [{ entries: [{ type: 'valid-image' }] }] },
    ],
    seed: 42,
  }

  // Generated once — the assertions below only read from these.
  let files: GeneratedFile[]
  let naturals: Record<string, unknown>[]

  beforeAll(async () => {
    files = await collect(groupedSpec)
    naturals = files.map((f) => parseNatural(f.buffer))
  })

  it('yields the correct total file count', () => {
    expect(files).toHaveLength(6)
  })

  it('files within a study share StudyInstanceUID; studies differ', () => {
    const studyUids = naturals.map((n) => n.StudyInstanceUID as string)
    // first 5 files belong to study 0, last file to study 1
    expect(new Set(studyUids.slice(0, 5)).size).toBe(1)
    expect(studyUids[5]).not.toBe(studyUids[0])
  })

  it('files within a series share SeriesInstanceUID; series differ', () => {
    const seriesUids = naturals.map((n) => n.SeriesInstanceUID as string)
    expect(new Set(seriesUids.slice(0, 3)).size).toBe(1)
    expect(new Set(seriesUids.slice(3, 5)).size).toBe(1)
    expect(seriesUids[3]).not.toBe(seriesUids[0])
  })

  it('InstanceNumber increments from 1 within each series', () => {
    const instanceNumbers = naturals.map((n) => n.InstanceNumber)
    expect(instanceNumbers).toEqual([1, 2, 3, 1, 2, 1])
  })

  it('SOPInstanceUIDs are unique across the whole collection', () => {
    const sops = naturals.map((n) => n.SOPInstanceUID as string)
    expect(new Set(sops).size).toBe(files.length)
  })

  it('seeded grouped collections are byte-identical across runs', async () => {
    const rerun = await collect(groupedSpec)
    for (let i = 0; i < files.length; i++) {
      expect(Buffer.compare(files[i].buffer, rerun[i].buffer)).toBe(0)
    }
  })

  it('unseeded grouped collections still share UIDs within each group', async () => {
    const files = await collect({
      studies: [
        {
          series: [
            { entries: [{ type: 'valid-image', count: 2 }] },
            { entries: [{ type: 'valid-image', count: 2 }] },
          ],
        },
      ],
    })
    const naturals = files.map((f) => parseNatural(f.buffer))
    const studyUids = naturals.map((n) => n.StudyInstanceUID as string)
    const seriesUids = naturals.map((n) => n.SeriesInstanceUID as string)
    expect(new Set(studyUids).size).toBe(1)
    expect(new Set(seriesUids.slice(0, 2)).size).toBe(1)
    expect(new Set(seriesUids.slice(2, 4)).size).toBe(1)
    expect(seriesUids[2]).not.toBe(seriesUids[0])
  })

  it('user tag overrides win over injected group UIDs', async () => {
    const files = await collect({
      studies: [
        {
          series: [
            {
              entries: [
                { type: 'valid-image', tags: { StudyInstanceUID: '2.25.777' } },
              ],
            },
          ],
        },
      ],
      seed: 1,
    })
    expect(parseNatural(files[0].buffer).StudyInstanceUID).toBe('2.25.777')
  })

  it('study count expands to copies with distinct study UIDs', async () => {
    const files = await collect({
      studies: [{ series: [{ entries: [{ type: 'valid-image' }] }], count: 3 }],
      seed: 5,
    })
    expect(files).toHaveLength(3)
    const studyUids = files.map(
      (f) => parseNatural(f.buffer).StudyInstanceUID as string,
    )
    expect(new Set(studyUids).size).toBe(3)
  })

  it('study and series tags merge into each file (entry tags win)', async () => {
    const files = await collect({
      studies: [
        {
          tags: { PatientID: 'STUDY_PID', StudyDescription: 'From study' },
          series: [
            {
              tags: { SeriesDescription: 'From series' },
              entries: [
                { type: 'valid-image', tags: { PatientID: 'ENTRY_PID' } },
              ],
            },
          ],
        },
      ],
      seed: 1,
    })
    const natural = parseNatural(files[0].buffer)
    expect(natural.PatientID).toBe('ENTRY_PID')
    expect(natural.StudyDescription).toBe('From study')
    expect(natural.SeriesDescription).toBe('From series')
  })

  it('modality applies to every file in a grouped series', async () => {
    const files = await collect({
      studies: [
        {
          series: [
            { entries: [{ type: 'valid-image', modality: 'PT', count: 2 }] },
          ],
        },
      ],
      seed: 11,
    })
    const naturals = files.map((f) => parseNatural(f.buffer))
    expect(naturals.map((n) => n.Modality)).toEqual(['PT', 'PT'])
    expect(naturals[0].SeriesInstanceUID).toBe(naturals[1].SeriesInstanceUID)
  })

  it('invalid-uid-image entries in a series share a non-conformant StudyInstanceUID', async () => {
    const files = await collect({
      studies: [
        { series: [{ entries: [{ type: 'invalid-uid-image', count: 2 }] }] },
      ],
      seed: 7,
    })
    // dcmjs normalises non-conformant UIDs on read-back, so check the raw binary.
    const extractInvalidStudyUid = (buf: Buffer): string | null => {
      const binary = buf.toString('binary')
      const start = binary.indexOf('2.25.invalid.study.')
      if (start === -1) return null
      const end = binary.indexOf('\0', start)
      return end === -1 ? binary.slice(start) : binary.slice(start, end)
    }
    const uid0 = extractInvalidStudyUid(files[0].buffer)
    const uid1 = extractInvalidStudyUid(files[1].buffer)
    // Non-conformant transform applied (contains 'invalid')
    expect(uid0).not.toBeNull()
    // Shared within the group
    expect(uid0).toBe(uid1)
  })

  it('mixed entries and studies count toward one pad width', async () => {
    const files = await collect({
      entries: [{ type: 'valid-image', count: 6 }],
      studies: [{ series: [{ entries: [{ type: 'valid-image', count: 6 }] }] }],
    })
    expect(files).toHaveLength(12)
    // 12 files → padWidth 2
    expect(files[0].filename).toBe('valid-image-00.dcm')
  })
})

describe('generateCollectionFromSpec — layout', () => {
  const spec: DatasetSpec = {
    studies: [
      {
        series: [
          { entries: [{ type: 'valid-image', count: 2 }] },
          { entries: [{ type: 'valid-image' }] },
        ],
      },
    ],
    seed: 9,
  }

  it('hierarchical layout produces study/series relative paths', async () => {
    const files = await collect({ ...spec, layout: 'hierarchical' })
    expect(files.map((f) => f.relativePath)).toEqual([
      'study-001/series-001/00001.dcm',
      'study-001/series-001/00002.dcm',
      'study-001/series-002/00001.dcm',
    ])
    expect(files[0].filename).toBe('00001.dcm')
  })

  it('flat layout (default) keeps relativePath equal to filename', async () => {
    const files = await collect(spec)
    for (const f of files) {
      expect(f.relativePath).toBe(f.filename)
      expect(f.relativePath).not.toContain('/')
    }
  })

  it('flat entries keep relativePath equal to filename under hierarchical layout', async () => {
    const files = await collect({
      entries: [{ type: 'valid-image' }],
      layout: 'hierarchical',
    })
    expect(files[0].relativePath).toBe(files[0].filename)
  })
})

describe('writeCollectionFromSpec — layer 3', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'collection-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes the correct number of files', async () => {
    await writeCollectionFromSpec(
      {
        entries: [
          { type: 'valid-image', count: 2 },
          { type: 'fake-signature', count: 1 },
        ],
      },
      tmpDir,
    )
    expect(readdirSync(tmpDir)).toHaveLength(3)
  })

  it('returns a manifest with correct entries', async () => {
    const manifest = await writeCollectionFromSpec(
      {
        entries: [
          { type: 'valid-image', count: 2 },
          { type: 'non-dicom', count: 1 },
        ],
      },
      tmpDir,
    )
    expect(manifest).toHaveLength(3)
    expect(manifest[0].type).toBe('valid-image')
    expect(manifest[2].type).toBe('non-dicom')
    // Flat layout: relativePath is the bare filename, and the absolute path
    // ends with it.
    for (const entry of manifest) {
      expect(entry.relativePath).not.toContain('/')
      expect(entry.path.endsWith(entry.relativePath)).toBe(true)
    }
  })

  it('creates the output directory if it does not exist', async () => {
    const nested = join(tmpDir, 'nested', 'out')
    await writeCollectionFromSpec(
      { entries: [{ type: 'valid-image' }] },
      nested,
    )
    expect(readdirSync(nested)).toHaveLength(1)
  })

  it('writes non-dicom files without .dcm extension', async () => {
    await writeCollectionFromSpec({ entries: [{ type: 'non-dicom' }] }, tmpDir)
    const [name] = readdirSync(tmpDir)
    expect(name).not.toMatch(/\.dcm$/)
  })

  it('writes DICOM files with .dcm extension', async () => {
    await writeCollectionFromSpec(
      { entries: [{ type: 'valid-image' }] },
      tmpDir,
    )
    const [name] = readdirSync(tmpDir)
    expect(name).toMatch(/\.dcm$/)
  })

  it('hierarchical layout writes nested study/series directories', async () => {
    const manifest = await writeCollectionFromSpec(
      {
        studies: [
          {
            series: [
              { entries: [{ type: 'valid-image', count: 2 }] },
              { entries: [{ type: 'valid-image' }] },
            ],
          },
        ],
        layout: 'hierarchical',
        seed: 3,
      },
      tmpDir,
    )
    expect(manifest).toHaveLength(3)
    expect(readdirSync(tmpDir)).toEqual(['study-001'])
    expect(readdirSync(join(tmpDir, 'study-001')).sort()).toEqual([
      'series-001',
      'series-002',
    ])
    expect(readdirSync(join(tmpDir, 'study-001', 'series-001')).sort()).toEqual(
      ['00001.dcm', '00002.dcm'],
    )
    // Manifest relativePath carries the nested layout path.
    expect(manifest.map((m) => m.relativePath).sort()).toEqual([
      join('study-001', 'series-001', '00001.dcm'),
      join('study-001', 'series-001', '00002.dcm'),
      join('study-001', 'series-002', '00001.dcm'),
    ])
  })
})

describe('withResolvedSeed', () => {
  it('draws a numeric seed when none is provided', () => {
    const resolved = withResolvedSeed({ entries: [{ type: 'valid-image' }] })
    expect(typeof resolved.seed).toBe('number')
  })

  it('preserves an existing seed', () => {
    const resolved = withResolvedSeed({
      entries: [{ type: 'valid-image' }],
      seed: 99,
    })
    expect(resolved.seed).toBe(99)
  })

  it('makes a seedless spec reproducible once resolved', async () => {
    const resolved = withResolvedSeed({
      studies: [{ series: [{ entries: [{ type: 'valid-image', count: 3 }] }] }],
    })
    const first = await collect(resolved)
    const second = await collect(resolved)
    expect(second.map((f) => f.buffer.toString('base64'))).toEqual(
      first.map((f) => f.buffer.toString('base64')),
    )
  })
})
