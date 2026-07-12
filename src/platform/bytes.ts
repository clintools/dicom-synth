// Byte-level helpers shared by the browser-safe generation path, which cannot
// use node:buffer.

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

// `length` bytes of `pattern` repeated (truncated at the end) — the
// Buffer.alloc(length, pattern) fill, doubled with copyWithin so half-GB
// placeholder payloads stay O(log n) copies.
export function patternBytes(length: number, pattern: string): Uint8Array {
  const out = new Uint8Array(length)
  const seed = utf8Bytes(pattern)
  if (length === 0 || seed.length === 0) return out
  out.set(seed.subarray(0, Math.min(seed.length, length)))
  let filled = Math.min(seed.length, length)
  while (filled < length) {
    const chunk = Math.min(filled, length - filled)
    out.copyWithin(filled, 0, chunk)
    filled += chunk
  }
  return out
}
