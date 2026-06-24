import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validateDatasetSpec } from '../src/schema/validate'
import {
  streamLargeImage,
  writeLargeImageFile,
} from '../src/syntheticFixtures/streamWrite'
import { parseNatural } from './helpers/dicom'

const seed = 42

describe('streamLargeImage', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stream-write-test-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('writes a parseable native (OW) file with matching dimensions', () => {
    const out = join(tmpDir, 'native.dcm')
    const result = streamLargeImage(out, {
      targetBytes: 8192,
      modality: 'CT',
      seed,
    })

    expect(result.encoding).toBe('native')
    expect(result.bytesWritten).toBe(statSync(out).size)

    const ds = parseNatural(readFileSync(out))
    const pixel = ds.PixelData as ArrayBuffer
    expect(pixel.byteLength).toBe(result.pixelBytes)
    expect((ds.Rows as number) * (ds.Columns as number) * 2).toBe(
      result.pixelBytes,
    )
  })

  it('writes a parseable encapsulated file when the payload exceeds the OW ceiling', () => {
    const out = join(tmpDir, 'encap.dcm')
    const result = streamLargeImage(out, {
      targetBytes: 16384,
      modality: 'CT',
      seed,
      owMaxBytes: 1024,
      fragmentBytes: 512,
    })

    expect(result.encoding).toBe('encapsulated')
    expect(result.bytesWritten).toBe(statSync(out).size)

    const ds = parseNatural(readFileSync(out))
    const fragments = ds.PixelData as ArrayBuffer[]
    expect(Array.isArray(fragments)).toBe(true)
    const totalFragmentBytes = fragments.reduce(
      (sum, f) => sum + f.byteLength,
      0,
    )
    expect(totalFragmentBytes).toBe(result.pixelBytes)
  })

  it('is deterministic for the same seed and size', () => {
    const a = join(tmpDir, 'a.dcm')
    const b = join(tmpDir, 'b.dcm')
    streamLargeImage(a, { targetBytes: 8192, modality: 'CT', seed })
    streamLargeImage(b, { targetBytes: 8192, modality: 'CT', seed })
    expect(Buffer.compare(readFileSync(a), readFileSync(b))).toBe(0)
  })

  it('reflects the requested modality in the output', () => {
    const out = join(tmpDir, 'pt.dcm')
    streamLargeImage(out, { targetBytes: 8192, modality: 'PT', seed })

    const ds = parseNatural(readFileSync(out))
    expect(ds.Modality).toBe('PT')
    // PET Image Storage SOP Class UID.
    expect(ds.SOPClassUID).toBe('1.2.840.10008.5.1.4.1.1.128')
  })

  it('locates PixelData despite a decoy tag+VR sequence in an earlier OW element', () => {
    const out = join(tmpDir, 'decoy.dcm')
    // OverlayData (group 6000, VR OW) sorts before PixelData; its value embeds
    // the 6-byte PixelData tag+VR but not the full element header.
    const decoy = new Uint8Array([
      0xe0, 0x7f, 0x10, 0x00, 0x4f, 0x57, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ])
    const result = streamLargeImage(out, {
      targetBytes: 8192,
      modality: 'CT',
      seed,
      tags: { OverlayData: decoy.buffer },
    })

    expect(result.encoding).toBe('native')
    const ds = parseNatural(readFileSync(out))
    expect((ds.PixelData as ArrayBuffer).byteLength).toBe(result.pixelBytes)
  })

  it('stays valid when a tag override sorts after PixelData', () => {
    const out = join(tmpDir, 'trailing.dcm')
    // DataSetTrailingPadding (FFFC,FFFC) serialises after PixelData (7FE0,0010);
    // the native splice must locate PixelData, not assume it is the last element.
    const result = streamLargeImage(out, {
      targetBytes: 8192,
      modality: 'CT',
      seed,
      tags: { DataSetTrailingPadding: new Uint8Array([1, 2, 3, 4]).buffer },
    })

    expect(result.encoding).toBe('native')
    expect(result.bytesWritten).toBe(statSync(out).size)
    const ds = parseNatural(readFileSync(out))
    expect((ds.PixelData as ArrayBuffer).byteLength).toBe(result.pixelBytes)
  })

  it('lands within tolerance of the requested size', () => {
    const out = join(tmpDir, 'sized.dcm')
    const targetBytes = 1024 * 1024
    const result = streamLargeImage(out, { targetBytes, modality: 'CT', seed })

    // Square-ish dimension rounding leaves a small gap; stay within 0.5%.
    expect(Math.abs(result.bytesWritten - targetBytes)).toBeLessThan(
      targetBytes * 0.005,
    )
    expect(result.bytesWritten).toBe(statSync(out).size)
  })
})

describe('writeLargeImageFile', () => {
  it('rejects targets at or below the 512 MB in-memory limit', () => {
    expect(() =>
      writeLargeImageFile(
        { targetBytes: 100 * 1024 * 1024 },
        '/tmp/unused.dcm',
      ),
    ).toThrow(/512 MB/)
  })

  it('rejects targets above the 50 GB limit', () => {
    expect(() =>
      writeLargeImageFile(
        { targetBytes: 51 * 1024 * 1024 * 1024 },
        '/tmp/unused.dcm',
      ),
    ).toThrow(/50 GB/)
  })

  it('rejects non-integer targets', () => {
    expect(() =>
      writeLargeImageFile({ targetBytes: 1.5 }, '/tmp/unused.dcm'),
    ).toThrow(/integer/)
  })
})

describe('in-memory sizing cap (unchanged)', () => {
  it('still rejects targetSizeKb above 512 MB on the in-memory path', () => {
    expect(() =>
      validateDatasetSpec({
        entries: [{ type: 'valid-image', targetSizeKb: 512 * 1024 + 1 }],
      }),
    ).toThrow(/512 MB/)
  })
})

// Opt-in: a real >512 MB native write with a bounded-memory assertion.
// Skipped by default to keep CI fast/disk-light — set DICOM_SYNTH_LARGE_TEST=1.
const largeIt = process.env.DICOM_SYNTH_LARGE_TEST ? it : it.skip

describe('writeLargeImageFile (large, opt-in)', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'stream-write-large-'))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  largeIt('streams a >512 MB native file with bounded memory', () => {
    const out = join(tmpDir, 'big.dcm')
    const targetBytes = 600 * 1024 * 1024
    const before = process.memoryUsage().rss
    const result = writeLargeImageFile({ targetBytes, seed: 1 }, out)
    const rssDelta = process.memoryUsage().rss - before

    expect(result.encoding).toBe('native')
    expect(statSync(out).size).toBeGreaterThan(512 * 1024 * 1024)
    // Peak RSS growth must stay far below the file size (streamed, not buffered).
    expect(rssDelta).toBeLessThan(128 * 1024 * 1024)

    const ds = parseNatural(readFileSync(out))
    expect((ds.PixelData as ArrayBuffer).byteLength).toBe(result.pixelBytes)
  })
})
