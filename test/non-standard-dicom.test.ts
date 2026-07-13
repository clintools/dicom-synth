import { describe, expect, it } from 'vitest'
import {
  buildDicomdirBuffer,
  DICOMDIR_SOP_CLASS_UID,
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
