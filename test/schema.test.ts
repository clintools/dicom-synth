import { describe, expect, it } from 'vitest'
import { validateDatasetSpec } from '../src/schema/validate'

describe('validateDatasetSpec — valid inputs', () => {
  it('accepts a minimal valid spec', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-ct' }] }),
    ).not.toThrow()
  })

  it('accepts all fixture types', () => {
    const entries = [
      { type: 'valid-ct' },
      { type: 'invalid-uid-ct' },
      { type: 'vendor-warnings-ct' },
      { type: 'large-ct', rows: 64, columns: 64 },
      { type: 'fake-signature' },
      { type: 'non-dicom' },
      { type: 'dicomdir' },
    ]
    expect(() => validateDatasetSpec({ entries })).not.toThrow()
  })

  it('accepts count on entries', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-ct', count: 5 }] }),
    ).not.toThrow()
  })

  it('accepts a numeric seed', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-ct' }], seed: 42 }),
    ).not.toThrow()
  })

  it('accepts both transfer syntaxes', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          { type: 'valid-ct', transferSyntax: 'explicit-vr-little-endian' },
          { type: 'valid-ct', transferSyntax: 'implicit-vr-little-endian' },
        ],
      }),
    ).not.toThrow()
  })

  it('accepts known keyword tag overrides', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [
          {
            type: 'valid-ct',
            tags: { PatientID: 'P001', PatientName: 'DOE^JANE' },
          },
        ],
      }),
    ).not.toThrow()
  })

  it('accepts hex-tag overrides', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', tags: { '00081030': 'Protocol A' } }],
      }),
    ).not.toThrow()
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
      validateDatasetSpec({ entries: [{ type: 'valid-ct', violations }] }),
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
      validateDatasetSpec({ entries: [{ type: 'valid-ct', count: 0 }] }),
    ).toThrow(/count/)
  })

  it('rejects non-integer count', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-ct', count: 1.5 }] }),
    ).toThrow(/count/)
  })

  it('rejects invalid transfer syntax', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', transferSyntax: 'jpeg' }],
      }),
    ).toThrow(/transferSyntax/)
  })

  it('rejects lowercase tag key (likely typo)', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', tags: { patientid: 'P001' } }],
      }),
    ).toThrow(/tag key/)
  })

  it('rejects tag key with spaces', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', tags: { 'Patient ID': 'P001' } }],
      }),
    ).toThrow(/tag key/)
  })

  it('rejects unknown violation class', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', violations: ['bad-violation'] }],
      }),
    ).toThrow(/violations/)
  })

  it('rejects large-ct missing required rows', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'large-ct', columns: 64 }] }),
    ).toThrow(/rows/)
  })

  it('rejects large-ct with rows: 0', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-ct', rows: 0, columns: 64 }],
      }),
    ).toThrow(/rows/)
  })

  it('rejects non-finite seed', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct' }],
        seed: Number.NaN,
      }),
    ).toThrow(/seed/)
  })

  it('rejects large-ct missing columns', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'large-ct', rows: 64 }] }),
    ).toThrow(/columns/)
  })

  it('rejects large-ct with frames: 0', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-ct', rows: 64, columns: 64, frames: 0 }],
      }),
    ).toThrow(/frames/)
  })

  it('rejects tags that is an array', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', tags: ['PatientID', 'P001'] }],
      }),
    ).toThrow(/tags/)
  })

  it('rejects violations that is a string instead of array', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-ct', violations: 'uid-too-long' }],
      }),
    ).toThrow(/violations/)
  })

  it('rejects a non-object entry', () => {
    expect(() => validateDatasetSpec({ entries: ['valid-ct'] })).toThrow()
  })

  it('rejects negative count', () => {
    expect(() =>
      validateDatasetSpec({ entries: [{ type: 'valid-ct', count: -1 }] }),
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

  it('rejects large-ct where pixel data exceeds the 512 MB limit', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'large-ct', rows: 65535, columns: 65535 }],
      }),
    ).toThrow(/512 MB/)
  })
})
