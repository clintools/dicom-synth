import { describe, expect, it } from 'vitest'
import { resolveParametricSpec } from '../src/schema/parametric'
import type { ParametricSpec, SeriesEntrySpec } from '../src/schema/types'
import {
  validateDatasetSpec,
  validateParametricSpec,
} from '../src/schema/validate'

const fixedSpec: ParametricSpec = {
  seed: 42,
  studies: { count: 2, seriesPerStudy: 3, filesPerSeries: 4 },
}

function seriesFileCount(entries: SeriesEntrySpec[]): number {
  return entries.reduce((sum, e) => sum + (e.count ?? 1), 0)
}

describe('resolveParametricSpec — determinism', () => {
  it('same seed resolves to an identical spec', () => {
    const spec: ParametricSpec = {
      seed: 7,
      studies: {
        count: { min: 1, max: 5 },
        seriesPerStudy: { min: 1, max: 4 },
        filesPerSeries: { min: 2, max: 30 },
        fileSizeKb: { min: 50, max: 500 },
        modalities: ['CT', 'PT', 'MR'],
      },
      edgeCases: [{ type: 'invalid-uid-image', frequency: 0.1 }],
    }
    expect(resolveParametricSpec(spec)).toEqual(resolveParametricSpec(spec))
  })

  it('embeds a numeric seed when omitted', () => {
    const resolved = resolveParametricSpec({
      studies: { count: 1, seriesPerStudy: 1, filesPerSeries: 1 },
    })
    expect(typeof resolved.seed).toBe('number')
  })

  it('re-resolving with the embedded seed reproduces the spec', () => {
    const spec: ParametricSpec = {
      studies: {
        count: { min: 1, max: 3 },
        seriesPerStudy: { min: 1, max: 3 },
        filesPerSeries: { min: 1, max: 10 },
      },
    }
    const first = resolveParametricSpec(spec)
    const second = resolveParametricSpec({ ...spec, seed: first.seed })
    expect(second).toEqual(first)
  })
})

describe('resolveParametricSpec — structure', () => {
  it('fixed numbers resolve to exact counts', () => {
    const resolved = resolveParametricSpec(fixedSpec)
    expect(resolved.studies).toHaveLength(2)
    for (const study of resolved.studies ?? []) {
      expect(study.series).toHaveLength(3)
      for (const series of study.series) {
        expect(seriesFileCount(series.entries)).toBe(4)
      }
    }
  })

  it('ranges resolve within bounds across seeds', () => {
    for (let seed = 0; seed < 25; seed++) {
      const resolved = resolveParametricSpec({
        seed,
        studies: {
          count: { min: 2, max: 5 },
          seriesPerStudy: { min: 1, max: 3 },
          filesPerSeries: { min: 4, max: 9 },
        },
      })
      const studies = resolved.studies ?? []
      expect(studies.length).toBeGreaterThanOrEqual(2)
      expect(studies.length).toBeLessThanOrEqual(5)
      for (const study of studies) {
        expect(study.series.length).toBeGreaterThanOrEqual(1)
        expect(study.series.length).toBeLessThanOrEqual(3)
        for (const series of study.series) {
          const files = seriesFileCount(series.entries)
          expect(files).toBeGreaterThanOrEqual(4)
          expect(files).toBeLessThanOrEqual(9)
        }
      }
    }
  })

  it('modalities are drawn from the provided list', () => {
    const resolved = resolveParametricSpec({
      seed: 3,
      studies: {
        count: 5,
        seriesPerStudy: 3,
        filesPerSeries: 2,
        modalities: ['PT', 'MR'],
      },
    })
    const drawn = new Set<string>()
    for (const study of resolved.studies ?? []) {
      for (const series of study.series) {
        for (const entry of series.entries) {
          expect(['PT', 'MR']).toContain(entry.modality)
          drawn.add(entry.modality as string)
        }
      }
    }
    expect(drawn.size).toBeGreaterThan(1)
  })

  it('omits modality when modalities is not provided', () => {
    const resolved = resolveParametricSpec(fixedSpec)
    const entry = resolved.studies?.[0]?.series[0]?.entries[0]
    expect(entry).not.toHaveProperty('modality')
  })

  it('a fileSizeKb range samples per file within bounds', () => {
    const resolved = resolveParametricSpec({
      seed: 11,
      studies: {
        count: 2,
        seriesPerStudy: 2,
        filesPerSeries: 5,
        fileSizeKb: { min: 100, max: 300 },
      },
    })
    for (const study of resolved.studies ?? []) {
      for (const series of study.series) {
        expect(series.entries).toHaveLength(5)
        for (const entry of series.entries) {
          expect(entry.targetSizeKb).toBeGreaterThanOrEqual(100)
          expect(entry.targetSizeKb).toBeLessThanOrEqual(300)
        }
      }
    }
  })

  it('a fixed fileSizeKb collapses to one counted entry per series', () => {
    const resolved = resolveParametricSpec({
      seed: 11,
      studies: {
        count: 1,
        seriesPerStudy: 2,
        filesPerSeries: 6,
        fileSizeKb: 200,
      },
    })
    for (const series of resolved.studies?.[0]?.series ?? []) {
      expect(series.entries).toEqual([
        { type: 'valid-image', targetSizeKb: 200, count: 6 },
      ])
    }
  })

  it('study tags are carried onto every resolved study', () => {
    const resolved = resolveParametricSpec({
      ...fixedSpec,
      studies: { ...fixedSpec.studies, tags: { PatientID: 'P001' } },
    })
    for (const study of resolved.studies ?? []) {
      expect(study.tags).toEqual({ PatientID: 'P001' })
    }
  })

  it('layout is passed through', () => {
    const resolved = resolveParametricSpec({
      ...fixedSpec,
      layout: 'hierarchical',
    })
    expect(resolved.layout).toBe('hierarchical')
  })
})

describe('resolveParametricSpec — edge cases', () => {
  it('an edge case without frequency is appended verbatim', () => {
    const resolved = resolveParametricSpec({
      ...fixedSpec,
      edgeCases: [{ type: 'dicomdir' }, { type: 'non-dicom', count: 3 }],
    })
    expect(resolved.entries).toEqual([
      { type: 'dicomdir' },
      { type: 'non-dicom', count: 3 },
    ])
  })

  it('frequency draws approximately the expected count over a large dataset', () => {
    // 1000 files at 0.2 — binomial sd ≈ 12.6, so [140, 260] is > 4σ slack.
    const resolved = resolveParametricSpec({
      seed: 99,
      studies: { count: 10, seriesPerStudy: 10, filesPerSeries: 10 },
      edgeCases: [{ type: 'invalid-uid-image', frequency: 0.2 }],
    })
    const drawn = resolved.entries?.[0]?.count ?? 0
    expect(drawn).toBeGreaterThanOrEqual(140)
    expect(drawn).toBeLessThanOrEqual(260)
  })

  it('frequency 0 draws nothing and emits no entry', () => {
    const resolved = resolveParametricSpec({
      ...fixedSpec,
      edgeCases: [{ type: 'invalid-uid-image', frequency: 0 }],
    })
    expect(resolved.entries).toBeUndefined()
  })

  it('frequency 1 draws every file slot', () => {
    const resolved = resolveParametricSpec({
      ...fixedSpec, // 2 × 3 × 4 = 24 files
      edgeCases: [{ type: 'invalid-uid-image', frequency: 1 }],
    })
    expect(resolved.entries).toEqual([{ type: 'invalid-uid-image', count: 24 }])
  })
})

describe('resolveParametricSpec — output contract', () => {
  it('the resolved spec passes validateDatasetSpec', () => {
    const resolved = resolveParametricSpec({
      seed: 1,
      studies: {
        count: { min: 1, max: 3 },
        seriesPerStudy: { min: 1, max: 2 },
        filesPerSeries: { min: 1, max: 5 },
        fileSizeKb: { min: 10, max: 50 },
        modalities: ['CT', 'PT'],
        tags: { StudyDescription: 'Parametric' },
      },
      edgeCases: [
        { type: 'invalid-uid-image', frequency: 0.5 },
        { type: 'dicomdir' },
      ],
      layout: 'hierarchical',
    })
    expect(() => validateDatasetSpec(resolved)).not.toThrow()
  })
})

describe('validateParametricSpec — invalid inputs', () => {
  const valid: ParametricSpec = {
    studies: { count: 1, seriesPerStudy: 1, filesPerSeries: 1 },
  }

  it('rejects a missing studies block', () => {
    expect(() => validateParametricSpec({})).toThrow(/studies.*required/)
  })

  it('rejects missing required ranges', () => {
    expect(() => validateParametricSpec({ studies: { count: 1 } })).toThrow(
      /seriesPerStudy.*required/,
    )
  })

  it('rejects min greater than max', () => {
    expect(() =>
      validateParametricSpec({
        studies: { ...valid.studies, count: { min: 5, max: 2 } },
      }),
    ).toThrow(/min.*max/)
  })

  it('rejects non-positive range values', () => {
    expect(() =>
      validateParametricSpec({
        studies: { ...valid.studies, filesPerSeries: 0 },
      }),
    ).toThrow(/positive integer/)
    expect(() =>
      validateParametricSpec({
        studies: { ...valid.studies, filesPerSeries: { min: 0, max: 3 } },
      }),
    ).toThrow(/positive integer/)
  })

  it('rejects a fileSizeKb range exceeding the 512 MB limit', () => {
    expect(() =>
      validateParametricSpec({
        studies: {
          ...valid.studies,
          fileSizeKb: { min: 1, max: 512 * 1024 + 1 },
        },
      }),
    ).toThrow(/512 MB/)
  })

  it('rejects unknown modalities', () => {
    expect(() =>
      validateParametricSpec({
        studies: { ...valid.studies, modalities: ['US'] },
      }),
    ).toThrow(/modalities\[0\]/)
  })

  it('rejects an empty modalities array', () => {
    expect(() =>
      validateParametricSpec({
        studies: { ...valid.studies, modalities: [] },
      }),
    ).toThrow(/non-empty/)
  })

  it('rejects frequency outside 0–1', () => {
    expect(() =>
      validateParametricSpec({
        ...valid,
        edgeCases: [{ type: 'valid-image', frequency: 1.5 }],
      }),
    ).toThrow(/between 0 and 1/)
  })

  it('rejects frequency combined with count', () => {
    expect(() =>
      validateParametricSpec({
        ...valid,
        edgeCases: [{ type: 'valid-image', frequency: 0.5, count: 2 }],
      }),
    ).toThrow(/frequency cannot be combined with count/)
  })

  it('rejects invalid edge-case entries', () => {
    expect(() =>
      validateParametricSpec({
        ...valid,
        edgeCases: [{ type: 'bogus' }],
      }),
    ).toThrow(/edgeCases\[0\]\.type/)
  })

  it('rejects a non-finite seed', () => {
    expect(() =>
      validateParametricSpec({ ...valid, seed: Number.NaN }),
    ).toThrow(/seed/)
  })

  it('rejects an unknown layout', () => {
    expect(() =>
      validateParametricSpec({ ...valid, layout: 'nested' }),
    ).toThrow(/layout/)
  })
})
