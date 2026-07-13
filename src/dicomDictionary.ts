import { dcmjs } from './loadDcmjs.js'

const nameMap = (
  dcmjs as unknown as {
    data?: {
      DicomMetaDictionary?: { nameMap?: Record<string, { tag?: string }> }
    }
  }
).data?.DicomMetaDictionary?.nameMap

// Reverse of dcmjs's keyword→tag dictionary: 8-hex-char tag (e.g. "00080060")
// → DICOM keyword. Callers use it to resolve the raw hex tag escape hatch and
// keep-tag hex entries back to keywords. Callers cache the result themselves.
export function buildHexToKeyword(): Map<string, string> {
  const map = new Map<string, string>()
  if (!nameMap) return map
  for (const [keyword, info] of Object.entries(nameMap)) {
    if (info?.tag) {
      const hex = info.tag.replace(/[(,)]/g, '').toUpperCase()
      if (hex.length === 8) map.set(hex, keyword)
    }
  }
  return map
}
