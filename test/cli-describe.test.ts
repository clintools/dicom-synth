import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { writeCollectionFromSpec } from '../src/collection/writer'
import { validateDatasetSpec } from '../src/schema/validate'
import { hasBuild, repoRoot } from './helpers/cliBuild'

const bin = join(repoRoot, 'bin/dicom-synth-describe.mjs')

function run(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

describe('dicom-synth-describe CLI', () => {
  let src: string
  let outDir: string

  beforeEach(async () => {
    src = await mkdtemp(join(tmpdir(), 'cli-describe-src-'))
    outDir = await mkdtemp(join(tmpdir(), 'cli-describe-out-'))
    await writeCollectionFromSpec(
      {
        seed: 1,
        studies: [
          { series: [{ entries: [{ type: 'valid-image', count: 2 }] }] },
        ],
      },
      src,
    )
  })

  afterEach(async () => {
    await rm(src, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  })

  it.skipIf(!hasBuild)(
    'writes a gzip-compressed spec that ungzips to a valid DatasetSpec',
    async () => {
      const out = join(outDir, 'spec.json.gz')
      const code = await run([src, '--out', out, '--gzip'])
      expect(code).toBe(0)
      const spec = JSON.parse(gunzipSync(readFileSync(out)).toString('utf8'))
      expect(() => validateDatasetSpec(spec)).not.toThrow()
      expect(spec.studies).toHaveLength(1)
    },
  )

  it.skipIf(!hasBuild)('infers gzip from a .gz out suffix', async () => {
    const out = join(outDir, 'spec.json.gz')
    const code = await run([src, '--out', out])
    expect(code).toBe(0)
    // Must be gzip (magic bytes 1f 8b), not plain JSON.
    const bytes = readFileSync(out)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
  })

  it.skipIf(!hasBuild)('rejects an invalid --size-tolerance', async () => {
    const code = await run([src, '--size-tolerance', '-1'])
    expect(code).not.toBe(0)
  })

  it.skipIf(!hasBuild)('preserves UIDs by default (derived salt)', async () => {
    const out = join(outDir, 'spec.json')
    const code = await run([src, '--out', out])
    expect(code).toBe(0)
    const spec = JSON.parse(readFileSync(out, 'utf8'))
    expect(typeof spec.uidSalt).toBe('string')
    expect(() => validateDatasetSpec(spec)).not.toThrow()
  })

  it.skipIf(!hasBuild)('records an explicit --uid-salt', async () => {
    const out = join(outDir, 'spec.json')
    const code = await run([src, '--out', out, '--uid-salt', 'deadbeef'])
    expect(code).toBe(0)
    const spec = JSON.parse(readFileSync(out, 'utf8'))
    expect(spec.uidSalt).toBe('deadbeef')
    expect(() => validateDatasetSpec(spec)).not.toThrow()
  })

  it.skipIf(!hasBuild)('omits the salt with --no-preserve-uids', async () => {
    const out = join(outDir, 'spec.json')
    const code = await run([src, '--out', out, '--no-preserve-uids'])
    expect(code).toBe(0)
    const spec = JSON.parse(readFileSync(out, 'utf8'))
    expect(spec.uidSalt).toBeUndefined()
  })

  it.skipIf(!hasBuild)(
    'rejects --uid-salt with --no-preserve-uids',
    async () => {
      const code = await run([
        src,
        '--uid-salt',
        'deadbeef',
        '--no-preserve-uids',
      ])
      expect(code).not.toBe(0)
    },
  )

  it.skipIf(!hasBuild)(
    '--keep-private-tags emits private raw forms in the spec',
    async () => {
      const privateSrc = join(outDir, 'private-src')
      await writeCollectionFromSpec(
        {
          seed: 2,
          entries: [
            {
              type: 'valid-image',
              tags: { '00091001': { vr: 'SH', value: 'SYNTH-A' } },
            },
          ],
        },
        privateSrc,
      )
      const out = join(outDir, 'spec.json')
      const code = await run([privateSrc, '--keep-private-tags', '--out', out])
      expect(code).toBe(0)
      const spec = JSON.parse(readFileSync(out, 'utf8'))
      expect(() => validateDatasetSpec(spec)).not.toThrow()
      const tags = spec.studies?.[0]?.series?.[0]?.entries?.[0]?.tags
      expect(tags?.['00091001']).toEqual({ vr: 'SH', value: 'SYNTH-A' })
    },
  )
})
