import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { resolve } from 'node:path'
import { MAX_PIXEL_BYTES, MAX_STREAM_BYTES } from '../schema/limits.js'
import type { DicomTagOverrides, Modality } from '../schema/types.js'
import {
  applyTagOverrides,
  buildBaseImageDataset,
  buildMeta,
  serializeDict,
} from './generator.js'
import { makeUidGenerator, type UidSet } from './uid.js'

// A defined-length OW element carries a 32-bit length; 0xFFFFFFFF is reserved
// for "undefined length", so 0xFFFFFFFE (~4 GB) is the largest native payload.
const OW_MAX_BYTES = 0xfffffffe
// Each encapsulated fragment also uses a 32-bit length; keep it even.
const FRAGMENT_MAX_BYTES = 0xfffffffe

const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024

// RLE Lossless — an encapsulated transfer syntax. The container is valid but
// the fragment bytes are zeros, not real RLE: structure over the 4 GB ceiling
// at the cost of conformant pixel *content* (documented).
const RLE_TRANSFER_SYNTAX_UID = '1.2.840.10008.1.2.5'

// 7FE0,0010 (little-endian) + VR — native "OW" / encapsulated "OB" PixelData.
const PIXEL_DATA_OW_HEADER = Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57])
const PIXEL_DATA_OB_HEADER = Buffer.from([0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x42])
const ITEM_TAG_GROUP = 0xfffe
const ITEM_TAG_ELEMENT = 0xe000
const SEQUENCE_DELIMITER_ELEMENT = 0xe0dd

export type LargeImageSpec = {
  /** Approximate total file size in bytes (must exceed the 512 MB cap). */
  targetBytes: number
  modality?: Modality
  /** Drawn when omitted; fixes the instance UIDs for reproducibility. */
  seed?: number
}

export type LargeFileEncoding = 'native' | 'encapsulated'

export type LargeFileResult = {
  path: string
  bytesWritten: number
  encoding: LargeFileEncoding
  pixelBytes: number
}

export type StreamLargeImageOptions = {
  /** Approximate total file size in bytes (no floor — small values are valid). */
  targetBytes: number
  modality?: Modality
  /** Drawn when omitted; fixes the instance UIDs for reproducibility. */
  seed?: number
  /** Explicit UID set — used as-is (e.g. collection threading shared study/series UIDs). */
  uid?: UidSet
  /** Tag overrides applied to the dataset (e.g. InstanceNumber, study/series tags). */
  tags?: DicomTagOverrides
  chunkBytes?: number
  // Encoding ceilings; override to exercise either path at small sizes
  // (primarily for tests/CI — production callers use writeLargeImageFile).
  owMaxBytes?: number
  fragmentBytes?: number
}

type ImageIdentity = {
  modality: Modality
  uid: UidSet
  tags?: DicomTagOverrides
}

// An 8-byte item header (group FFFE): a fragment/BOT item or the sequence
// delimiter, depending on the element and length.
function itemTag(element: number, byteLength = 0): Buffer {
  const b = Buffer.alloc(8)
  b.writeUInt16LE(ITEM_TAG_GROUP, 0)
  b.writeUInt16LE(element, 2)
  b.writeUInt32LE(byteLength, 4)
  return b
}

// Square-ish dimensions whose 16-bit pixel payload is <= the requested bytes,
// keeping Rows/Columns within the US limit so the native file stays conformant.
function nativeDimensions(pixelBytes: number): {
  rows: number
  columns: number
  bytes: number
} {
  const cells = Math.max(1, Math.floor(pixelBytes / 2))
  const rows = Math.min(65535, Math.max(1, Math.round(Math.sqrt(cells))))
  const columns = Math.min(65535, Math.max(1, Math.floor(cells / rows)))
  return { rows, columns, bytes: rows * columns * 2 }
}

function streamZeros(fd: number, totalBytes: number, zeroChunk: Buffer): void {
  let remaining = totalBytes
  while (remaining > 0) {
    const n = Math.min(zeroChunk.length, remaining)
    writeSync(fd, zeroChunk, 0, n)
    remaining -= n
  }
}

function writeNative(
  outPath: string,
  params: ImageIdentity,
  dims: { rows: number; columns: number; bytes: number },
  zeroChunk: Buffer,
): number {
  const { modality, uid, tags } = params
  const meta = buildMeta(uid, modality)
  const dataset = buildBaseImageDataset(uid, modality)
  // Tags first so our size-driven Rows/Columns/length always win.
  applyTagOverrides(dataset, tags)
  dataset.Rows = dims.rows
  dataset.Columns = dims.columns

  // Locate the OW PixelData element rather than assuming it is the last element:
  // a tag override in a group after 7FE0 would otherwise sort after it. Match the
  // exact element header — tag(4) + "OW"(2) + reserved(2) + the known minimal
  // length(4) — so a decoy byte sequence inside an earlier element's value (e.g.
  // OW OverlayData) cannot be mistaken for it.
  const minimalPixelBytes = (dataset.PixelData as ArrayBuffer).byteLength
  const probe = serializeDict(meta, dataset)
  const pixelElement = Buffer.alloc(12)
  PIXEL_DATA_OW_HEADER.copy(pixelElement)
  pixelElement.writeUInt32LE(minimalPixelBytes, 8)
  const owIdx = probe.indexOf(pixelElement)
  if (owIdx < 0) {
    throw new Error('failed to locate native PixelData element header')
  }
  const dataStart = owIdx + 12
  const header = Buffer.from(probe.subarray(0, dataStart))
  header.writeUInt32LE(dims.bytes, owIdx + 8)
  // Any elements serialised after PixelData are preserved after the payload.
  const trailing = probe.subarray(dataStart + minimalPixelBytes)

  const fd = openSync(outPath, 'w')
  try {
    writeSync(fd, header)
    streamZeros(fd, dims.bytes, zeroChunk)
    if (trailing.length > 0) writeSync(fd, trailing)
  } finally {
    closeSync(fd)
  }
  return header.length + dims.bytes + trailing.length
}

function writeEncapsulated(
  outPath: string,
  params: ImageIdentity,
  pixelBytes: number,
  fragmentBytes: number,
  zeroChunk: Buffer,
): number {
  const { modality, uid, tags } = params
  const meta = {
    ...buildMeta(uid, modality),
    TransferSyntaxUID: RLE_TRANSFER_SYNTAX_UID,
  }
  const dataset = buildBaseImageDataset(uid, modality)
  applyTagOverrides(dataset, tags)
  dataset.PixelData = [new Uint8Array([]).buffer, new Uint8Array([0, 0]).buffer]
  dataset._vrMap = { PixelData: 'OB' }

  const probe = serializeDict(meta, dataset)
  const idx = probe.indexOf(PIXEL_DATA_OB_HEADER)
  if (idx < 0 || probe.readUInt32LE(idx + 8) !== 0xffffffff) {
    throw new Error('failed to locate encapsulated PixelData element header')
  }
  // Prefix = everything through the OB element's undefined-length field.
  const prefix = Buffer.from(probe.subarray(0, idx + 12))

  const fd = openSync(outPath, 'w')
  let bytesWritten = 0
  try {
    writeSync(fd, prefix)
    bytesWritten += prefix.length
    // Empty Basic Offset Table item.
    const bot = itemTag(ITEM_TAG_ELEMENT, 0)
    writeSync(fd, bot)
    bytesWritten += bot.length

    let remaining = pixelBytes
    while (remaining > 0) {
      const fragLen = Math.min(fragmentBytes, remaining)
      const fh = itemTag(ITEM_TAG_ELEMENT, fragLen)
      writeSync(fd, fh)
      streamZeros(fd, fragLen, zeroChunk)
      bytesWritten += fh.length + fragLen
      remaining -= fragLen
    }

    const delimiter = itemTag(SEQUENCE_DELIMITER_ELEMENT)
    writeSync(fd, delimiter)
    bytesWritten += delimiter.length
  } finally {
    closeSync(fd)
  }
  return bytesWritten
}

/**
 * Low-level streaming writer: chooses the encoding from the requested size and
 * the (overridable) ceilings, and applies **no policy bounds** — `targetBytes`
 * may be tiny. This is the entry point for exercising the streamed path inline
 * in tests/CI: override `owMaxBytes`/`fragmentBytes` to force either encoding at
 * KB scale. Normal callers want {@link writeLargeImageFile}, which adds the
 * 512 MB–50 GB policy bounds.
 */
export function streamLargeImage(
  outPath: string,
  options: StreamLargeImageOptions,
): LargeFileResult {
  const {
    targetBytes,
    chunkBytes = DEFAULT_CHUNK_BYTES,
    owMaxBytes = OW_MAX_BYTES,
    fragmentBytes = FRAGMENT_MAX_BYTES,
  } = options
  const modality = options.modality ?? 'CT'
  const uid = options.uid ?? makeUidGenerator(options.seed)(0)
  const identity: ImageIdentity = { modality, uid, tags: options.tags }

  mkdirSync(resolve(outPath, '..'), { recursive: true })
  const zeroChunk = Buffer.alloc(Math.max(1, chunkBytes))

  // Measure the native overhead so the file lands near the requested size.
  const probe = serializeDict(
    buildMeta(uid, modality),
    buildBaseImageDataset(uid, modality),
  )
  const nativeHeaderLen = probe.length - 2
  const requestedPixel = Math.max(2, targetBytes - nativeHeaderLen)

  if (requestedPixel <= owMaxBytes) {
    const dims = nativeDimensions(requestedPixel)
    const bytesWritten = writeNative(outPath, identity, dims, zeroChunk)
    return {
      path: outPath,
      bytesWritten,
      encoding: 'native',
      pixelBytes: dims.bytes,
    }
  }

  // Encapsulated: undefined-length OB split into <= fragmentBytes fragments.
  // overhead = prefix + BOT item + N fragment headers + delimiter.
  const estimateFrags = Math.max(
    1,
    Math.ceil((targetBytes - nativeHeaderLen - 16) / fragmentBytes),
  )
  const overhead = nativeHeaderLen + 8 + estimateFrags * 8 + 8
  let pixelBytes = Math.max(2, targetBytes - overhead)
  pixelBytes -= pixelBytes % 2
  const bytesWritten = writeEncapsulated(
    outPath,
    identity,
    pixelBytes,
    fragmentBytes - (fragmentBytes % 2),
    zeroChunk,
  )
  return { path: outPath, bytesWritten, encoding: 'encapsulated', pixelBytes }
}

/**
 * Stream a single DICOM image of approximately `targetBytes` to disk without
 * holding it in memory. Disk-only: the in-memory `generateFile` path keeps the
 * 512 MB cap. Files up to ~4 GB use a conformant native (OW) encoding; larger
 * files (to 50 GB) use encapsulated fragments — a valid container with
 * non-conformant zero pixel content.
 */
export function writeLargeImageFile(
  spec: LargeImageSpec,
  outPath: string,
  options: { chunkBytes?: number } = {},
): LargeFileResult {
  const { targetBytes } = spec
  if (!Number.isInteger(targetBytes)) {
    throw new Error('writeLargeImageFile: targetBytes must be an integer')
  }
  if (targetBytes <= MAX_PIXEL_BYTES) {
    throw new Error(
      'writeLargeImageFile is for files above the 512 MB in-memory limit — use targetSizeKb for smaller files',
    )
  }
  if (targetBytes > MAX_STREAM_BYTES) {
    throw new Error('writeLargeImageFile: targetBytes exceeds the 50 GB limit')
  }

  return streamLargeImage(outPath, {
    targetBytes,
    modality: spec.modality,
    seed: spec.seed,
    chunkBytes: options.chunkBytes,
  })
}
