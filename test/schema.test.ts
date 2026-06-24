import { describe, expect, it } from 'vitest'
import { validateDatasetSpec } from '../src/schema/validate'

describe('validateDatasetSpec — valid inputs', () => {
  it('accepts a minimal valid spec', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image' }] }),
    ).not.toThrow()
  })

  it('accepts all fixture types', () => {
    const entries = [
      { type: 'valid-image' },
      { type: 'invalid-uid-image' },
      { type: 'vendor-warnings-image' },
      { type: 'valid-image', rows: 64, columns: 64 },
      { type: 'fake-signature' },
      { type: 'non-dicom' },
      { type: 'dicomdir' },
    ]
    expect(() => validateDatasetSpec({ entries })).not.toThrow()
  })

  it('accepts count on entries', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', count: 5 }] }),
    ).not.toThrow()
  })

  it('accepts a numeric seed', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image' }], seed: 42 }),
    ).not.toThrow()
  })

  it('accepts both transfer syntaxes', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'valid-image', transferSyntax: 'explicit-vr-little-endian' },
          { type: 'valid-image', transferSyntax: 'implicit-vr-little-endian' },
        ],
      }),
    ).not.toThrow()
  })

  it('accepts known keyword tag overrides', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          {
            type: 'valid-image',
            tags: { PatientID: 'P001', PatientName: 'DOE^JANE' },
          },
        ],
      }),
    ).not.toThrow()
  })

  it('accepts hex-tag overrides', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { '00081030': 'Protocol A' } }],
      }),
    ).not.toThrow()
  })

  it('accepts targetSizeKb on image types', () => {
    for (const type of [
      'valid-image',
      'invalid-uid-image',
      'vendor-warnings-image',
    ]) {
      expect(() =>
        validateDatasetSpec({ entries: [{ type, targetSizeKb: 100 }] }),
      ).not.toThrow()
    }
  })

  it('accepts all modality presets', () => {
    for (const modality of ['CT', 'PT', 'MR', 'CR']) {
      expect(() =>
        validateDatasetSpec({ entries: [{ type: 'valid-image', modality }] }),
      ).not.toThrow()
    }
  })

  it('accepts all violation classes', () => {
    const violations = [
      'uid-too-long',
      'non-conformant-uid',
      'missing-meta-header',
      'malformed-sq-delimiter',
      'vr-max-length-exceeded',
      'missing-type1-tag',
    ]
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', violations }] }),
    ).not.toThrow()
  })
})

describe('validateDatasetSpec — invalid inputs', () => {
  it('rejects non-object input', () => {
    expect(() => validateDatasetSpec('bad')).toThrow()
    expect(() => validateDatasetSpec(null)).toThrow()
    expect(() => validateDatasetSpec([])).toThrow()
  })

  it('rejects missing entries', () => {
    expect(() => validateDatasetSpec({})).toThrow(/entries/)
  })

  it('rejects empty entries array', () => {
    expect(() => validateDatasetSpec({ entries: [] })).toThrow(/empty/)
  })

  it('rejects unknown type', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'mri-scan' }] }),
    ).toThrow(/type/)
  })

  it('rejects count: 0', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', count: 0 }] }),
    ).toThrow(/count/)
  })

  it('rejects non-integer count', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', count: 1.5 }] }),
    ).toThrow(/count/)
  })

  it('rejects invalid transfer syntax', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', transferSyntax: 'jpeg' }],
      }),
    ).toThrow(/transferSyntax/)
  })

  it('rejects lowercase tag key (likely typo)', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { patientid: 'P001' } }],
      }),
    ).toThrow(/tag key/)
  })

  it('rejects tag key with spaces', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: { 'Patient ID': 'P001' } }],
      }),
    ).toThrow(/tag key/)
  })

  it('rejects unknown violation class', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', violations: ['bad-violation'] }],
      }),
    ).toThrow(/violations/)
  })

  it('rejects columns without rows', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', columns: 64 }] }),
    ).toThrow(/rows and columns must be provided together/)
  })

  it('rejects valid-image with rows: 0', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', rows: 0, columns: 64 }],
      }),
    ).toThrow(/rows/)
  })

  it('rejects non-finite seed', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image' }],
        seed: Number.NaN,
      }),
    ).toThrow(/seed/)
  })

  it('rejects rows without columns', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', rows: 64 }] }),
    ).toThrow(/rows and columns must be provided together/)
  })

  it('rejects frames without rows and columns', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', frames: 10 }] }),
    ).toThrow(/rows and columns must be provided together/)
  })

  it('rejects targetSizeKb combined with dimensions', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'valid-image', targetSizeKb: 100, rows: 64, columns: 64 },
        ],
      }),
    ).toThrow(/one sizing mechanism/)
  })

  it('rejects non-positive targetSizeKb', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', targetSizeKb: 0 }],
      }),
    ).toThrow(/targetSizeKb/)
  })

  it('rejects targetSizeKb above the 512 MB limit', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', targetSizeKb: 512 * 1024 + 1 }],
      }),
    ).toThrow(/512 MB/)
  })

  it('rejects targetSizeKb on non-image types', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'non-dicom', targetSizeKb: 100 }],
      }),
    ).toThrow(/targetSizeKb: not supported/)
  })

  it('rejects valid-image with frames: 0', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', rows: 64, columns: 64, frames: 0 }],
      }),
    ).toThrow(/frames/)
  })

  it('rejects tags that is an array', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', tags: ['PatientID', 'P001'] }],
      }),
    ).toThrow(/tags/)
  })

  it('rejects violations that is a string instead of array', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', violations: 'uid-too-long' }],
      }),
    ).toThrow(/violations/)
  })

  it('rejects a non-object entry', () => {
    expect(() => validateDatasetSpec({ entries: ['valid-image'] })).toThrow()
  })

  it('rejects negative count', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-image', count: -1 }] }),
    ).toThrow(/count/)
  })

  it('rejects tags on fake-signature', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'fake-signature', tags: { PatientID: 'P001' } }],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects violations on fake-signature', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'fake-signature', violations: ['uid-too-long'] }],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects tags on non-dicom', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'non-dicom', tags: { PatientID: 'P001' } }],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects violations on dicomdir', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'dicomdir', violations: ['missing-meta-header'] }],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects transferSyntax on dicomdir', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'dicomdir', transferSyntax: 'explicit-vr-little-endian' },
        ],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects transferSyntax on fake-signature', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          {
            type: 'fake-signature',
            transferSyntax: 'explicit-vr-little-endian',
          },
        ],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects transferSyntax on non-dicom', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'non-dicom', transferSyntax: 'implicit-vr-little-endian' },
        ],
      }),
    ).toThrow(/not supported/)
  })

  it('rejects an unknown modality', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', modality: 'XA' }],
      }),
    ).toThrow(/modality: must be one of CT, PT, MR, CR/)
  })

  it('rejects modality on non-image types', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'non-dicom', modality: 'CT' }],
      }),
    ).toThrow(/modality: not supported/)
  })

  it('rejects valid-image where pixel data exceeds the 512 MB limit', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', rows: 65535, columns: 65535 }],
      }),
    ).toThrow(/512 MB/)
  })
})

describe('validateDatasetSpec — studies', () => {
  const minimalStudy = { series: [{ entries: [{ type: 'valid-image' }] }] }

  it('accepts a studies-only spec', () => {
    const spec = validateDatasetSpec({ studies: [minimalStudy] })
    expect(spec.studies).toHaveLength(1)
    expect(spec.entries).toBeUndefined()
  })

  it('accepts entries and studies together', () => {
    const spec = validateDatasetSpec({
      entries: [{ type: 'valid-image' }],
      studies: [minimalStudy],
    })
    expect(spec.entries).toHaveLength(1)
    expect(spec.studies).toHaveLength(1)
  })

  it('accepts study count and tags', () => {
    const spec = validateDatasetSpec({
      studies: [{ ...minimalStudy, count: 3, tags: { PatientID: 'P1' } }],
    })
    expect(spec.studies?.[0].count).toBe(3)
  })

  it('accepts layout values flat and hierarchical', () => {
    for (const layout of ['flat', 'hierarchical']) {
      expect(() =>
        validateDatasetSpec({ studies: [minimalStudy], layout }),
      ).not.toThrow()
    }
  })

  it('rejects a spec with neither entries nor studies', () => {
    expect(() => validateDatasetSpec({})).toThrow(
      /entries.*studies|studies.*entries/,
    )
    expect(() => validateDatasetSpec({ entries: [], studies: [] })).toThrow()
  })

  it('rejects non-array studies', () => {
    expect(() => validateDatasetSpec({ studies: {} })).toThrow(
      /must be an array/,
    )
  })

  it('rejects a study with empty series', () => {
    expect(() => validateDatasetSpec({ studies: [{ series: [] }] })).toThrow(
      /series: must be a non-empty array/,
    )
  })

  it('rejects a series with empty entries', () => {
    expect(() =>
      validateDatasetSpec({ studies: [{ series: [{ entries: [] }] }] }),
    ).toThrow(/entries: must be a non-empty array/)
  })

  it('rejects non-tag-capable types inside a series', () => {
    for (const type of ['fake-signature', 'non-dicom', 'dicomdir']) {
      expect(() =>
        validateDatasetSpec({
          studies: [{ series: [{ entries: [{ type }] }] }],
        }),
      ).toThrow(/cannot be used inside a series/)
    }
  })

  it('rejects invalid study count', () => {
    expect(() =>
      validateDatasetSpec({ studies: [{ ...minimalStudy, count: 0 }] }),
    ).toThrow(/count: must be a positive integer/)
  })

  it('rejects invalid tag keys on study and series tags', () => {
    expect(() =>
      validateDatasetSpec({
        studies: [{ ...minimalStudy, tags: { 'bad key': 'x' } }],
      }),
    ).toThrow(/invalid tag key/)
    expect(() =>
      validateDatasetSpec({
        studies: [
          {
            series: [
              { entries: [{ type: 'valid-image' }], tags: { 'bad key': 'x' } },
            ],
          },
        ],
      }),
    ).toThrow(/invalid tag key/)
  })

  it('rejects an unknown layout', () => {
    expect(() =>
      validateDatasetSpec({ studies: [minimalStudy], layout: 'nested' }),
    ).toThrow(/layout: must be one of flat, hierarchical/)
  })
})

const MB = 1024 * 1024
const GB = 1024 * MB

describe('validateDatasetSpec — large-image entry', () => {
  it('accepts a large-image with targetBytes in range', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-image', targetBytes: 600 * MB }],
      }),
    ).not.toThrow()
  })

  it('requires targetBytes', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'large-image' }] }),
    ).toThrow(/targetBytes.*required/)
  })

  it('rejects targetBytes at or below 512 MB', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-image', targetBytes: 512 * MB }],
      }),
    ).toThrow(/512 MB/)
  })

  it('rejects targetBytes above 50 GB', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-image', targetBytes: 51 * GB }],
      }),
    ).toThrow(/50 GB/)
  })

  it('rejects pixel-sizing fields on large-image', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'large-image', targetBytes: 600 * MB, targetSizeKb: 100 },
        ],
      }),
    ).toThrow(/not supported for type "large-image"/)
  })

  it('rejects targetBytes on a normal image type', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', targetBytes: 600 * MB }],
      }),
    ).toThrow(/only supported for type "large-image"/)
  })

  it('allows large-image inside a series', () => {
    expect(() =>
      validateDatasetSpec({
        studies: [
          {
            series: [
              { entries: [{ type: 'large-image', targetBytes: 600 * MB }] },
            ],
          },
        ],
      }),
    ).not.toThrow()
  })
})
