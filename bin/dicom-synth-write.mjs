#!/usr/bin/env node
import { resolve } from 'node:path'
import { writeSyntheticFixturesToDir } from '../dist/esm/index.js'

const outDir = resolve(process.argv[2] ?? './fixtures/synthetic')
const paths = writeSyntheticFixturesToDir(outDir)
for (const p of paths) {
  console.log(`wrote ${p}`)
}
