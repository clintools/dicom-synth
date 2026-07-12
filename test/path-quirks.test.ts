import { readdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type GeneratedFile,
  generateCollectionFromSpec,
} from '../src/collection/generate'
import { writeCollectionFromSpec } from '../src/collection/writer'
import type { DatasetSpec, PathQuirk } from '../src/schema/types'
import { validateDatasetSpec } from '../src/schema/validate'

async function collect(spec: DatasetSpec): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = []
  for await (const f of generateCollectionFromSpec(spec)) files.push(f)
  return files
}

const grouped = (pathQuirks?: PathQuirk[]): DatasetSpec => ({
  seed: 1,
  layout: 'hierarchical',
  studies: [{ series: [{ entries: [{ type: 'valid-image', count: 3 }] }] }],
  ...(pathQuirks ? { pathQuirks } : {}),
})

const hasNonAscii = (s: string) => [...s].some((c) => c.charCodeAt(0) > 127)

describe('path quirks', () => {
  it('leave paths untouched when omitted', async () => {
    const files = await collect(grouped())
    expect(files[0]?.relativePath).toBe('study-001/series-001/00001.dcm')
  })

  it('trailing-dot decorates directory components', async () => {
    const files = await collect(grouped(['trailing-dot']))
    expect(files[0]?.relativePath).toBe('study-001./series-001./00001.dcm')
  })

  it('trailing-dot falls back to the file when flat (no directories)', async () => {
    const files = await collect({
      seed: 1,
      entries: [{ type: 'valid-image' }],
      pathQuirks: ['trailing-dot'],
    })
    expect(files[0]?.relativePath).toMatch(/\.dcm\.$/)
  })

  it('deep-nesting inserts extra directory levels before the file', async () => {
    const files = await collect(grouped(['deep-nesting']))
    const rel = files[0]?.relativePath ?? ''
    expect(rel.startsWith('study-001/series-001/d0/')).toBe(true)
    expect(rel.split('/').length).toBe(3 + 8) // study, series, 8 nested, leaf
  })

  it('unicode keeps a series under one directory (component-stable)', async () => {
    const files = await collect(grouped(['unicode']))
    const dirs = files.map((f) =>
      f.relativePath.split('/').slice(0, -1).join('/'),
    )
    expect(new Set(dirs).size).toBe(1) // all 3 files share one decorated dir
    expect(hasNonAscii(files[0]?.relativePath ?? '')).toBe(true)
  })

  it('long-name pads the filename stem under the 255-byte limit', async () => {
    const files = await collect(grouped(['long-name']))
    const leaf = files[0]?.filename ?? ''
    expect(leaf.length).toBeGreaterThan(150)
    expect(leaf.length).toBeLessThan(255)
    expect(leaf.endsWith('.dcm')).toBe(true)
  })

  it('long-name also pads the deepest directory component', async () => {
    const files = await collect(grouped(['long-name']))
    const dirs = (files[0]?.relativePath ?? '').split('/').slice(0, -1)
    const deepest = dirs[dirs.length - 1] ?? ''
    expect(deepest.length).toBeGreaterThan(150)
    expect(deepest.length).toBeLessThan(255)
  })

  it('long-name + unicode keeps every component under 255 bytes', async () => {
    const files = await collect(grouped(['long-name', 'unicode']))
    const bytes = new TextEncoder()
    for (const part of (files[0]?.relativePath ?? '').split('/')) {
      expect(bytes.encode(part).length).toBeLessThan(255)
    }
  })

  it('composes multiple quirks deterministically', async () => {
    const spec = grouped(['deep-nesting', 'unicode', 'trailing-dot'])
    expect((await collect(spec)).map((f) => f.relativePath)).toEqual(
      (await collect(spec)).map((f) => f.relativePath),
    )
  })

  it('filename stays the basename of the decorated path', async () => {
    const files = await collect(grouped(['unicode', 'deep-nesting']))
    for (const f of files) {
      expect(f.relativePath.endsWith(`/${f.filename}`)).toBe(true)
    }
  })

  describe('on disk (POSIX-writable quirks)', () => {
    let dir: string
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'path-quirks-'))
    })
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    it('writes a quirked tree to disk', async () => {
      const manifest = await writeCollectionFromSpec(
        grouped(['trailing-dot', 'unicode']),
        dir,
      )
      expect(manifest).toHaveLength(3)
      const studyDirs = readdirSync(dir)
      expect(studyDirs.some((d) => d.endsWith('.'))).toBe(true)
    })
  })
})

describe('validateDatasetSpec — pathQuirks', () => {
  it('accepts a known quirk list', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image' }],
        pathQuirks: ['trailing-dot', 'unicode'],
      }),
    ).not.toThrow()
  })

  it('rejects a non-array pathQuirks', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image' }],
        pathQuirks: 'trailing-dot',
      }),
    ).toThrow(/pathQuirks: must be an array/)
  })

  it('rejects an unknown quirk', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image' }],
        pathQuirks: ['bogus'],
      }),
    ).toThrow(/pathQuirks\[0\]/)
  })
})
