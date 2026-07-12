// Portable randomness via globalThis.crypto.getRandomValues (Node >= 20 and
// browsers) — node:crypto is unavailable in browser bundles.

import { bytesToHex } from './bytes.js'

export function randomUint32(): number {
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] as number
}

export function randomHex(byteLength: number): string {
  return bytesToHex(
    globalThis.crypto.getRandomValues(new Uint8Array(byteLength)),
  )
}
