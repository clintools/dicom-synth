import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  caseCachePath,
  defaultPublicCasesPath,
  fetchPublicCaseToCache,
  loadCaseById,
  loadDefaultCases,
  verifySha256,
} from '../src'

describe('public corpus catalog', () => {
  it('loads default cases from bundled catalog', () => {
    const cases = loadDefaultCases()
    expect(cases.length).toBeGreaterThanOrEqual(2)
    expect(cases.some((c) => c.id === 'pydicom-CT-small')).toBe(true)
  })

  it('loadCaseById returns a known case', () => {
    const rec = loadCaseById(defaultPublicCasesPath(), 'pydicom-CT-small')
    expect(rec.sha256).toHaveLength(64)
    expect(rec.source.kind).toBe('url')
  })

  it('loadCaseById throws for unknown id', () => {
    expect(() =>
      loadCaseById(defaultPublicCasesPath(), 'does-not-exist'),
    ).toThrow(/Unknown case id/)
  })

  it('caseCachePath is stable under a custom root', () => {
    const sha = 'a'.repeat(64)
    const p1 = caseCachePath(sha, '/tmp/cache')
    const p2 = caseCachePath(sha, '/tmp/cache')
    expect(p1).toBe(p2)
    expect(p1).toContain(sha)
  })
})

describe('verifySha256', () => {
  it('passes when hash matches', () => {
    const buf = Buffer.from('hello')
    const hash = createHash('sha256').update(buf).digest('hex')
    expect(() => verifySha256(buf, hash)).not.toThrow()
  })

  it('throws when hash mismatches', () => {
    const buf = Buffer.from('hello')
    expect(() => verifySha256(buf, '0'.repeat(64))).toThrow(/SHA256 mismatch/)
  })
})

describe('fetchPublicCaseToCache', () => {
  it('writes and reuses cache without refetch', async () => {
    const record = loadCaseById(defaultPublicCasesPath(), 'pydicom-CT-small')
    const cacheRoot = await mkdtemp(join(tmpdir(), 'dc-synth-fetch-'))

    const body = Buffer.from('fake-dicom-bytes')
    const sha = createHash('sha256').update(body).digest('hex')
    const testRecord = { ...record, sha256: sha }

    let fetchCount = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      fetchCount += 1
      return new Response(body, { status: 200 })
    }

    try {
      const path1 = await fetchPublicCaseToCache(testRecord, cacheRoot)
      const path2 = await fetchPublicCaseToCache(testRecord, cacheRoot)
      expect(path1).toBe(path2)
      expect(fetchCount).toBe(1)
      expect(readFileSync(path1).equals(body)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })

  it('throws on HTTP error', async () => {
    const record = loadCaseById(defaultPublicCasesPath(), 'pydicom-CT-small')
    const cacheRoot = await mkdtemp(join(tmpdir(), 'dc-synth-fetch-err-'))
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => new Response('', { status: 404 })

    try {
      await expect(fetchPublicCaseToCache(record, cacheRoot)).rejects.toThrow(
        /Fetch failed 404/,
      )
    } finally {
      globalThis.fetch = originalFetch
      await rm(cacheRoot, { recursive: true, force: true })
    }
  })
})
