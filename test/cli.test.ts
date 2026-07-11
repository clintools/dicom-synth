import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasBuild, repoRoot } from './helpers/cliBuild'

function runNode(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: 'pipe',
    })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

describe('CLI binaries', () => {
  it.skipIf(!hasBuild)(
    'dicom-synth-fetch exits non-zero for unknown id',
    async () => {
      const code = await runNode([
        join(repoRoot, 'bin/dicom-synth-fetch.mjs'),
        'unknown-case-id',
      ])
      expect(code).not.toBe(0)
    },
  )

  it.skipIf(!hasBuild)(
    'dicom-synth-fetch exits non-zero with no args',
    async () => {
      const code = await runNode([join(repoRoot, 'bin/dicom-synth-fetch.mjs')])
      expect(code).not.toBe(0)
    },
  )
})
