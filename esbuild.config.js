import { readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import esbuild from 'esbuild'

function findEntryPoints(dir, baseDir = '') {
  const entries = []
  for (const item of readdirSync(dir)) {
    const fullPath = join(dir, item)
    const relativePath = join(baseDir, item)
    if (statSync(fullPath).isDirectory()) {
      entries.push(...findEntryPoints(fullPath, relativePath))
    } else if (
      extname(item) === '.ts' &&
      !item.endsWith('.test.ts') &&
      !item.endsWith('.spec.ts')
    ) {
      entries.push(`src/${relativePath}`)
    }
  }
  return entries
}

const entryPoints = findEntryPoints('src')

const buildOptions = {
  entryPoints,
  format: 'esm',
  outdir: 'dist/esm',
  bundle: true,
  sourcemap: false,
  target: 'es2020',
  platform: 'node',
  external: ['dcmjs', 'node:fs', 'node:path', 'node:os', 'node:crypto'],
  minify: false,
}

async function build() {
  try {
    await esbuild.build(buildOptions)
    console.log('ESM build completed')
  } catch (error) {
    console.error('Build failed:', error)
    process.exit(1)
  }
}

if (process.argv.includes('--watch')) {
  const context = await esbuild.context(buildOptions)
  await context.watch()
  console.log('Watching for changes...')
} else {
  build()
}
