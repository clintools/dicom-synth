import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateCollectionFromSpec,
  generateFile,
  writeCollectionFromSpec,
} from '../src/collection/writer'
import { applyViolations } from '../src/syntheticFixtures/violations'

describe('generateFile — layer 1', () => {
  it('returns index 0 when no opts supplied', async () => {
    const { index } = await generateFile({ type: 'valid-ct' })
    expect(index).toBe(0)
  })

  it('honours explicit index', async () => {
    const { index } = await generateFile({ type: 'valid-ct' }, { index: 7 })
    expect(index).toBe(7)
  })

  it('same seed + index → identical buffers across calls', async () => {
    const a = (await generateFile({ type: 'valid-ct' }, { seed: 1, index: 0 }))
      .buffer
    const b = (await generateFile({ type: 'valid-ct' }, { seed: 1, index: 0 }))
      .buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('different seeds → different buffers', async () => {
    const a = (await generateFile({ type: 'valid-ct' }, { seed: 1, index: 0 }))
      .buffer
    const b = (await generateFile({ type: 'valid-ct' }, { seed: 2, index: 0 }))
      .buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('applies violations when spec includes them', async () => {
    const clean = (await generateFile({ type: 'valid-ct' })).buffer
    const violated = applyViolations(clean, ['missing-meta-header'])
    expect(violated.length).toBe(clean.length - 132)
  })
})

describe('generateCollectionFromSpec — layer 2', () => {
  it('yields correct total file count', async () => {
    const files: unknown[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [
        { type: 'valid-ct', count: 3 },
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
      entries: [{ type: 'valid-ct', count: 5 }],
    })) {
      names.push(f.filename)
    }
    expect(new Set(names).size).toBe(5)
  })

  it('yields unique buffers for unseeded collections', async () => {
    const buffers: Buffer[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-ct', count: 3 }],
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
        entries: [{ type: 'valid-ct', count: 3 }],
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
      entries: [{ type: 'valid-ct' }, { type: 'fake-signature' }],
    })) {
      files.push(f)
    }
    expect(files).toHaveLength(2)
  })

  it('zero-pads index width to match total file count', async () => {
    const names: string[] = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-ct', count: 10 }],
    })) {
      names.push(f.filename)
    }
    // 10 files → padWidth 2 → "00" through "09"
    expect(names[0]).toBe('valid-ct-00.dcm')
    expect(names[9]).toBe('valid-ct-09.dcm')
  })

  it('applies violations to entries that include them', async () => {
    const files: Array<{ buffer: Buffer }> = []
    for await (const f of generateCollectionFromSpec({
      entries: [{ type: 'valid-ct', violations: ['missing-meta-header'] }],
    })) {
      files.push(f)
    }
    // missing-meta-header strips 132 bytes — buffer must not start with DICM
    expect(files[0].buffer.subarray(0, 4).toString('ascii')).not.toBe('DICM')
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
          { type: 'valid-ct', count: 2 },
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
          { type: 'valid-ct', count: 2 },
          { type: 'non-dicom', count: 1 },
        ],
      },
      tmpDir,
    )
    expect(manifest).toHaveLength(3)
    expect(manifest[0].type).toBe('valid-ct')
    expect(manifest[2].type).toBe('non-dicom')
  })

  it('creates the output directory if it does not exist', async () => {
    const nested = join(tmpDir, 'nested', 'out')
    await writeCollectionFromSpec({ entries: [{ type: 'valid-ct' }] }, nested)
    expect(readdirSync(nested)).toHaveLength(1)
  })

  it('writes non-dicom files without .dcm extension', async () => {
    await writeCollectionFromSpec({ entries: [{ type: 'non-dicom' }] }, tmpDir)
    const [name] = readdirSync(tmpDir)
    expect(name).not.toMatch(/\.dcm$/)
  })

  it('writes DICOM files with .dcm extension', async () => {
    await writeCollectionFromSpec({ entries: [{ type: 'valid-ct' }] }, tmpDir)
    const [name] = readdirSync(tmpDir)
    expect(name).toMatch(/\.dcm$/)
  })
})
