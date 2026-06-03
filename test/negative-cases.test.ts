import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  writeFakeDicomSignatureFile,
  writeNonDicomFile,
} from '../src/negativeCases/index'

describe('writeFakeDicomSignatureFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'neg-cases-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a file of 200 bytes', () => {
    const filePath = join(tmpDir, 'fake.dcm')
    writeFakeDicomSignatureFile(filePath)
    const buf = readFileSync(filePath)
    expect(buf.length).toBe(200)
  })

  it('has XXXX at offset 128 instead of DICM', () => {
    const filePath = join(tmpDir, 'fake.dcm')
    writeFakeDicomSignatureFile(filePath)
    const buf = readFileSync(filePath)
    expect(buf.subarray(128, 132).toString('ascii')).toBe('XXXX')
  })

  it('creates parent directories as needed', () => {
    const filePath = join(tmpDir, 'nested', 'fake.dcm')
    expect(() => writeFakeDicomSignatureFile(filePath)).not.toThrow()
    expect(readFileSync(filePath).length).toBe(200)
  })
})

describe('writeNonDicomFile', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'neg-cases-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes default content when none supplied', () => {
    const filePath = join(tmpDir, 'not-a-dicom.txt')
    writeNonDicomFile(filePath)
    expect(readFileSync(filePath, 'utf8')).toBe('not dicom')
  })

  it('writes custom content', () => {
    const filePath = join(tmpDir, 'custom.txt')
    writeNonDicomFile(filePath, 'hello world')
    expect(readFileSync(filePath, 'utf8')).toBe('hello world')
  })

  it('creates parent directories as needed', () => {
    const filePath = join(tmpDir, 'nested', 'deep', 'file.txt')
    expect(() => writeNonDicomFile(filePath)).not.toThrow()
    expect(readFileSync(filePath, 'utf8')).toBe('not dicom')
  })
})
