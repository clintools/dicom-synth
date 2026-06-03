import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildSyntheticCtBuffer,
  SYNTHETIC_FIXTURES,
  writeMinimalDicomFile,
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

describe('writeMinimalDicomFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'minimal-dicom-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a file with a valid DICM signature', () => {
    const filePath = join(tmpDir, 'minimal.dcm')
    writeMinimalDicomFile(filePath)
    const buf = readFileSync(filePath)
    expect(buf.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('produces a file larger than a bare 200-byte allocation', () => {
    const filePath = join(tmpDir, 'minimal.dcm')
    writeMinimalDicomFile(filePath)
    expect(readFileSync(filePath).length).toBeGreaterThan(200)
  })

  it('accepts optional tag overrides', () => {
    const filePath = join(tmpDir, 'tagged.dcm')
    expect(() =>
      writeMinimalDicomFile(filePath, {
        patientId: 'PID-001',
        patientName: 'DOE^JOHN',
        sopInstanceUid: '1.2.3.4',
      }),
    ).not.toThrow()
    expect(readFileSync(filePath).length).toBeGreaterThan(132)
  })

  it('creates parent directories as needed', () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'minimal.dcm')
    expect(() => writeMinimalDicomFile(filePath)).not.toThrow()
    expect(readFileSync(filePath).length).toBeGreaterThan(0)
  })
})
