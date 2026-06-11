import { describe, expect, it, vi } from 'vitest'
import { generateFile } from '../src/collection/writer'
import { dcmjs } from '../src/loadDcmjs'

const dcmjsAny = dcmjs as unknown as {
  data: {
    DicomMessage: { readFile: (ab: ArrayBuffer) => { dict: unknown } }
    DicomMetaDictionary: {
      naturalizeDataset: (ds: unknown) => Record<string, unknown>
    }
  }
}

function parseNatural(buffer: Buffer): Record<string, unknown> {
  const ab = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer
  const parsed = dcmjsAny.data.DicomMessage.readFile(ab)
  return dcmjsAny.data.DicomMetaDictionary.naturalizeDataset(parsed.dict)
}

function assertImplicitVr(buffer: Buffer): void {
  const bin = buffer.toString('binary')
  expect(bin).not.toContain('1.2.840.10008.1.2.1')
  expect(bin).toContain('1.2.840.10008.1.2')
}

describe('generateFile — valid-ct', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'valid-ct' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('produces a buffer larger than 128 bytes', async () => {
    const { buffer } = await generateFile({ type: 'valid-ct' })
    expect(buffer.length).toBeGreaterThan(128)
  })

  it('filename has .dcm extension', async () => {
    const { filename } = await generateFile({ type: 'valid-ct' })
    expect(filename).toMatch(/\.dcm$/)
  })

  it('index defaults to 0 and uses 3-digit zero-padding', async () => {
    const { filename } = await generateFile({ type: 'valid-ct' })
    expect(filename).toBe('valid-ct-000.dcm')
  })
})

describe('generateFile — invalid-uid-ct', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'invalid-uid-ct' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('embeds non-numeric UID strings for study, series, and sop', async () => {
    const { buffer } = await generateFile({ type: 'invalid-uid-ct' })
    const binary = buffer.toString('binary')
    expect(binary).toContain('invalid.study')
    expect(binary).toContain('invalid.series')
    expect(binary).toContain('invalid.sop')
  })
})

describe('generateFile — vendor-warnings-ct', () => {
  it('produces a buffer with a valid DICM signature', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-ct' })
    expect(buffer.subarray(128, 132).toString('ascii')).toBe('DICM')
  })

  it('sets PatientWeight to "0" in parsed output', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-ct' })
    const natural = parseNatural(buffer)
    // DS VR is naturalised to a number by dcmjs
    expect(natural.PatientWeight).toBe(0)
  })

  it('includes Laterality tag in parsed output', async () => {
    const { buffer } = await generateFile({ type: 'vendor-warnings-ct' })
    const natural = parseNatural(buffer)
    expect(Object.hasOwn(natural, 'Laterality')).toBe(true)
  })

  it('tag overrides win over vendor defaults', async () => {
    const { buffer } = await generateFile({
      type: 'vendor-warnings-ct',
      tags: { PatientWeight: '75' },
    })
    const natural = parseNatural(buffer)
    // DS VR is naturalised to a number by dcmjs
    expect(natural.PatientWeight).toBe(75)
  })
})

describe('generateFile — type variety', () => {
  it('produces different buffers for valid-ct vs invalid-uid-ct', async () => {
    const a = (await generateFile({ type: 'valid-ct' })).buffer
    const b = (await generateFile({ type: 'invalid-uid-ct' })).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })

  it('produces different buffers for valid-ct vs vendor-warnings-ct', async () => {
    const a = (await generateFile({ type: 'valid-ct' })).buffer
    const b = (await generateFile({ type: 'vendor-warnings-ct' })).buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })
})

describe('generateFile — seed determinism', () => {
  it('same seed + same index → identical buffer', async () => {
    const a = (await generateFile({ type: 'valid-ct' }, { seed: 42, index: 0 }))
      .buffer
    const b = (await generateFile({ type: 'valid-ct' }, { seed: 42, index: 0 }))
      .buffer
    expect(Buffer.compare(a, b)).toBe(0)
  })

  it('same seed + different index → different buffer', async () => {
    const a = (await generateFile({ type: 'valid-ct' }, { seed: 42, index: 0 }))
      .buffer
    const b = (await generateFile({ type: 'valid-ct' }, { seed: 42, index: 1 }))
      .buffer
    expect(Buffer.compare(a, b)).not.toBe(0)
  })
})

describe('generateFile — tag overrides', () => {
  it('accepts known keyword overrides without throwing', async () => {
    await expect(
      generateFile({
        type: 'valid-ct',
        tags: { PatientID: 'P001', PatientName: 'DOE^JANE' },
      }),
    ).resolves.toBeDefined()
  })

  it('accepts hex-tag overrides without throwing', async () => {
    await expect(
      generateFile({
        type: 'valid-ct',
        tags: { '00081030': 'Research Protocol A' },
      }),
    ).resolves.toBeDefined()
  })
})

describe('generateFile — large-ct', () => {
  it('produces a buffer larger than rows × columns × frames × 2 bytes', async () => {
    const rows = 64
    const columns = 64
    const frames = 4
    const { buffer } = await generateFile({
      type: 'large-ct',
      rows,
      columns,
      frames,
    })
    expect(buffer.length).toBeGreaterThan(rows * columns * frames * 2)
  })

  it('defaults to 1 frame when frames is omitted', async () => {
    const { buffer } = await generateFile({
      type: 'large-ct',
      rows: 16,
      columns: 16,
    })
    expect(buffer.length).toBeGreaterThan(16 * 16 * 2)
  })

  it('tag overrides win over spec dimensions for non-pixel fields', async () => {
    const { buffer } = await generateFile({
      type: 'large-ct',
      rows: 32,
      columns: 32,
      tags: { StudyDescription: 'Override wins' },
    })
    const natural = parseNatural(buffer)
    expect(natural.StudyDescription).toBe('Override wins')
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
      type: 'valid-ct',
      transferSyntax: 'explicit-vr-little-endian',
    })
    expect(buffer.toString('binary')).toContain('1.2.840.10008.1.2.1')
  })

  it('implicit-vr-little-endian embeds UID 1.2.840.10008.1.2 in meta header', async () => {
    const { buffer } = await generateFile({
      type: 'valid-ct',
      transferSyntax: 'implicit-vr-little-endian',
    })
    assertImplicitVr(buffer)
  })
})

describe('generateFile — implicit-vr encoding', () => {
  it('data elements omit VR codes when transfer syntax is implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'valid-ct',
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

describe('generateFile — transferSyntax on non-valid-ct types', () => {
  it('vendor-warnings-ct respects implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'vendor-warnings-ct',
      transferSyntax: 'implicit-vr-little-endian',
    })
    assertImplicitVr(buffer)
  })

  it('large-ct respects implicit-vr-little-endian', async () => {
    const { buffer } = await generateFile({
      type: 'large-ct',
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
      generateFile({ type: 'valid-ct', tags: { '00990099': 'private-value' } }),
    ).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('00990099'))
    warn.mockRestore()
  })
})
