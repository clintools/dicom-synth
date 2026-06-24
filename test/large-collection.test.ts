import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateCollectionFromSpec,
  generateFile,
  previewCollection,
  writeCollectionFromSpec,
} from '../src/collection/writer'
import type { DatasetSpec } from '../src/schema/types'
import { parseNatural } from './helpers/dicom'

// Small targetBytes keeps the test cheap; writeCollectionFromSpec does not
// enforce the 512 MB floor (that is validateDatasetSpec's job), so the streaming
// routing/grouping can be exercised at KB scale.
const spec: DatasetSpec = {
  seed: 5,
  layout: 'hierarchical',
  studies: [
    {
      series: [
        {
          entries: [
            { type: 'valid-image', targetSizeKb: 2, modality: 'PT' },
            { type: 'large-image', targetBytes: 8192, modality: 'PT' },
          ],
        },
      ],
    },
  ],
}

describe('large-image in a collection', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'large-collection-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('streams the large file into the series, sharing study/series UIDs', async () => {
    const manifest = await writeCollectionFromSpec(spec, join(tmpDir, 'out'))
    expect(manifest.map((m) => m.type)).toEqual(['valid-image', 'large-image'])

    const normal = parseNatural(readFileSync(manifest[0]?.path as string))
    const large = parseNatural(readFileSync(manifest[1]?.path as string))

    expect(large.SeriesInstanceUID).toBe(normal.SeriesInstanceUID)
    expect(large.StudyInstanceUID).toBe(normal.StudyInstanceUID)
    expect(large.SOPInstanceUID).not.toBe(normal.SOPInstanceUID)
    expect(large.Modality).toBe('PT')
    expect(Number(large.InstanceNumber)).toBe(2)
  })

  it('is deterministic for a given seed', async () => {
    const m1 = await writeCollectionFromSpec(spec, join(tmpDir, 'a'))
    const m2 = await writeCollectionFromSpec(spec, join(tmpDir, 'b'))
    expect(
      Buffer.compare(
        readFileSync(m1[1]?.path as string),
        readFileSync(m2[1]?.path as string),
      ),
    ).toBe(0)
  })

  it('generateCollectionFromSpec rejects large-image (in-memory)', async () => {
    await expect(async () => {
      for await (const _ of generateCollectionFromSpec(spec)) {
        // drain
      }
    }).rejects.toThrow(/large-image cannot be generated in memory/)
  })

  it('generateFile rejects large-image directly (in-memory)', async () => {
    await expect(
      generateFile({ type: 'large-image', targetBytes: 8192 }),
    ).rejects.toThrow(/large-image cannot be generated in memory/)
  })

  it('streams a flat (ungrouped) large-image entry', async () => {
    const flat: DatasetSpec = {
      seed: 9,
      entries: [{ type: 'large-image', targetBytes: 8192, modality: 'CT' }],
    }
    const manifest = await writeCollectionFromSpec(flat, join(tmpDir, 'flat'))
    expect(manifest).toHaveLength(1)
    expect(manifest[0]?.type).toBe('large-image')
    const ds = parseNatural(readFileSync(manifest[0]?.path as string))
    expect(ds.Modality).toBe('CT')
  })
})

describe('previewCollection (dry-run)', () => {
  it('reports large-image by targetBytes without materialising it', async () => {
    const previewSpec: DatasetSpec = {
      seed: 5,
      entries: [
        { type: 'valid-image', targetSizeKb: 2 },
        { type: 'large-image', targetBytes: 600 * 1024 * 1024 },
      ],
    }
    const items = []
    for await (const item of previewCollection(previewSpec)) items.push(item)

    expect(items.map((i) => i.type)).toEqual(['valid-image', 'large-image'])
    expect(items[1]?.approxBytes).toBe(600 * 1024 * 1024)
    expect(items[0]?.approxBytes).toBeGreaterThan(0)
  })
})
