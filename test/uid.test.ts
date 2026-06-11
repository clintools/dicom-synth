import { describe, expect, it } from 'vitest'
import type { UidSet } from '../src/syntheticFixtures/uid'
import {
  makeGroupUidGenerator,
  makeUidGenerator,
} from '../src/syntheticFixtures/uid'

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

describe('makeGroupUidGenerator — seeded', () => {
  it('same seed produces identical study/series UIDs', () => {
    const a = makeGroupUidGenerator(42)
    const b = makeGroupUidGenerator(42)
    expect(a.study(0)).toBe(b.study(0))
    expect(a.series(0, 1)).toBe(b.series(0, 1))
  })

  it('different study indices produce different study UIDs', () => {
    const gen = makeGroupUidGenerator(42)
    expect(gen.study(0)).not.toBe(gen.study(1))
  })

  it('different series indices produce different series UIDs', () => {
    const gen = makeGroupUidGenerator(42)
    expect(gen.series(0, 0)).not.toBe(gen.series(0, 1))
    expect(gen.series(0, 0)).not.toBe(gen.series(1, 0))
  })

  it('group study UID differs from per-file study UID at the same index', () => {
    const group = makeGroupUidGenerator(42)
    const perFile = makeUidGenerator(42)
    expect(group.study(0)).not.toBe(perFile(0).study)
    expect(group.study(1)).not.toBe(perFile(1).study)
  })

  it('UIDs are well-formed (prefix, length, role suffix)', () => {
    const gen = makeGroupUidGenerator(7)
    expect(gen.study(3)).toMatch(/^2\.25\.\d+\.\d+\.1$/)
    expect(gen.series(3, 2)).toMatch(/^2\.25\.\d+\.\d+\.2$/)
    expect(gen.study(3).length).toBeLessThanOrEqual(64)
  })
})

describe('makeGroupUidGenerator — unseeded', () => {
  it('successive calls produce different UIDs (random)', () => {
    const gen = makeGroupUidGenerator()
    expect(gen.study(0)).not.toBe(gen.study(0))
    expect(gen.series(0, 0)).not.toBe(gen.series(0, 0))
  })
})
