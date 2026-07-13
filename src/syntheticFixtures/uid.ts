import { createHash, randomBytes } from 'node:crypto'

export type UidSet = { study: string; series: string; sop: string }

// Hash-derived UID: 2.25.<128-bit sha256(salt‖key) as decimal> — a conformant
// UUID-derived form. The salt namespaces the digest so different datasets get
// disjoint UIDs; the same (salt, key) is stable, which preserves cross-file
// links and reproducibility. Length ≤ 44 chars, within the 64-char UI VR limit.
export function hashUid(salt: string, key: string): string {
  const digest = createHash('sha256')
    .update(salt)
    .update(' ')
    .update(key)
    .digest()
  const n = BigInt(`0x${digest.subarray(0, 16).toString('hex')}`)
  return `2.25.${n.toString()}`
}

// A random 128-bit UID for the saltless (non-reproducible) path.
function randomUid(): string {
  const n = BigInt(`0x${randomBytes(16).toString('hex')}`)
  return `2.25.${n.toString()}`
}

// Bridges the numeric `seed` to a salt string when no explicit uidSalt is given, so seed-based
// determinism carries through. undefined for a seedless spec (→ random UIDs).
export function seedToSalt(seed: number | undefined): string | undefined {
  return seed === undefined ? undefined : `seed:${seed}`
}

// Simple 32-bit LCG — not cryptographic, sufficient for deterministic sampling.
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0
    return s
  }
}

// Offsets each seeded stream into its own domain so independent consumers of
// the same dataset seed cannot draw colliding sequences.
export const PARAMETRIC_STREAM_OFFSET = 0x85ebca6b

// All seeded streams derive their LCG seed here; the offset separates stream
// domains so independent consumers of the same dataset seed draw disjoint
// sequences.
export function seededStream(seed: number, offset: number): () => number {
  return lcg((seed * 999983 + offset) >>> 0)
}

export type GroupUidGenerator = {
  study: (studyIndex: number) => string
  series: (studyIndex: number, seriesIndex: number) => string
}

// Shared study/series UIDs for grouped collections — deterministic per
// (salt, studyIndex[, seriesIndex]), random when salt is omitted.
export function makeGroupUidGenerator(salt?: string): GroupUidGenerator {
  if (salt === undefined) {
    return { study: () => randomUid(), series: () => randomUid() }
  }
  return {
    study: (studyIndex) => hashUid(salt, `study:${studyIndex}`),
    series: (studyIndex, seriesIndex) =>
      hashUid(salt, `series:${studyIndex}:${seriesIndex}`),
  }
}

export type UidGenerator = (fileIndex: number) => UidSet

// Per-file UID set. Grouped files take only .sop from here (study/series are
// overridden with shared group UIDs); flat files use all three. The role-tagged
// keys keep study/series/sop disjoint by construction.
export function makeUidGenerator(salt?: string): UidGenerator {
  if (salt === undefined) {
    return () => ({ study: randomUid(), series: randomUid(), sop: randomUid() })
  }
  return (fileIndex: number) => ({
    study: hashUid(salt, `study:flat:${fileIndex}`),
    series: hashUid(salt, `series:flat:${fileIndex}`),
    sop: hashUid(salt, `sop:${fileIndex}`),
  })
}
