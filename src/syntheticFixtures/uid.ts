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

// Offsets the group UID streams away from the per-file streams so a grouped
// study/series UID cannot collide with a flat file's UID at the same index.
const GROUP_STREAM_OFFSET = 0x9e3779b9

// All seeded UID streams derive their LCG seed here; the offset separates
// stream domains and the prime multipliers separate indices within a domain.
function seededStream(
  seed: number,
  offset: number,
  a: number,
  b: number,
): () => number {
  return lcg((seed * 999983 + offset + a * 1000003 + b * 7919) >>> 0)
}

export type GroupUidGenerator = {
  study: (studyIndex: number) => string
  series: (studyIndex: number, seriesIndex: number) => string
}

// Shared study/series UIDs for grouped collections — deterministic per
// (seed, studyIndex[, seriesIndex]), random when seed is omitted.
export function makeGroupUidGenerator(seed?: number): GroupUidGenerator {
  if (seed === undefined) {
    return {
      study: () => randomUid('study'),
      series: () => randomUid('series'),
    }
  }

  return {
    study: (studyIndex) =>
      seededUid(
        seededStream(seed, GROUP_STREAM_OFFSET, studyIndex + 1, 0),
        'study',
      ),
    series: (studyIndex, seriesIndex) =>
      seededUid(
        seededStream(
          seed,
          GROUP_STREAM_OFFSET,
          studyIndex + 1,
          seriesIndex + 1,
        ),
        'series',
      ),
  }
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
    const next = seededStream(seed, 0, fileIndex, 0)
    return {
      study: seededUid(next, 'study'),
      series: seededUid(next, 'series'),
      sop: seededUid(next, 'sop'),
    }
  }
}
