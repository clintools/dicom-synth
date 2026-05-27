import { describe, expect, it } from 'vitest'
import {
  buildSyntheticCtBuffer,
  SYNTHETIC_FIXTURES,
} from '../src/syntheticFixtures/generator'

describe('synthetic CT fixtures', () => {
  it('exposes three fixture definitions', () => {
    expect(SYNTHETIC_FIXTURES).toHaveLength(3)
  })

  for (const { variant, filename } of SYNTHETIC_FIXTURES) {
    it(`builds non-empty buffer for ${filename}`, () => {
      const buf = buildSyntheticCtBuffer(variant)
      expect(buf.length).toBeGreaterThan(128)
      expect(buf.subarray(128, 132).toString('ascii')).toBe('DICM')
    })
  }

  it('is deterministic for the same variant', () => {
    const a = buildSyntheticCtBuffer('valid-uid')
    const b = buildSyntheticCtBuffer('valid-uid')
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('differs across variants', () => {
    const invalid = buildSyntheticCtBuffer('minimal-invalid-uid')
    const valid = buildSyntheticCtBuffer('valid-uid')
    expect(Buffer.compare(invalid, valid)).not.toBe(0)
  })
})
