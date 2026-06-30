import { describe, expect, it } from 'vitest'
import {
  type GeneratedFile,
  generateCollectionFromSpec,
} from '../src/collection/writer'
import { tagValuesEqual } from '../src/describe/describe'
import { MAX_PIXEL_BYTES } from '../src/schema/limits'
import type { DatasetSpec } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { parseNatural } from './helpers/dicom'

async function collect(spec: DatasetSpec): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = []
  for await (const f of generateCollectionFromSpec(spec)) files.push(f)
  return files
}

describe('tagValuesEqual', () => {
  it('compares scalars by value', () => {
    expect(tagValuesEqual('a', 'a')).toBe(true)
    expect(tagValuesEqual('a', 'b')).toBe(false)
    expect(tagValuesEqual(3, 3)).toBe(true)
    expect(tagValuesEqual(3, 4)).toBe(false)
  })

  it('compares arrays/objects structurally', () => {
    expect(
      tagValuesEqual(['ORIGINAL', 'PRIMARY'], ['ORIGINAL', 'PRIMARY']),
    ).toBe(true)
    expect(tagValuesEqual(['ORIGINAL'], ['DERIVED'])).toBe(false)
    expect(tagValuesEqual({ a: 1 }, { a: 1 })).toBe(true)
    expect(tagValuesEqual({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('treats a scalar and a non-scalar as unequal', () => {
    expect(tagValuesEqual('a', ['a'])).toBe(false)
    expect(tagValuesEqual(null, ['a'])).toBe(false)
  })
})

describe('instances form — generation', () => {
  it('assigns each instance its shared + per-instance tags by index', async () => {
    const spec: DatasetSpec = {
      seed: 1,
      studies: [
        {
          series: [
            {
              tags: { Manufacturer: 'ACME' },
              instances: {
                count: 3,
                targetSizeKb: [10, 20, 30],
                tags: { PatientID: ['A', 'B', 'C'] },
              },
            },
          ],
        },
      ],
    }
    const files = await collect(spec)
    expect(files).toHaveLength(3)
    const rows = files.map((f) => {
      const ds = parseNatural(f.buffer)
      return [ds.PatientID, ds.Manufacturer, ds.InstanceNumber]
    })
    expect(rows).toEqual([
      ['A', 'ACME', 1],
      ['B', 'ACME', 2],
      ['C', 'ACME', 3],
    ])
  })

  it('keeps two varying tags correlated per instance', async () => {
    const spec: DatasetSpec = {
      seed: 2,
      studies: [
        {
          series: [
            {
              instances: {
                count: 3,
                targetSizeKb: [10, 10, 10],
                tags: {
                  PatientID: ['A', 'B', 'C'],
                  StationName: ['X', 'Y', 'Z'],
                },
              },
            },
          ],
        },
      ],
    }
    const files = await collect(spec)
    const pairs = files.map((f) => {
      const ds = parseNatural(f.buffer)
      return `${ds.PatientID}${ds.StationName}`
    })
    expect(pairs).toEqual(['AX', 'BY', 'CZ'])
  })

  it('honours a scalar modality across instances', async () => {
    const spec: DatasetSpec = {
      seed: 3,
      studies: [
        {
          series: [
            {
              instances: {
                count: 2,
                targetSizeKb: [10, 10],
                modality: 'PT',
                tags: { PatientID: ['A', 'B'] },
              },
            },
          ],
        },
      ],
    }
    const files = await collect(spec)
    for (const f of files) {
      expect(parseNatural(f.buffer).Modality).toBe('PT')
    }
  })

  it('is deterministic for a given seed', async () => {
    const spec: DatasetSpec = {
      seed: 9,
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
    }
    const a = await collect(spec)
    const b = await collect(spec)
    expect(a.map((f) => f.buffer.toString('base64'))).toEqual(
      b.map((f) => f.buffer.toString('base64')),
    )
  })
})

describe('instances form — validation', () => {
  const wrap = (instances: unknown): unknown => ({
    studies: [{ series: [{ instances }] }],
  })

  it('accepts a well-formed instances series', () => {
    expect(() =>
      validateDatasetSpec(
        wrap({
          count: 2,
          targetSizeKb: [10, 20],
          tags: { PatientID: ['A', 'B'] },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects a series with both entries and instances', () => {
    expect(() =>
      validateDatasetSpec({
        studies: [
          {
            series: [
              {
                entries: [{ type: 'valid-image' }],
                instances: { count: 1, targetSizeKb: [10] },
              },
            ],
          },
        ],
      }),
    ).toThrow(/exactly one of "entries" or "instances"/)
  })

  it('rejects a series with neither entries nor instances', () => {
    expect(() => validateDatasetSpec({ studies: [{ series: [{}] }] })).toThrow(
      /exactly one of "entries" or "instances"/,
    )
  })

  it('rejects both size kinds at once', () => {
    expect(() =>
      validateDatasetSpec(
        wrap({
          count: 1,
          targetSizeKb: [10],
          targetBytes: [MAX_PIXEL_BYTES + 1],
        }),
      ),
    ).toThrow(/exactly one of "targetSizeKb" or "targetBytes"/)
  })

  it('rejects a size array whose length != count', () => {
    expect(() =>
      validateDatasetSpec(wrap({ count: 3, targetSizeKb: [10, 20] })),
    ).toThrow(/length .* must equal count/)
  })

  it('rejects a tag array whose length != count', () => {
    expect(() =>
      validateDatasetSpec(
        wrap({
          count: 2,
          targetSizeKb: [10, 20],
          tags: { PatientID: ['only-one'] },
        }),
      ),
    ).toThrow(/length .* must equal count/)
  })

  it('rejects a preset modality inside per-instance tags', () => {
    expect(() =>
      validateDatasetSpec(
        wrap({ count: 1, targetSizeKb: [10], tags: { Modality: ['PT'] } }),
      ),
    ).toThrow(/set a preset modality/)
  })

  it('accepts large-image instances via targetBytes', () => {
    expect(() =>
      validateDatasetSpec(
        wrap({
          count: 2,
          targetBytes: [MAX_PIXEL_BYTES + 1, MAX_PIXEL_BYTES + 2],
        }),
      ),
    ).not.toThrow()
  })
})
