import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { PublicCaseRecord } from './catalog'

const DEFAULT_CACHE_ROOT = join(homedir(), '.cache', 'dicom-synth-testcases')

export function caseCachePath(
  sha256: string,
  root = DEFAULT_CACHE_ROOT,
): string {
  return join(root, sha256, 'file.dcm')
}

export function verifySha256(buffer: Buffer, expected: string): void {
  const h = createHash('sha256').update(buffer).digest('hex')
  if (h !== expected) {
    throw new Error(
      `SHA256 mismatch: expected ${expected}, got ${h}. Upstream may have changed; bump metadata after review.`,
    )
  }
}

export async function fetchPublicCaseToCache(
  record: PublicCaseRecord,
  cacheRoot = DEFAULT_CACHE_ROOT,
): Promise<string> {
  if (record.source.kind !== 'url') {
    throw new Error(
      `Case ${record.id}: only url sources are supported (s3 requires credentials).`,
    )
  }
  const dest = caseCachePath(record.sha256, cacheRoot)
  if (existsSync(dest)) {
    const buf = readFileSync(dest)
    verifySha256(buf, record.sha256)
    return dest
  }

  mkdirSync(join(cacheRoot, record.sha256), { recursive: true })
  const res = await fetch(record.source.url)
  if (!res.ok) {
    throw new Error(
      `Fetch failed ${res.status} ${res.statusText} for ${record.source.url}`,
    )
  }
  const buf = Buffer.from(await res.arrayBuffer())
  verifySha256(buf, record.sha256)
  writeFileSync(dest, buf)
  return dest
}
