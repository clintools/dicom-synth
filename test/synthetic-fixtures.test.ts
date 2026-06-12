import { describe, expect, it, vi } from 'vitest'
import { generateFile } from '../src/collection/writer'
import { parseNatural } from './helpers/dicom'

function assertImplicitVr(buffer: Buffer): void {
  const bin = buffer.toString('binary')
  expect(bin).not.toContain('1.2.840.10008.1.2.1')
  expect(bin).toContain('1.2.840.10008.1.2')
}

describe('generateFile — valid-image', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'valid-image' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('produces a buffer larger than 128 bytes', async () => {
    const { buffer } = await generateFile({ type: 'valid-image' })
    expect(buffer.length).toBeGreaterThan(128)
  })

  it('filename has .dcm extension', async () => {
    const { filename } = await generateFile({ type: 'valid-image' })
    expect(filename).toMatch(/\.dcm$/)
  })

  it('index defaults to 0 and uses 3-digit zero-padding', async () => {
    const { filename } = await generateFile({ type: 'valid-image' })
    expect(filename).toBe('valid-image-000.dcm')
  })
})

describe('generateFile — invalid-uid-image', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'invalid-uid-image' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('embeds non-numeric UID strings for study, series, and sop', async () => {
    const { buffer } = await generateFile({ type: 'invalid-uid-image' })
    const binary = buffer.toString('binary')
    expect(binary).toContain('invalid.study')
    expect(binary).toContain('invalid.series')
    expect(binary).toContain('invalid.sop')
  })
})

describe('generateFile — vendor-warnings-image', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-image' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('sets PatientWeight to "0" in parsed output', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-image' })
    const natural = parseNatural(buffer)
    // DS VR is naturalised to a number by dcmjs
    expect(natural.PatientWeight).toBe(0)
  })

  it('includes Laterality tag in parsed output', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-image' })
    const natural = parseNatural(buffer)
    expect(Object.hasOwn(natural, 'Laterality')).toBe(true)
  })

  it('tag overrides win over vendor defaults', async () => {
    const { buffer } = await generateFile({
      type: 'vendor-warnings-image',
      tags: { PatientWeight: '75' },
    })
    const natural = parseNatural(buffer)
    // DS VR is naturalised to a number by dcmjs
    expect(natural.PatientWeight).toBe(75)
  })
})

describe('generateFile — type variety', () => {
  it('produces different buffers for valid-image vs invalid-uid-image', async () => {
    const a = (await generateFile({ type: 'valid-image' })).buffer
    const b = (await generateFile({ type: 'invalid-uid-image' })).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('produces different buffers for valid-image vs vendor-warnings-image', async () => {
    const a = (await generateFile({ type: 'valid-image' })).buffer
    const b = (await generateFile({ type: 'vendor-warnings-image' })).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })
})

describe('generateFile — modality presets', () => {
  const SOP_CLASS = {
    CT: '1.2.840.10008.5.1.4.1.1.2',
    PT: '1.2.840.10008.5.1.4.1.1.128',
    MR: '1.2.840.10008.5.1.4.1.1.4',
    CR: '1.2.840.10008.5.1.4.1.1.1',
  } as const

  for (const [modality, sopClass] of Object.entries(SOP_CLASS)) {
    it(`${modality} sets Modality and SOPClassUID`, async () => {
      const { buffer } = await generateFile({
        type: 'valid-image',
        modality: modality as keyof typeof SOP_CLASS,
      })
      const natural = parseNatural(buffer)
      expect(natural.Modality).toBe(modality)
      expect(natural.SOPClassUID).toBe(sopClass)
    })
  }

  it('defaults to CT when modality is omitted', async () => {
    const { buffer } = await generateFile({ type: 'valid-image' })
    const natural = parseNatural(buffer)
    expect(natural.Modality).toBe('CT')
    expect(natural.SOPClassUID).toBe(SOP_CLASS.CT)
  })

  it('omitting modality and modality: CT produce identical buffers', async () => {
    const a = (
      await generateFile({ type: 'valid-image' }, { seed: 1, index: 0 })
    ).buffer
    const b = (
      await generateFile(
        { type: 'valid-image', modality: 'CT' },
        { seed: 1, index: 0 },
      )
    ).buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('MediaStorageSOPClassUID in the meta header matches the preset', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      modality: 'PT',
    })
    // PET SOP Class must also replace CT's in the meta header — no CT UID anywhere.
    expect(buffer.toString('binary')).toContain(SOP_CLASS.PT)
    expect(buffer.toString('binary')).not.toContain(SOP_CLASS.CT)
  })

  it('PT includes PET type-1 attributes', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      modality: 'PT',
    })
    const natural = parseNatural(buffer)
    expect(natural.Units).toBe('BQML')
    expect(natural.DecayCorrection).toBe('NONE')
  })

  it('tag overrides win over preset attributes', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      modality: 'PT',
      tags: { Units: 'CNTS', Modality: 'NM' },
    })
    const natural = parseNatural(buffer)
    expect(natural.Units).toBe('CNTS')
    expect(natural.Modality).toBe('NM')
  })

  it('modality applies to valid-image', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      modality: 'MR',
      rows: 16,
      columns: 16,
    })
    const natural = parseNatural(buffer)
    expect(natural.Modality).toBe('MR')
    expect(natural.SOPClassUID).toBe(SOP_CLASS.MR)
  })
})

describe('generateFile — seed determinism', () => {
  it('same seed + same index → identical buffer', async () => {
    const a = (
      await generateFile({ type: 'valid-image' }, { seed: 42, index: 0 })
    ).buffer
    const b = (
      await generateFile({ type: 'valid-image' }, { seed: 42, index: 0 })
    ).buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('same seed + different index → different buffer', async () => {
    const a = (
      await generateFile({ type: 'valid-image' }, { seed: 42, index: 0 })
    ).buffer
    const b = (
      await generateFile({ type: 'valid-image' }, { seed: 42, index: 1 })
    ).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })
})

describe('generateFile — tag overrides', () => {
  it('accepts known keyword overrides without throwing', async () => {
    await expect(
      generateFile({
        type: 'valid-image',
        tags: { PatientID: 'P001', PatientName: 'DOE^JANE' },
      }),
    ).resolves.toBeDefined()
  })

  it('accepts hex-tag overrides without throwing', async () => {
    await expect(
      generateFile({
        type: 'valid-image',
        tags: { '00081030': 'Research Protocol A' },
      }),
    ).resolves.toBeDefined()
  })
})

describe('generateFile — pixel dimensions', () => {
  it('produces a buffer larger than rows × columns × frames × 2 bytes', async () => {
    const rows = 64
    const columns = 64
    const frames = 4
    const { buffer } = await generateFile({
      type: 'valid-image',
      rows,
      columns,
      frames,
    })
    expect(buffer.length).toBeGreaterThan(rows * columns * frames * 2)
  })

  it('defaults to 1 frame when frames is omitted', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      rows: 16,
      columns: 16,
    })
    expect(buffer.length).toBeGreaterThan(16 * 16 * 2)
    // Single-frame files omit NumberOfFrames entirely.
    expect(Object.hasOwn(parseNatural(buffer), 'NumberOfFrames')).toBe(false)
  })

  it('tag overrides win over spec dimensions for non-pixel fields', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      rows: 32,
      columns: 32,
      tags: { StudyDescription: 'Override wins' },
    })
    const natural = parseNatural(buffer)
    expect(natural.StudyDescription).toBe('Override wins')
  })
})

describe('generateFile — targetSizeKb', () => {
  const tolerance = (targetBytes: number) => Math.max(4096, targetBytes * 0.02)

  for (const targetKb of [100, 5 * 1024, 100 * 1024]) {
    it(`lands within tolerance at ${targetKb} KB`, async () => {
      const { buffer } = await generateFile({
        type: 'valid-image',
        targetSizeKb: targetKb,
      })
      const targetBytes = targetKb * 1024
      expect(Math.abs(buffer.length - targetBytes)).toBeLessThanOrEqual(
        tolerance(targetBytes),
      )
    })
  }

  it('accounts for tag-override overhead', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      targetSizeKb: 100,
      tags: { StudyDescription: 'x'.repeat(64), PatientID: 'P'.repeat(30) },
    })
    expect(Math.abs(buffer.length - 100 * 1024)).toBeLessThanOrEqual(4096)
  })

  it('works on invalid-uid-image and vendor-warnings-image', async () => {
    for (const type of [
      'invalid-uid-image',
      'vendor-warnings-image',
    ] as const) {
      const { buffer } = await generateFile({ type, targetSizeKb: 100 })
      expect(Math.abs(buffer.length - 100 * 1024)).toBeLessThanOrEqual(4096)
    }
  })

  it('keeps Rows x Columns consistent with the padded PixelData', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      targetSizeKb: 100,
    })
    const natural = parseNatural(buffer)
    const rows = natural.Rows as number
    const columns = natural.Columns as number
    expect(rows * columns * 2).toBeGreaterThan(90 * 1024)
  })

  it('a target below the file overhead produces the minimal possible file', async () => {
    // ~2 KB of tag data pushes the overhead above the 1 KB target.
    const tags = {
      StudyDescription: 'x'.repeat(64),
      PatientComments: 'y'.repeat(2048),
    }
    const { buffer } = await generateFile({
      type: 'valid-image',
      targetSizeKb: 1,
      tags,
    })
    const overheadOnly = (await generateFile({ type: 'valid-image', tags }))
      .buffer
    // Floors at ~overhead (above target) rather than failing.
    expect(buffer.length).toBeGreaterThan(1024)
    expect(buffer.length).toBeLessThanOrEqual(overheadOnly.length + 16)
  })

  it('is deterministic with a seed', async () => {
    const a = (
      await generateFile(
        { type: 'valid-image', targetSizeKb: 100 },
        { seed: 3, index: 0 },
      )
    ).buffer
    const b = (
      await generateFile(
        { type: 'valid-image', targetSizeKb: 100 },
        { seed: 3, index: 0 },
      )
    ).buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })
})

describe('generateFile — non-dicom content', () => {
  it('default buffer contains "not dicom"', async () => {
    const { buffer } = await generateFile({ type: 'non-dicom' })
    expect(buffer.toString('utf8')).toBe('not dicom')
  })

  it('encodes custom content field as UTF-8', async () => {
    const { buffer } = await generateFile({
      type: 'non-dicom',
      content: 'garbage bytes',
    })
    expect(buffer.toString('utf8')).toBe('garbage bytes')
  })

  it('has no .dcm extension in filename', async () => {
    const { filename } = await generateFile({ type: 'non-dicom' })
    expect(filename).not.toMatch(/\.dcm$/)
  })
})

describe('generateFile — dicomdir', () => {
  it('has a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'dicomdir' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('has .dcm extension in filename', async () => {
    const { filename } = await generateFile({ type: 'dicomdir' })
    expect(filename).toMatch(/\.dcm$/)
  })
})

describe('generateFile — transferSyntax', () => {
  it('explicit-vr-little-endian embeds UID 1.2.840.10008.1.2.1', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      transferSyntax: 'explicit-vr-little-endian',
    })
    expect(buffer.toString('binary')).toContain('1.2.840.10008.1.2.1')
  })

  it('implicit-vr-little-endian embeds UID 1.2.840.10008.1.2 in meta header', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      transferSyntax: 'implicit-vr-little-endian',
    })
    assertImplicitVr(buffer)
  })
})

describe('generateFile — implicit-vr encoding', () => {
  it('data elements omit VR codes when transfer syntax is implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      transferSyntax: 'implicit-vr-little-endian',
    })
    // Modality tag (0008,0060) in Little Endian bytes.
    const modalityTag = Buffer.from([0x08, 0x00, 0x60, 0x00])
    const idx = buffer.indexOf(modalityTag)
    expect(idx).toBeGreaterThan(0)
    // In Implicit VR, the 4 bytes after the tag are the length field (no VR string).
    // Modality value is 'CT' (2 bytes) → length = 02 00 00 00.
    const vrBytes = buffer.subarray(idx + 4, idx + 6).toString('ascii')
    expect(vrBytes).not.toBe('CS') // no VR code present
    expect(buffer[idx + 4]).toBe(0x02) // first byte of 4-byte length is 2
  })
})

describe('generateFile — transferSyntax on non-valid-image types', () => {
  it('vendor-warnings-image respects implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'vendor-warnings-image',
      transferSyntax: 'implicit-vr-little-endian',
    })
    assertImplicitVr(buffer)
  })

  it('valid-image respects implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'valid-image',
      rows: 16,
      columns: 16,
      transferSyntax: 'implicit-vr-little-endian',
    })
    assertImplicitVr(buffer)
  })
})

describe('generateFile — unknown hex tag warning', () => {
  it('warns and does not throw for a hex tag not in the DICOM dictionary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      generateFile({
        type: 'valid-image',
        tags: { '00990099': 'private-value' },
      }),
    ).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('00990099'))
    warn.mockRestore()
  })
})
