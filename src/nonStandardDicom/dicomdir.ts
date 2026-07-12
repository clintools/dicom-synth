import { utf8Bytes } from '../platform/bytes.js'

export const DICOMDIR_SOP_CLASS_UID = '1.2.840.10008.1.3.10'

/**
 * Build a minimal DICOM Part 10 buffer whose MediaStorageSOPClassUID
 * identifies it as a DICOMDIR (1.2.840.10008.1.3.10).
 *
 * The file has a valid DICM signature and a single meta tag (0002,0002)
 * so it passes signature checks but is detectable by SOP class UID.
 * dcmjs cannot write DICOMDIR, so this uses a raw byte layout.
 */
export function buildDicomdirBuffer(): Uint8Array {
  const uid = DICOMDIR_SOP_CLASS_UID // 20 chars, already even length
  const buf = new Uint8Array(256)
  const view = new DataView(buf.buffer)

  // 128-byte preamble (zeros) + DICM signature
  buf.set(utf8Bytes('DICM'), 128)

  // Tag (0002,0002) MediaStorageSOPClassUID — explicit VR short form
  // group(2) + element(2) + VR(2) + length(2) + value(N)
  let off = 132
  view.setUint16(off, 0x0002, true)
  off += 2
  view.setUint16(off, 0x0002, true)
  off += 2
  buf.set(utf8Bytes('UI'), off)
  off += 2
  view.setUint16(off, uid.length, true)
  off += 2
  buf.set(utf8Bytes(uid), off)
  off += uid.length

  return buf.subarray(0, off)
}
