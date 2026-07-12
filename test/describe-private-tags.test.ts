import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeDirectory,
  generateCollectionFromSpec,
  writeCollectionFromSpec,
} from '../src'
import { parseRawDict, type RawDictElement } from './helpers/dicom'

// A private block exercising every captured shape: creator, scalar,
// multi-valued, UID-valued, and a nested private sequence.
const PRIVATE_TAGS = {
  '00090010': { vr: 'LO', value: 'ACME_SYNTH' },
  '00091001': { vr: 'SH', value: 'SYNTH-A' },
  '00091002': { vr: 'DS', value: ['1.5', '2.5'] },
  '00091007': { vr: 'UI', value: '1.2.826.0.1.3680043.99.1' },
  '00091003': {
    vr: 'SQ',
    value: [
      {
        '00091004': { vr: 'SH', value: 'NESTED' },
        '00091005': {
          vr: 'SQ',
          value: [{ '00091006': { vr: 'IS', value: '7' } }],
        },
      },
    ],
  },
}

async function collect(spec: Parameters<typeof generateCollectionFromSpec>[0]) {
  const files = []
  for await (const f of generateCollectionFromSpec(spec)) files.push(f)
  return files
}

describe('describe — private tag capture', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'describe-private-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const writeSource = async (tags: Record<string, unknown> = PRIVATE_TAGS) =>
    writeCollectionFromSpec(
      {
        seed: 3,
        studies: [
          { series: [{ entries: [{ type: 'valid-image', tags, count: 2 }] }] },
        ],
      },
      dir,
    )

  it('round-trips a full private block via keepPrivateTags', async () => {
    await writeSource()
    const { spec, stats } = describeDirectory(dir, { keepPrivateTags: true })
    expect(stats.privateBinarySkipped).toBe(0)

    const regenerated = await collect(spec)
    expect(regenerated).toHaveLength(2)
    const dict = parseRawDict(regenerated[0].buffer)

    expect(dict['00090010']).toMatchObject({ vr: 'LO', Value: ['ACME_SYNTH'] })
    expect(dict['00091001']).toMatchObject({ vr: 'SH', Value: ['SYNTH-A'] })
    expect(dict['00091002']).toMatchObject({ vr: 'DS', Value: [1.5, 2.5] })
    const item = (
      dict['00091003']?.Value as Record<string, RawDictElement>[]
    )[0]
    expect(item?.['00091004']).toMatchObject({ vr: 'SH', Value: ['NESTED'] })
    const nested = (
      item?.['00091005']?.Value as Record<string, RawDictElement>[]
    )[0]
    expect(nested?.['00091006']).toMatchObject({ vr: 'IS', Value: [7] })
  })

  it('hashes UID-valued private leaves under preserveUids', async () => {
    await writeSource()
    const { spec } = describeDirectory(dir, { keepPrivateTags: true })

    const regenerated = await collect(spec)
    const uids = regenerated.map(
      (f) => parseRawDict(f.buffer)['00091007']?.Value?.[0],
    )
    // No real UID leaks, and both files (same source UID) share one synthetic.
    expect(uids[0]).not.toBe('1.2.826.0.1.3680043.99.1')
    expect(String(uids[0])).toMatch(/^2\.25\./)
    expect(uids[1]).toBe(uids[0])
  })

  it('keeps UID-valued private leaves verbatim when preserveUids is off', async () => {
    await writeSource()
    const { spec } = describeDirectory(dir, {
      keepPrivateTags: true,
      preserveUids: false,
    })
    const regenerated = await collect(spec)
    expect(parseRawDict(regenerated[0].buffer)['00091007']?.Value?.[0]).toBe(
      '1.2.826.0.1.3680043.99.1',
    )
  })

  it('captures only the private tags named in keepTags', async () => {
    await writeSource()
    const { spec } = describeDirectory(dir, { keepTags: ['00091001'] })
    const regenerated = await collect(spec)
    const dict = parseRawDict(regenerated[0].buffer)
    expect(dict['00091001']).toMatchObject({ vr: 'SH', Value: ['SYNTH-A'] })
    expect(dict['00090010']).toBeUndefined()
    expect(dict['00091003']).toBeUndefined()
  })

  it('still rejects unknown even-group hex tags in keepTags', async () => {
    await writeSource()
    expect(() => describeDirectory(dir, { keepTags: ['EEEE0001'] })).toThrow(
      /unknown hex tag/,
    )
  })

  it('skips and counts binary private payloads', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await writeSource({
        '00090010': { vr: 'LO', value: 'ACME_SYNTH' },
        // ArrayBuffer payloads cannot ride a JSON spec.
        '00091008': { vr: 'OB', value: new Uint8Array([1, 2]).buffer },
      })
      const { spec, stats } = describeDirectory(dir, { keepPrivateTags: true })
      expect(stats.privateBinarySkipped).toBeGreaterThanOrEqual(1)
      const regenerated = await collect(spec)
      const dict = parseRawDict(regenerated[0].buffer)
      expect(dict['00090010']).toMatchObject({ vr: 'LO' })
      expect(dict['00091008']).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('binary payloads'),
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('skips and counts null components from unparseable typed values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await writeSource({
        '00090010': { vr: 'LO', value: 'ACME_SYNTH' },
        // dcmjs parses an unparseable DS component as NaN (JSON-unrepresentable).
        '00091009': { vr: 'DS', value: 'not-a-number' },
      })
      const { spec, stats } = describeDirectory(dir, { keepPrivateTags: true })
      expect(stats.privateBinarySkipped).toBeGreaterThanOrEqual(1)
      const regenerated = await collect(spec)
      const dict = parseRawDict(regenerated[0].buffer)
      expect(dict['00090010']).toMatchObject({ vr: 'LO' })
      expect(dict['00091009']).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it('captures private blocks in tree mode too', async () => {
    await writeSource()
    const { spec } = describeDirectory(dir, {
      keepPrivateTags: true,
      captureTree: true,
    })
    const regenerated = await collect(spec)
    const dict = parseRawDict(regenerated[0].buffer)
    expect(dict['00090010']).toMatchObject({ vr: 'LO', Value: ['ACME_SYNTH'] })
    expect(dict['00091001']).toMatchObject({ vr: 'SH', Value: ['SYNTH-A'] })
  })

  it('is unchanged by default — no private capture without opt-in', async () => {
    await writeSource()
    const { spec, stats } = describeDirectory(dir)
    expect(stats.privateBinarySkipped).toBe(0)
    const regenerated = await collect(spec)
    expect(parseRawDict(regenerated[0].buffer)['00091001']).toBeUndefined()
  })
})
