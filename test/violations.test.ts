import { describe, expect, it, vi } from 'vitest'
import { generateFile } from '../src/collection/writer'
import type { ViolationClass } from '../src/schema/types'
import { applyViolations } from '../src/syntheticFixtures/violations'

// Generate a base valid-image buffer to use as the input for violation tests.
async function baseBuffer() {
  return (await generateFile({ type: 'valid-image' })).buffer
}

describe('violations — smoke', () => {
  it.each([
    'uid-too-long',
    'non-conformant-uid',
    'vr-max-length-exceeded',
    'missing-type1-tag',
  ] as const satisfies ViolationClass[])('%s alters the buffer', async (violation) => {
    const opts = { seed: 42 }
    const { buffer: clean } = await generateFile({ type: 'valid-image' }, opts)
    const { buffer: violated } = await generateFile(
      { type: 'valid-image', violations: [violation] },
      opts,
    )
    expect(Buffer.compare(clean, violated)).not.toBe(0)
  })
})

describe('violations — uid-too-long', () => {
  it('still has a DICM signature', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      violations: ['uid-too-long'],
    })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('writes a 65-char SOPInstanceUID — not truncated to the legal 64', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      violations: ['uid-too-long'],
    })
    // dcmjs denaturalizeDataset truncates UI values to 64 chars; a truncated
    // UID would end after 59 zeros, so requiring all 60 proves it survived.
    expect(buffer.toString('binary')).toContain(`2.25.${'0'.repeat(60)}`)
  })
})

describe('violations — non-conformant-uid', () => {
  it('injects a UID with a leading-zero component (not alphabetic chars)', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      violations: ['non-conformant-uid'],
    })
    // '2.25.01.' is present: the '01' component has a leading zero
    expect(buffer.toString('binary')).toContain('2.25.01.')
  })
})

describe('violations — missing-meta-header', () => {
  it('produces a shorter buffer (preamble + DICM stripped)', async () => {
    const original = await baseBuffer()
    const violated = applyViolations(original, ['missing-meta-header'])
    expect(violated.length).toBe(original.length - 132)
  })

  it('does not start with DICM', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      violations: ['missing-meta-header'],
    })
    expect(buffer.subarray(0, 4).toString('ascii')).not.toBe('DICM')
  })
})

describe('violations — malformed-sq-delimiter', () => {
  it('produces a longer buffer (delimiter appended)', async () => {
    const original = await baseBuffer()
    const violated = applyViolations(original, ['malformed-sq-delimiter'])
    expect(violated.length).toBe(original.length + 8)
  })
})

describe('violations — combinations', () => {
  it('applies tag-level violations before byte-level (missing-meta-header last)', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      violations: ['uid-too-long', 'missing-meta-header'],
    })
    // After stripping preamble, buffer should not start with DICM
    expect(buffer.subarray(0, 4).toString('ascii')).not.toBe('DICM')
  })
})

describe('violations — edge cases', () => {
  it('empty violations array returns the original buffer unchanged', async () => {
    const original = await baseBuffer()
    const result = applyViolations(original, [])
    expect(Buffer.compare(result, original)).toBe(0)
  })

  it('tag-level violation on an unparseable buffer warns and returns original', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // fake-signature buffer has no DICM magic — dcmjs cannot parse it
    const unparseable = (await generateFile({ type: 'fake-signature' })).buffer
    const result = applyViolations(unparseable, ['uid-too-long'])
    expect(Buffer.compare(result, unparseable)).toBe(0)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not parse'),
    )
    warn.mockRestore()
  })
})
