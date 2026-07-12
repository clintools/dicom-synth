import { describe, expect, it } from 'vitest'
import {
  type GeneratedFile,
  generateCollectionFromSpec,
  generateFile,
} from '../src/collection/generate'
import type { DatasetSpec } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { resolveTagTemplates } from '../src/syntheticFixtures/tagTemplate'
import { base64, parseNatural } from './helpers/dicom'

async function collect(spec: DatasetSpec): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = []
  for await (const f of generateCollectionFromSpec(spec)) files.push(f)
  return files
}

describe('resolveTagTemplates', () => {
  it('substitutes known tokens in string values', () => {
    const out = resolveTagTemplates(
      { PatientID: 'P{studyIndex}-{instanceNumber}' },
      { index: 0, studyIndex: 2, seriesIndex: 0, instanceNumber: 5 },
    )
    expect(out?.PatientID).toBe('P2-5')
  })

  it('leaves non-string values untouched', () => {
    const out = resolveTagTemplates(
      { InstanceNumber: 3 },
      { index: 0, instanceNumber: 3 },
    )
    expect(out?.InstanceNumber).toBe(3)
  })

  it('throws on an unknown placeholder', () => {
    expect(() =>
      resolveTagTemplates({ PatientID: 'P{bogus}' }, { index: 0 }),
    ).toThrow(/unknown placeholder "\{bogus\}"/)
  })

  it('throws when a token has no value in this context', () => {
    expect(() =>
      resolveTagTemplates({ PatientID: 'P{instanceNumber}' }, { index: 0 }),
    ).toThrow(/not available here/)
  })

  it('unescapes doubled braces to literals without substituting', () => {
    const out = resolveTagTemplates(
      { PatientID: 'a{{b}}c', StudyDescription: 'scan {{index}}' },
      { index: 7 },
    )
    expect(out?.PatientID).toBe('a{b}c')
    // {{index}} is an escaped literal, not the {index} token.
    expect(out?.StudyDescription).toBe('scan {index}')
  })
})

describe('templated tags — collection paths', () => {
  it('resolves study/series/instance/index tokens per file', async () => {
    const spec: DatasetSpec = {
      seed: 1,
      studies: [
        {
          count: 2,
          series: [
            {
              entries: [
                {
                  type: 'valid-image',
                  count: 2,
                  tags: {
                    PatientID: 'P{studyIndex}-{instanceNumber}',
                    SeriesDescription: 'S{seriesIndex}',
                    StudyDescription: 'idx{index}',
                  },
                },
              ],
            },
          ],
        },
      ],
    }
    const files = await collect(spec)
    const tags = files.map((f) => {
      const ds = parseNatural(f.buffer)
      return [ds.PatientID, ds.SeriesDescription, ds.StudyDescription]
    })
    expect(tags).toEqual([
      ['P0-1', 'S0', 'idx0'],
      ['P0-2', 'S0', 'idx1'],
      ['P1-1', 'S0', 'idx2'],
      ['P1-2', 'S0', 'idx3'],
    ])
  })

  it('resolves {index} on the standalone generateFile path', async () => {
    const file = await generateFile(
      { type: 'valid-image', tags: { PatientID: 'P{index}' } },
      { index: 5 },
    )
    expect(parseNatural(file.buffer).PatientID).toBe('P5')
  })

  it('throws when a flat entry uses a grouping-only token', async () => {
    const spec: DatasetSpec = {
      entries: [
        { type: 'valid-image', tags: { PatientID: 'P{instanceNumber}' } },
      ],
    }
    await expect(collect(spec)).rejects.toThrow(/not available here/)
  })

  it('is deterministic — same seed and templates → identical buffers', async () => {
    const spec: DatasetSpec = {
      seed: 9,
      studies: [
        {
          series: [
            {
              entries: [
                {
                  type: 'valid-image',
                  count: 2,
                  tags: { PatientID: 'P{instanceNumber}' },
                },
              ],
            },
          ],
        },
      ],
    }
    const a = await collect(spec)
    const b = await collect(spec)
    expect(a.map((f) => base64(f.buffer))).toEqual(
      b.map((f) => base64(f.buffer)),
    )
  })
})

describe('validateDatasetSpec — tag coupling and templates', () => {
  it('rejects a preset modality set via tags', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { Modality: 'PT' } }],
      }),
    ).toThrow(/set a preset modality .* via the "modality" field/)
  })

  it('rejects a preset modality via the hex tag form', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { '00080060': 'PT' } }],
      }),
    ).toThrow(/set a preset modality/)
  })

  it('allows a non-preset modality via tags', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { Modality: 'US' } }],
      }),
    ).not.toThrow()
  })

  it('rejects an unknown placeholder token', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { PatientID: 'P{bogus}' } }],
      }),
    ).toThrow(/unknown placeholder "\{bogus\}"/)
  })

  it('accepts a known placeholder token', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { PatientID: 'P{index}' } }],
      }),
    ).not.toThrow()
  })

  it('accepts escaped braces as a literal value', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { PatientID: 'v{{x}}' } }],
      }),
    ).not.toThrow()
  })
})
