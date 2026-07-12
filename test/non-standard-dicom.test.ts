import { describe, expect, it } from 'vitest'
import {
  buildDicomdirBuffer,
  DICOMDIR_SOP_CLASS_UID,
} from '../src/nonStandardDicom/dicomdir'
import { ascii } from './helpers/dicom'

describe('buildDicomdirBuffer', () => {
  it('returns a Uint8Array', () => {
    const buf = buildDicomdirBuffer()
    expect(buf).toBeInstanceOf(Uint8Array)
  })

  it('has a valid DICM signature at offset 128', () => {
    const buf = buildDicomdirBuffer()
    expect(ascii(buf.subarray(128, 132))).toBe('DICM')
  })

  it('encodes MediaStorageSOPClassUID as DICOMDIR UID', () => {
    const buf = buildDicomdirBuffer()
    // Value starts at offset 140 (132 + 2+2+2+2)
    const uid = ascii(buf.subarray(140, 140 + DICOMDIR_SOP_CLASS_UID.length))
    expect(uid).toBe(DICOMDIR_SOP_CLASS_UID)
  })

  it('is deterministic', () => {
    const a = buildDicomdirBuffer()
    const b = buildDicomdirBuffer()
    expect(Buffer.compare(a, b)).toBe(0)
  })
})
