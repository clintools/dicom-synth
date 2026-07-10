import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type GeneratedFile,
  generateCollectionFromSpec,
  generateFile,
  previewCollection,
  writeCollectionFromSpec,
} from '../src/collection/writer'
import type { DatasetSpec, TreeNode } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { parseNatural } from './helpers/dicom'

async function collect(spec: DatasetSpec): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = []
  for await (const f of generateCollectionFromSpec(spec)) files.push(f)
  return files
}

const treeSpec = (tree: TreeNode[]): DatasetSpec => ({ seed: 1, tree })

describe('validateDatasetSpec — tree', () => {
  const accepts = (tree: TreeNode[]) =>
    expect(() => validateDatasetSpec({ tree })).not.toThrow()
  const rejects = (tree: unknown[], message: string | RegExp) =>
    expect(() => validateDatasetSpec({ tree })).toThrow(message)

  it('accepts a nested mixed tree with role markers', () => {
    accepts([
      { type: 'non-dicom', name: 'manifest.csv', targetSizeKb: 2 },
      {
        name: 'site-a',
        children: [
          {
            role: 'study',
            children: [
              {
                role: 'series',
                children: [{ type: 'valid-image', count: 2 }],
              },
            ],
          },
        ],
      },
    ])
  })

  it('is accepted as the sole structure', () => {
    expect(() =>
      validateDatasetSpec({ tree: [{ type: 'valid-image' }] }),
    ).not.toThrow()
    expect(() => validateDatasetSpec({})).toThrow(/at least one of/)
  })

  it('rejects a series role outside a study', () => {
    rejects(
      [{ role: 'series', children: [{ type: 'valid-image' }] }],
      /requires an enclosing study/,
    )
  })

  it('rejects nested study and nested series roles', () => {
    rejects(
      [
        {
          role: 'study',
          children: [{ role: 'study', children: [{ type: 'valid-image' }] }],
        },
      ],
      /cannot nest inside another study/,
    )
    rejects(
      [
        {
          role: 'study',
          children: [
            {
              role: 'series',
              children: [
                { role: 'series', children: [{ type: 'valid-image' }] },
              ],
            },
          ],
        },
      ],
      /cannot nest inside another series/,
    )
  })

  it('rejects unsafe names', () => {
    rejects([{ type: 'valid-image', name: 'a/b.dcm' }], /path separators/)
    rejects(
      [{ name: '..', children: [{ type: 'valid-image' }] }],
      /tree\[0\]\.name/,
    )
  })

  it('rejects a name combined with count > 1', () => {
    rejects([{ type: 'valid-image', name: 'x.dcm', count: 2 }], /collide/)
  })

  it('rejects a node that is both directory and file', () => {
    rejects(
      [{ type: 'valid-image', children: [] }],
      /both "children" .* and "type"/,
    )
  })

  it('rejects empty children', () => {
    rejects([{ name: 'empty', children: [] }], /non-empty array/)
  })

  it('rejects sibling name collisions', () => {
    rejects(
      [
        { type: 'non-dicom', name: 'a.csv' },
        { type: 'valid-image', name: 'a.csv' },
      ],
      /collides with tree\[0\]/,
    )
    rejects(
      [
        {
          name: 'root',
          children: [
            { type: 'valid-image', name: 'x.dcm' },
            { name: 'x.dcm', children: [{ type: 'valid-image' }] },
          ],
        },
      ],
      /collides/,
    )
    // An unnamed directory's synthetic dir-NNN can collide with an explicit name.
    rejects(
      [
        { name: 'dir-002', children: [{ type: 'valid-image' }] },
        { children: [{ type: 'valid-image' }] },
      ],
      /"dir-002" collides/,
    )
    // Same names in different directories are fine.
    accepts([
      { name: 'a', children: [{ type: 'valid-image', name: 'x.dcm' }] },
      { name: 'b', children: [{ type: 'valid-image', name: 'x.dcm' }] },
    ])
  })

  it('rejects conflicting non-dicom sizing', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'non-dicom', content: 'x', targetSizeKb: 1 }],
      }),
    ).toThrow(/mutually exclusive/)
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'non-dicom', targetBytes: 600 * 1024 * 1024 }],
      }),
    ).toThrow(/512 MB/)
  })
})

describe('non-dicom sizing', () => {
  it('targetSizeKb produces exactly sized placeholder bytes', async () => {
    const file = await generateFile({ type: 'non-dicom', targetSizeKb: 3 })
    expect(file.buffer.length).toBe(3 * 1024)
    expect(file.buffer.toString('utf8', 0, 9)).toBe('not dicom')
  })

  it('targetBytes produces byte-exact placeholders', async () => {
    const file = await generateFile({ type: 'non-dicom', targetBytes: 37 })
    expect(file.buffer.length).toBe(37)
  })

  it('content and default forms are unchanged', async () => {
    const explicit = await generateFile({ type: 'non-dicom', content: 'hello' })
    expect(explicit.buffer.toString('utf8')).toBe('hello')
    const fallback = await generateFile({ type: 'non-dicom' })
    expect(fallback.buffer.toString('utf8')).toBe('not dicom')
  })
})

describe('generateCollectionFromSpec — tree', () => {
  const nestedTree = (): TreeNode[] => [
    {
      name: 'site-a',
      children: [
        { type: 'non-dicom', name: 'index.csv', targetSizeKb: 1 },
        {
          name: 'patient-1',
          role: 'study',
          tags: { PatientID: 'P-001' },
          children: [
            {
              name: 'CT',
              role: 'series',
              children: [{ type: 'valid-image', count: 2 }],
            },
            {
              name: 'PT',
              role: 'series',
              children: [{ type: 'valid-image', modality: 'PT' }],
            },
          ],
        },
        {
          name: 'patient-2',
          role: 'study',
          children: [
            {
              role: 'series',
              children: [{ type: 'valid-image' }],
            },
          ],
        },
      ],
    },
  ]

  it('writes files under their directory chains', async () => {
    const files = await collect(treeSpec(nestedTree()))
    const paths = files.map((f) => f.relativePath)
    expect(paths).toEqual([
      'site-a/index.csv',
      'site-a/patient-1/CT/valid-image-1.dcm',
      'site-a/patient-1/CT/valid-image-2.dcm',
      'site-a/patient-1/PT/valid-image-3.dcm',
      'site-a/patient-2/dir-001/valid-image-4.dcm',
    ])
  })

  it('role-marked dirs mint shared study/series UIDs; explicit tags win', async () => {
    const files = await collect(treeSpec(nestedTree()))
    const naturals = files.slice(1).map((f) => parseNatural(f.buffer))
    const [ct1, ct2, pt, other] = naturals as Record<string, unknown>[]

    // One study per role: 'study' dir; series differ per role: 'series' dir.
    expect(ct1?.StudyInstanceUID).toBe(ct2?.StudyInstanceUID)
    expect(ct1?.StudyInstanceUID).toBe(pt?.StudyInstanceUID)
    expect(other?.StudyInstanceUID).not.toBe(ct1?.StudyInstanceUID)
    expect(ct1?.SeriesInstanceUID).toBe(ct2?.SeriesInstanceUID)
    expect(pt?.SeriesInstanceUID).not.toBe(ct1?.SeriesInstanceUID)

    // Directory tags merge down; InstanceNumber counts within the series.
    expect(ct1?.PatientID).toBe('P-001')
    expect(pt?.PatientID).toBe('P-001')
    expect([ct1?.InstanceNumber, ct2?.InstanceNumber]).toEqual([1, 2])
    expect(pt?.InstanceNumber).toBe(1)
  })

  it('file tags override directory tags', async () => {
    const files = await collect(
      treeSpec([
        {
          role: 'study',
          tags: { PatientID: 'from-dir' },
          children: [{ type: 'valid-image', tags: { PatientID: 'from-file' } }],
        },
      ]),
    )
    expect(parseNatural(files[0]!.buffer).PatientID).toBe('from-file')
  })

  it('tree study UIDs stay disjoint from grouped-study UIDs', async () => {
    const files = await collect({
      seed: 1,
      studies: [{ series: [{ entries: [{ type: 'valid-image' }] }] }],
      tree: [{ role: 'study', children: [{ type: 'valid-image' }] }],
    })
    const [grouped, treed] = files.map(
      (f) => parseNatural(f.buffer).StudyInstanceUID,
    )
    expect(treed).not.toBe(grouped)
  })

  it('same spec + seed reproduces identical paths and UIDs', async () => {
    const a = await collect(treeSpec(nestedTree()))
    const b = await collect(treeSpec(nestedTree()))
    expect(a.map((f) => f.relativePath)).toEqual(b.map((f) => f.relativePath))
    const sopUids = (files: GeneratedFile[]) =>
      files
        .filter((f) => f.type === 'valid-image')
        .map((f) => parseNatural(f.buffer).SOPInstanceUID)
    expect(sopUids(a)).toEqual(sopUids(b))
  })

  it('applies pathQuirks to tree paths', async () => {
    const files = await collect({
      seed: 1,
      tree: [
        { name: 'docs', children: [{ type: 'valid-image', name: 'a.dcm' }] },
      ],
      pathQuirks: ['trailing-dot'],
    })
    expect(files[0]?.relativePath).toBe('docs./a.dcm')
  })
})

describe('writeCollectionFromSpec / previewCollection — tree', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dicom-synth-tree-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const spec: DatasetSpec = {
    seed: 7,
    tree: [
      {
        name: 'batch',
        children: [
          { type: 'non-dicom', name: 'log.txt', targetBytes: 123 },
          {
            role: 'study',
            children: [{ type: 'valid-image', targetSizeKb: 20 }],
          },
        ],
      },
    ],
  }

  it('writes the tree to disk with sized non-DICOM placeholders', async () => {
    const manifest = await writeCollectionFromSpec(spec, dir)
    expect(manifest.map((m) => m.type)).toEqual(['non-dicom', 'valid-image'])
    expect(statSync(join(dir, 'batch/log.txt')).size).toBe(123)
    const image = manifest.find((m) => m.type === 'valid-image')
    expect(image?.path).toContain(join('batch', 'dir-001'))
    expect(
      parseNatural(readFileSync(image!.path)).StudyInstanceUID,
    ).toBeTruthy()
  })

  it('previews tree files without writing', async () => {
    const items = []
    for await (const item of previewCollection(spec)) items.push(item)
    expect(items.map((i) => i.relativePath)).toEqual([
      'batch/log.txt',
      'batch/dir-001/valid-image-1.dcm',
    ])
    expect(items[0]?.approxBytes).toBe(123)
  })
})
