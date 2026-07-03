import { describe, expect, it } from 'vitest'
import {
  generateCollectionFromSpec,
  withResolvedSalt,
} from '../src/collection/writer'
import type { DatasetSpec } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'
import { parseNatural } from './helpers/dicom'

async function studyUids(spec: DatasetSpec): Promise<string[]> {
  const uids: string[] = []
  for await (const f of generateCollectionFromSpec(spec)) {
    uids.push(parseNatural(f.buffer).StudyInstanceUID as string)
  }
  return uids
}

const base: DatasetSpec = {
  seed: 1,
  studies: [{ series: [{ entries: [{ type: 'valid-image', count: 2 }] }] }],
}

describe('uidSalt', () => {
  it('same salt → identical UIDs', async () => {
    const a = await studyUids({ ...base, uidSalt: 'abc' })
    const b = await studyUids({ ...base, uidSalt: 'abc' })
    expect(a).toEqual(b)
  })

  it('different salt, same seed → disjoint UIDs (cross-dataset uniqueness)', async () => {
    const a = await studyUids({ ...base, uidSalt: 'abc' })
    const b = await studyUids({ ...base, uidSalt: 'xyz' })
    expect(a[0]).not.toBe(b[0])
  })

  it('uidSalt wins over the seed-derived salt', async () => {
    const salted = await studyUids({ ...base, uidSalt: 'abc' })
    const seedOnly = await studyUids(base)
    expect(salted[0]).not.toBe(seedOnly[0])
  })

  it('seed alone stays deterministic (bridged to a salt)', async () => {
    const a = await studyUids(base)
    const b = await studyUids(base)
    expect(a).toEqual(b)
  })

  it('UIDs are conformant 2.25.<int> within the 64-char limit', async () => {
    for (const uid of await studyUids({ ...base, uidSalt: 'abc' })) {
      expect(uid).toMatch(/^2\.25\.[1-9][0-9]*$/)
      expect(uid.length).toBeLessThanOrEqual(64)
    }
  })
})

describe('withResolvedSalt', () => {
  it('draws a salt when absent and is reproducible from the captured spec', async () => {
    const spec: DatasetSpec = {
      studies: [{ series: [{ entries: [{ type: 'valid-image' }] }] }],
    }
    const captured = withResolvedSalt(spec)
    expect(captured.uidSalt).toMatch(/^[0-9a-f]{32}$/)
    // Re-running from the captured spec reproduces the same UIDs.
    expect(await studyUids(captured)).toEqual(await studyUids(captured))
  })

  it('leaves an existing salt untouched', () => {
    expect(withResolvedSalt({ ...base, uidSalt: 'keep' }).uidSalt).toBe('keep')
  })
})

describe('validateDatasetSpec — uidSalt', () => {
  it('accepts a non-empty string', () => {
    expect(() => validateDatasetSpec({ ...base, uidSalt: 'abc' })).not.toThrow()
  })

  it('rejects an empty string', () => {
    expect(() => validateDatasetSpec({ ...base, uidSalt: '' })).toThrow(
      /uidSalt/,
    )
  })

  it('rejects a non-string', () => {
    expect(() => validateDatasetSpec({ ...base, uidSalt: 123 })).toThrow(
      /uidSalt/,
    )
  })
})
