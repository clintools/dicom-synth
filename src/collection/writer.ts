import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { MAX_STREAM_BYTES } from '../schema/limits.js'
import type { DatasetSpec, FileSpec } from '../schema/types.js'
import { streamLargeImage } from '../syntheticFixtures/streamWrite.js'
import { resolveTagTemplates } from '../syntheticFixtures/tagTemplate.js'
import {
  effectiveSalt,
  materialisePlan,
  planCollection,
  resolveUid,
} from './generate.js'

export type CollectionManifest = Array<{
  path: string
  type: FileSpec['type']
  index: number
}>

// Layer 3 — disk writer. Normal entries are buffered then written; large-image
// entries are streamed straight to disk (never held in memory).
export async function writeCollectionFromSpec(
  spec: DatasetSpec,
  outDir: string,
): Promise<CollectionManifest> {
  const root = resolve(outDir)
  mkdirSync(root, { recursive: true })

  const manifest: CollectionManifest = []
  const salt = effectiveSalt(spec)
  const createdDirs = new Set<string>([root])
  const ensureDir = (filePath: string) => {
    const dir = dirname(filePath)
    if (!createdDirs.has(dir)) {
      mkdirSync(dir, { recursive: true })
      createdDirs.add(dir)
    }
  }

  for (const plan of planCollection(spec)) {
    const filePath = resolve(root, plan.relativePath)
    ensureDir(filePath)

    if (plan.fileSpec.type === 'large-image') {
      const large = plan.fileSpec
      // Guard the one disk path that can silently consume huge space even on an
      // unvalidated spec (streamLargeImage itself enforces no policy bounds).
      if (large.targetBytes > MAX_STREAM_BYTES) {
        throw new Error(
          `large-image targetBytes (${large.targetBytes}) exceeds the 50 GB limit`,
        )
      }
      const uid = resolveUid(salt, plan.index, plan.uidOverride)
      streamLargeImage(filePath, {
        targetBytes: large.targetBytes,
        modality: large.modality,
        uid,
        tags: resolveTagTemplates(large.tags, plan.context),
      })
    } else {
      const file = await materialisePlan(plan, salt)
      await writeFile(filePath, file.buffer)
    }
    manifest.push({
      path: filePath,
      type: plan.fileSpec.type,
      index: plan.index,
    })
  }
  return manifest
}
