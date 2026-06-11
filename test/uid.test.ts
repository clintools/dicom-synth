import { describe, expect, it } from 'vitest'
import type { UidSet } from '../src/syntheticFixtures/uid'
import { makeUidGenerator } from '../src/syntheticFixtures/uid'

function assertWellFormed({ study, series, sop }: UidSet): void {
  for (const uid of [study, series, sop]) {
    expect(uid).toMatch(/^2\.25\./)
    expect(uid.length).toBeLessThanOrEqual(64)
  }
}

describe('makeUidGenerator — unseeded', () => {
  it('returns a UidSet with study, series, and sop fields', () => {
    const gen = makeUidGenerator()
    const uids = gen(0)
    expect(uids).toHaveProperty('study')
    expect(uids).toHaveProperty('series')
    expect(uids).toHaveProperty('sop')
  })

  it('study, series, and sop UIDs are distinct', () => {
    const { study, series, sop } = makeUidGenerator()(0)
    expect(study).not.toBe(series)
    expect(study).not.toBe(sop)
    expect(series).not.toBe(sop)
  })

  it('produces different UIDs on successive calls (random)', () => {
    const gen = makeUidGenerator()
    const a = gen(0)
    const b = gen(0)
    // Two unseeded calls at the same index should differ
    expect(a.sop).not.toBe(b.sop)
  })

  it('UIDs are well-formed (prefix, length)', () => {
    assertWellFormed(makeUidGenerator()(0))
  })
})

describe('makeUidGenerator — seeded', () => {
  it('same seed + same index produces identical UIDs', () => {
    const a = makeUidGenerator(42)(0)
    const b = makeUidGenerator(42)(0)
    expect(a.study).toBe(b.study)
    expect(a.series).toBe(b.series)
    expect(a.sop).toBe(b.sop)
  })

  it('same seed + different index produces different UIDs', () => {
    const gen = makeUidGenerator(42)
    const a = gen(0)
    const b = gen(1)
    expect(a.sop).not.toBe(b.sop)
  })

  it('different seeds produce different UIDs at the same index', () => {
    const a = makeUidGenerator(1)(0)
    const b = makeUidGenerator(2)(0)
    expect(a.sop).not.toBe(b.sop)
  })

  it('UIDs are well-formed (prefix, length)', () => {
    assertWellFormed(makeUidGenerator(99)(5))
  })

  it('no UID component has a leading zero (DICOM PS 3.5 §9.1)', () => {
    // Check across multiple seeds and indices to cover the ~23% of values that
    // previously produced leading zeros via padStart.
    const componentRe = /^(0|[1-9][0-9]*)$/
    for (const seed of [0, 1, 42, 999, 65535]) {
      for (const index of [0, 1, 10, 100]) {
        const { study, series, sop } = makeUidGenerator(seed)(index)
        for (const uid of [study, series, sop]) {
          for (const component of uid.split('.')) {
            expect(component).toMatch(componentRe)
          }
        }
      }
    }
  })

  it('study, series, and sop UIDs are distinct', () => {
    const { study, series, sop } = makeUidGenerator(42)(0)
    expect(study).not.toBe(series)
    expect(study).not.toBe(sop)
    expect(series).not.toBe(sop)
  })
})
