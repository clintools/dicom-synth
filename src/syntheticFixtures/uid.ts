import { randomBytes } from 'node:crypto'

// Role codes embedded in the UID suffix to guarantee study/series/sop uniqueness per file.
const ROLE_CODE = { study: 1, series: 2, sop: 3 } as const
type UidRole = keyof typeof ROLE_CODE

export type UidSet = { study: string; series: string; sop: string }

// Simple 32-bit LCG — not cryptographic, sufficient for deterministic test UIDs.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s
  }
}

function formatUid(a: number, b: number, role: UidRole): string {
  // 2.25.<a>.<b>.<roleCode> — dot-separated, no padding, no leading zeros.
  return `2.25.${a}.${b}.${ROLE_CODE[role]}`
}

function randomUid(role: UidRole): string {
  const buf = randomBytes(8)
  return formatUid(buf.readUInt32BE(0), buf.readUInt32BE(4), role)
}

function seededUid(next: () => number, role: UidRole): string {
  return formatUid(next(), next(), role)
}

export type UidGenerator = (fileIndex: number) => UidSet

export function makeUidGenerator(seed?: number): UidGenerator {
  if (seed === undefined) {
    return () => ({
      study: randomUid('study'),
      series: randomUid('series'),
      sop: randomUid('sop'),
    })
  }

  // Seed the PRNG with a combination of the dataset seed and the file index so
  // UIDs are both deterministic per (seed, index) pair and unique across files.
  return (fileIndex: number) => {
    const next = lcg((seed * 999983 + fileIndex * 1000003) >>> 0)
    return {
      study: seededUid(next, 'study'),
      series: seededUid(next, 'series'),
      sop: seededUid(next, 'sop'),
    }
  }
}
