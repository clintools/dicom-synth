import { describe, expect, it } from 'vitest'
import type { UidSet } from '../src/syntheticFixtures/uid'
import {
  hashUid,
  makeGroupUidGenerator,
  makeUidGenerator,
  seedToSalt,
} from '../src/syntheticFixtures/uid'

const UID_RE = /^2\.25\.[1-9][0-9]*$/

function assertWellFormed({ study, series, sop }: UidSet): void {
  for (const uid of [study, series, sop]) {
    expect(uid).toMatch(UID_RE)
    expect(uid.length).toBeLessThanOrEqual(64)
  }
}

describe('hashUid', () => {
  it('is a conformant 2.25.<int> UID within the 64-char limit', () => {
    const uid = hashUid('salt', 'sop:0')
    expect(uid).toMatch(UID_RE)
    expect(uid.length).toBeLessThanOrEqual(64)
  })

  it('is deterministic for the same (salt, key)', () => {
    expect(hashUid('s', 'k')).toBe(hashUid('s', 'k'))
  })

  it('differs for a different salt or key', () => {
    expect(hashUid('s1', 'k')).not.toBe(hashUid('s2', 'k'))
    expect(hashUid('s', 'k1')).not.toBe(hashUid('s', 'k2'))
  })
})

describe('seedToSalt', () => {
  it('maps a numeric seed to a stable salt string', () => {
    expect(seedToSalt(1)).toBe('seed:1')
    expect(seedToSalt(1)).toBe(seedToSalt(1))
    expect(seedToSalt(1)).not.toBe(seedToSalt(2))
  })

  it('returns undefined for a seedless spec', () => {
    expect(seedToSalt(undefined)).toBeUndefined()
  })
})

describe('makeUidGenerator — saltless', () => {
  it('returns a UidSet with study, series, and sop fields', () => {
    const uids = makeUidGenerator()(0)
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
    expect(gen(0).sop).not.toBe(gen(0).sop)
  })

  it('UIDs are well-formed (prefix, length)', () => {
    assertWellFormed(makeUidGenerator()(0))
  })
})

describe('makeUidGenerator — salted', () => {
  it('same salt + same index produces identical UIDs', () => {
    const a = makeUidGenerator('salt')(0)
    const b = makeUidGenerator('salt')(0)
    expect(a.study).toBe(b.study)
    expect(a.series).toBe(b.series)
    expect(a.sop).toBe(b.sop)
  })

  it('same salt + different index produces different UIDs', () => {
    const gen = makeUidGenerator('salt')
    expect(gen(0).sop).not.toBe(gen(1).sop)
  })

  it('different salts produce different UIDs at the same index', () => {
    expect(makeUidGenerator('a')(0).sop).not.toBe(makeUidGenerator('b')(0).sop)
  })

  it('UIDs are well-formed (prefix, length)', () => {
    assertWellFormed(makeUidGenerator('salt')(5))
  })

  it('no UID component has a leading zero (DICOM PS 3.5 §9.1)', () => {
    const componentRe = /^(0|[1-9][0-9]*)$/
    for (const salt of ['a', 'seed:0', 'seed:65535', 'x'.repeat(32)]) {
      for (const index of [0, 1, 10, 100]) {
        const { study, series, sop } = makeUidGenerator(salt)(index)
        for (const uid of [study, series, sop]) {
          for (const component of uid.split('.')) {
            expect(component).toMatch(componentRe)
          }
        }
      }
    }
  })

  it('study, series, and sop UIDs are distinct', () => {
    const { study, series, sop } = makeUidGenerator('salt')(0)
    expect(study).not.toBe(series)
    expect(study).not.toBe(sop)
    expect(series).not.toBe(sop)
  })
})

describe('makeGroupUidGenerator — salted', () => {
  it('same salt produces identical study/series UIDs', () => {
    const a = makeGroupUidGenerator('salt')
    const b = makeGroupUidGenerator('salt')
    expect(a.study(0)).toBe(b.study(0))
    expect(a.series(0, 1)).toBe(b.series(0, 1))
  })

  it('different study indices produce different study UIDs', () => {
    const gen = makeGroupUidGenerator('salt')
    expect(gen.study(0)).not.toBe(gen.study(1))
  })

  it('different series indices produce different series UIDs', () => {
    const gen = makeGroupUidGenerator('salt')
    expect(gen.series(0, 0)).not.toBe(gen.series(0, 1))
    expect(gen.series(0, 0)).not.toBe(gen.series(1, 0))
  })

  it('group study UID differs from per-file study UID at the same index', () => {
    const group = makeGroupUidGenerator('salt')
    const perFile = makeUidGenerator('salt')
    expect(group.study(0)).not.toBe(perFile(0).study)
    expect(group.study(1)).not.toBe(perFile(1).study)
  })

  it('UIDs are well-formed (prefix, length)', () => {
    const gen = makeGroupUidGenerator('salt')
    expect(gen.study(3)).toMatch(UID_RE)
    expect(gen.series(3, 2)).toMatch(UID_RE)
    expect(gen.study(3).length).toBeLessThanOrEqual(64)
  })
})

describe('makeGroupUidGenerator — saltless', () => {
  it('successive calls produce different UIDs (random)', () => {
    const gen = makeGroupUidGenerator()
    expect(gen.study(0)).not.toBe(gen.study(0))
    expect(gen.series(0, 0)).not.toBe(gen.series(0, 0))
  })
})
