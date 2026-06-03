import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildDicomdirBuffer,
  DICOMDIR_SOP_CLASS_UID,
  writeDicomdirFile,
} from '../src/nonStandardDicom/dicomdir'

describe('buildDicomdirBuffer', () => {
  it('returns a Buffer', () => {
    const buf = buildDicomdirBuffer()
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  it('has a valid DICM signature at offset 128', () => {
    const buf = buildDicomdirBuffer()
    expect(buf.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('encodes MediaStorageSOPClassUID as DICOMDIR UID', () => {
    const buf = buildDicomdirBuffer()
    // Value starts at offset 140 (132 + 2+2+2+2)
    const uid = buf
      .subarray(140, 140 + DICOMDIR_SOP_CLASS_UID.length)
      .toString('ascii')
    expect(uid).toBe(DICOMDIR_SOP_CLASS_UID)
  })

  it('is deterministic', () => {
    const a = buildDicomdirBuffer()
    const b = buildDicomdirBuffer()
    expect(Buffer.compare(a, b)).toBe(0)
  })
})

describe('writeDicomdirFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'dicomdir-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a file whose bytes match buildDicomdirBuffer', () => {
    const filePath = join(tmpDir, 'DICOMDIR')
    writeDicomdirFile(filePath)
    const written = readFileSync(filePath)
    expect(Buffer.compare(written, buildDicomdirBuffer())).toBe(0)
  })

  it('creates parent directories as needed', () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'DICOMDIR')
    expect(() => writeDicomdirFile(filePath)).not.toThrow()
    const written = readFileSync(filePath)
    expect(written.length).toBeGreaterThan(0)
  })
})
