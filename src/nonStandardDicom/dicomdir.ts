export const DICOMDIR_SOP_CLASS_UID = '1.2.840.10008.1.3.10'

/**
 * Build a minimal DICOM Part 10 buffer whose MediaStorageSOPClassUID
 * identifies it as a DICOMDIR (1.2.840.10008.1.3.10).
 *
 * The file has a valid DICM signature and a single meta tag (0002,0002)
 * so it passes signature checks but is detectable by SOP class UID.
 * dcmjs cannot write DICOMDIR, so this uses a raw byte layout.
 */
export function buildDicomdirBuffer(): Buffer {
  const uid = DICOMDIR_SOP_CLASS_UID // 20 chars, already even length
  const buf = Buffer.alloc(256, 0)

  // 128-byte preamble (zeros) + DICM signature
  buf.write('DICM', 128, 4, 'ascii')

  // Tag (0002,0002) MediaStorageSOPClassUID — explicit VR short form
  // group(2) + element(2) + VR(2) + length(2) + value(N)
  let off = 132
  buf.writeUInt16LE(0x0002, off)
  off += 2
  buf.writeUInt16LE(0x0002, off)
  off += 2
  buf.write('UI', off, 2, 'ascii')
  off += 2
  buf.writeUInt16LE(uid.length, off)
  off += 2
  buf.write(uid, off, uid.length, 'ascii')
  off += uid.length

  return buf.subarray(0, off)
}
