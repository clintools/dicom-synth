#!/usr/bin/env tsx
/**
 * Write deterministic synthetic DICOM fixtures to a directory.
 *
 *   pnpm write:synthetic -- ./out/fixtures
 */
import { resolve } from 'node:path'
import {
  SYNTHETIC_FIXTURES,
  writeSyntheticFixturesToDir,
} from '../src/syntheticFixtures/generator'

const outDir = resolve(process.argv[2] ?? './fixtures/synthetic')
const paths = writeSyntheticFixturesToDir(outDir)
for (let i = 0; i < paths.length; i++) {
  const desc = SYNTHETIC_FIXTURES[i]?.description ?? ''
  console.log(`wrote ${paths[i]} — ${desc}`)
}
