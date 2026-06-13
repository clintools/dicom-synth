import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const hasBuild = existsSync(join(repoRoot, 'dist/esm/index.js'))
const bin = join(repoRoot, 'bin/dicom-synth-generate.mjs')
const defaultSchema = join(repoRoot, 'examples/default.json')
const parametricSchema = join(repoRoot, 'examples/parametric.json')

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)))
}

function run(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

describe('dicom-synth-generate CLI', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cli-generate-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it.skipIf(!hasBuild)('exits non-zero with no args', async () => {
    const { code } = await run([])
    expect(code).not.toBe(0)
  })

  it.skipIf(!hasBuild)(
    'exits non-zero on schema validation failure',
    async () => {
      const { code, stderr } = await run([
        '--schema-inline',
        '{"entries":[{"type":"invalid-type"}]}',
        '--out',
        tmpDir,
      ])
      expect(code).not.toBe(0)
      expect(stderr).toMatch(/validation error/i)
    },
  )

  it.skipIf(!hasBuild)('exits non-zero on malformed JSON', async () => {
    const { code } = await run([
      '--schema-inline',
      '{bad json}',
      '--out',
      tmpDir,
    ])
    expect(code).not.toBe(0)
  })

  it.skipIf(!hasBuild)(
    'writes correct file count from default schema',
    async () => {
      const { code } = await run(['--schema', defaultSchema, '--out', tmpDir])
      expect(code).toBe(0)
      expect(readdirSync(tmpDir)).toHaveLength(3)
    },
  )

  it.skipIf(!hasBuild)(
    'writes correct file count from inline schema',
    async () => {
      const inline = JSON.stringify({
        entries: [{ type: 'valid-image', count: 5 }],
      })
      const { code, stdout } = await run([
        '--schema-inline',
        inline,
        '--out',
        tmpDir,
      ])
      expect(code).toBe(0)
      expect(readdirSync(tmpDir)).toHaveLength(5)
      expect(stdout).toMatch(/5 file/)
    },
  )

  it.skipIf(!hasBuild)(
    'generates from a parametric spec and emits the resolved spec',
    async () => {
      const outDir = join(tmpDir, 'out')
      const specPath = join(tmpDir, 'resolved.json')
      const { code, stdout } = await run([
        '--parametric',
        parametricSchema,
        '--out',
        outDir,
        '--emit-spec',
        specPath,
      ])
      expect(code).toBe(0)
      expect(stdout).toMatch(/Wrote resolved spec/)

      const resolved = JSON.parse(readFileSync(specPath, 'utf8'))
      expect(resolved.seed).toBe(42)
      expect(Array.isArray(resolved.studies)).toBe(true)

      // The resolved spec regenerates the same file set via --schema.
      const rerunDir = join(tmpDir, 'rerun')
      const rerun = await run(['--schema', specPath, '--out', rerunDir])
      expect(rerun.code).toBe(0)
      expect(walkFiles(rerunDir).sort()).toEqual(walkFiles(outDir).sort())
    },
  )

  it.skipIf(!hasBuild)(
    'dry run reports the manifest without writing',
    async () => {
      const outDir = join(tmpDir, 'out')
      const { code, stdout } = await run([
        '--parametric',
        parametricSchema,
        '--out',
        outDir,
        '--dry-run',
      ])
      expect(code).toBe(0)
      expect(stdout).toMatch(/Dry run: \d+ file\(s\)/)
      expect(stdout).toMatch(/nothing written/)
      expect(existsSync(outDir)).toBe(false)
    },
  )

  it.skipIf(!hasBuild)('rejects --emit-spec without --parametric', async () => {
    const { code, stderr } = await run([
      '--schema',
      defaultSchema,
      '--emit-spec',
      join(tmpDir, 'spec.json'),
    ])
    expect(code).not.toBe(0)
    expect(stderr).toMatch(/--emit-spec requires --parametric/)
  })

  it.skipIf(!hasBuild)(
    'rejects --schema combined with --parametric',
    async () => {
      const { code, stderr } = await run([
        '--schema',
        defaultSchema,
        '--parametric',
        parametricSchema,
      ])
      expect(code).not.toBe(0)
      expect(stderr).toMatch(/mutually exclusive/)
    },
  )

  it.skipIf(!hasBuild)('prints a summary by type', async () => {
    const inline = JSON.stringify({
      entries: [
        { type: 'valid-image', count: 2 },
        { type: 'fake-signature', count: 1 },
      ],
    })
    const { code, stdout } = await run([
      '--schema-inline',
      inline,
      '--out',
      tmpDir,
    ])
    expect(code).toBe(0)
    expect(stdout).toMatch(/valid-image.*2/)
    expect(stdout).toMatch(/fake-signature.*1/)
  })
})
