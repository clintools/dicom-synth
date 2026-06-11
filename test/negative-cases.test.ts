import { describe, expect, it } from 'vitest'
import { generateFile } from '../src/collection/writer'

describe('generateFile — fake-signature', () => {
  it('produces a 200-byte buffer', async () => {
    const { buffer } = await generateFile({ type: 'fake-signature' })
    expect(buffer.length).toBe(200)
  })

  it('has XXXX at offset 128 instead of DICM', async () => {
    const { buffer } = await generateFile({ type: 'fake-signature' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('XXXX')
  })

  it('filename has no extension', async () => {
    const { filename } = await generateFile({ type: 'fake-signature' })
    expect(filename).not.toMatch(/\.\w+$/)
    expect(filename).toMatch(/^fake-signature-/)
  })
})
