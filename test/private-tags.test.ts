import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  generateCollectionFromSpec,
  generateFile,
  streamLargeImage,
  validateDatasetSpec,
} from '../src'
import { binary, parseRawDict, parseWithMeta } from './helpers/dicom'

// A representative private block: creator, scalar, multi-valued, and a
// two-level nested private sequence.
const PRIVATE_TAGS = {
  '00090010': { vr: 'LO', value: 'ACME_SYNTH' },
  '00091001': { vr: 'SH', value: 'SYNTH-A' },
  '00091002': { vr: 'DS', value: ['1.5', '2.5'] },
  '00091003': {
    vr: 'SQ',
    value: [
      {
        '00091004': { vr: 'SH', value: 'NESTED' },
        '00091005': {
          vr: 'SQ',
          value: [{ '00091006': { vr: 'IS', value: '7' } }],
        },
      },
    ],
  },
}

describe('private tag generation (raw form)', () => {
  it('writes creator, scalar, multi-valued, and nested SQ private elements', async () => {
    const file = await generateFile({
      type: 'valid-image',
      tags: PRIVATE_TAGS,
    })
    const dict = parseRawDict(file.buffer)

    expect(dict['00090010']).toMatchObject({ vr: 'LO', Value: ['ACME_SYNTH'] })
    expect(dict['00091001']).toMatchObject({ vr: 'SH', Value: ['SYNTH-A'] })
    expect(dict['00091002']).toMatchObject({ vr: 'DS', Value: [1.5, 2.5] })

    const sq = dict['00091003']
    expect(sq?.vr).toBe('SQ')
    const item = (
      sq?.Value as Record<string, { vr: string; Value: unknown[] }>[]
    )[0]
    expect(item?.['00091004']).toMatchObject({ vr: 'SH', Value: ['NESTED'] })
    const nested = (
      item?.['00091005']?.Value as Record<
        string,
        { vr: string; Value: unknown[] }
      >[]
    )[0]
    expect(nested?.['00091006']).toMatchObject({ vr: 'IS', Value: [7] })
  })

  it('mis-encodes a dictionary tag verbatim via the raw form (escape hatch)', async () => {
    const file = await generateFile({
      type: 'valid-image',
      tags: {
        // StudyDescription is LO; declare DS deliberately.
        '00081030': { vr: 'DS', value: '123' },
        // Over-length LO (limit 64) on a standard tag.
        '00081090': { vr: 'LO', value: 'X'.repeat(65) },
      },
    })
    const dict = parseRawDict(file.buffer)
    expect(dict['00081030']?.vr).toBe('DS')
    expect(dict['00081030']?.Value).toEqual([123])
    expect(dict['00081090']?.vr).toBe('LO')
    expect(String(dict['00081090']?.Value?.[0]).startsWith('XXXXX')).toBe(true)
    expect(String(dict['00081090']?.Value?.[0]).length).toBeGreaterThanOrEqual(
      65,
    )
  })

  it('mirrors raw SOP identifier overrides into the file meta header', async () => {
    const file = await generateFile({
      type: 'valid-image',
      tags: {
        '00080018': { vr: 'UI', value: '1.2.3.4.5' },
        '00080016': { vr: 'UI', value: '1.2.840.10008.5.1.4.1.1.128' },
      },
    })
    const { meta } = parseWithMeta(file.buffer)
    expect(meta.MediaStorageSOPInstanceUID).toBe('1.2.3.4.5')
    expect(meta.MediaStorageSOPClassUID).toBe('1.2.840.10008.5.1.4.1.1.128')
  })

  it('keeps private elements when combined with tag-level violations', async () => {
    const file = await generateFile({
      type: 'valid-image',
      tags: { '00090010': { vr: 'LO', value: 'ACME_SYNTH' } },
      violations: ['uid-too-long'],
    })
    const dict = parseRawDict(file.buffer)
    expect(dict['00090010']).toMatchObject({ vr: 'LO', Value: ['ACME_SYNTH'] })
    expect(String(dict['00080018']?.Value?.[0]).length).toBeGreaterThan(64)
  })

  it('keeps private elements under byte-level violations', async () => {
    const file = await generateFile({
      type: 'valid-image',
      tags: { '00090010': { vr: 'LO', value: 'ACME_SYNTH' } },
      violations: ['missing-meta-header'],
    })
    // Headerless buffers cannot be re-parsed; assert on the bytes.
    expect(binary(file.buffer)).toContain('ACME_SYNTH')
  })

  it('throws on an unknown even-group hex tag with a plain value', async () => {
    await expect(
      generateFile({ type: 'valid-image', tags: { EEEE0001: 'x' } }),
    ).rejects.toThrow(/unknown hex tag "EEEE0001"/)
  })

  it('threads private tags through grouped and tree collections', async () => {
    const spec = validateDatasetSpec({
      seed: 7,
      studies: [
        {
          tags: { '00090010': { vr: 'LO', value: 'ACME_SYNTH' } },
          series: [{ entries: [{ type: 'valid-image' }] }],
        },
      ],
      tree: [
        {
          children: [
            {
              type: 'valid-image',
              tags: { '00091001': { vr: 'SH', value: 'TREE' } },
            },
          ],
        },
      ],
    })
    const files = []
    for await (const f of generateCollectionFromSpec(spec)) files.push(f)
    expect(files).toHaveLength(2)
    const grouped = parseRawDict(files[0].buffer)
    expect(grouped['00090010']).toMatchObject({
      vr: 'LO',
      Value: ['ACME_SYNTH'],
    })
    const treeFile = parseRawDict(files[1].buffer)
    expect(treeFile['00091001']).toMatchObject({ vr: 'SH', Value: ['TREE'] })
  })

  it('accepts raw forms in per-instance tag arrays', async () => {
    const spec = validateDatasetSpec({
      seed: 7,
      studies: [
        {
          series: [
            {
              instances: {
                count: 2,
                targetSizeKb: [1, 1],
                tags: {
                  '00091001': [
                    { vr: 'SH', value: 'A' },
                    { vr: 'SH', value: 'B' },
                  ],
                },
              },
            },
          ],
        },
      ],
    })
    const values: unknown[] = []
    for await (const f of generateCollectionFromSpec(spec)) {
      values.push(parseRawDict(f.buffer)['00091001']?.Value?.[0])
    }
    expect(values).toEqual(['A', 'B'])
  })
})

describe('private tags on the streamed large-image path', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'private-large-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('native streamed file carries private elements in its header', () => {
    const outPath = join(dir, 'large.dcm')
    streamLargeImage(outPath, {
      targetBytes: 64 * 1024,
      seed: 1,
      tags: { '00090010': { vr: 'LO', value: 'ACME_SYNTH' } },
    })
    const dict = parseRawDict(readFileSync(outPath))
    expect(dict['00090010']).toMatchObject({ vr: 'LO', Value: ['ACME_SYNTH'] })
  })

  it('encapsulated streamed file carries private elements in its prefix', () => {
    const outPath = join(dir, 'frag.dcm')
    streamLargeImage(outPath, {
      targetBytes: 16 * 1024,
      seed: 1,
      owMaxBytes: 1024,
      fragmentBytes: 512,
      tags: { '00090010': { vr: 'LO', value: 'ACME_SYNTH' } },
    })
    // The encapsulated container is parseable; assert on raw bytes to stay
    // independent of decoder pixel handling.
    expect(readFileSync(outPath).includes('ACME_SYNTH', 0, 'ascii')).toBe(true)
  })
})

describe('raw tag form validation', () => {
  const withTags = (tags: Record<string, unknown>) => ({
    entries: [{ type: 'valid-image', tags }],
  })

  it('rejects the raw form on a keyword key', () => {
    expect(() =>
      validateDatasetSpec(withTags({ PatientID: { vr: 'LO', value: 'x' } })),
    ).toThrow(/requires an 8-hex-char tag key/)
  })

  it('rejects a plain value on a private (odd-group) hex tag', () => {
    expect(() => validateDatasetSpec(withTags({ '00091001': 'x' }))).toThrow(
      /use the raw form/,
    )
  })

  it('rejects a preset modality smuggled in via the raw form', () => {
    expect(() =>
      validateDatasetSpec(withTags({ '00080060': { vr: 'CS', value: 'PT' } })),
    ).toThrow(/via the "modality" field/)
    expect(() =>
      validateDatasetSpec(
        withTags({ '00080060': { vr: 'CS', value: ['PT'] } }),
      ),
    ).toThrow(/via the "modality" field/)
  })

  it('rejects a non-standard VR', () => {
    expect(() =>
      validateDatasetSpec(withTags({ '00091001': { vr: 'ZZ', value: 'x' } })),
    ).toThrow(/not a standard DICOM VR/)
  })

  it('accepts the 2019-added VRs (UV/SV/OV)', () => {
    expect(() =>
      validateDatasetSpec(
        withTags({
          '00091001': { vr: 'UV', value: '42' },
          '00091002': { vr: 'SV', value: '-42' },
          '00091003': { vr: 'OV', value: '0' },
        }),
      ),
    ).not.toThrow()
  })

  it('rejects a raw form missing value or carrying extra keys', () => {
    expect(() =>
      validateDatasetSpec(withTags({ '00091001': { vr: 'SH' } })),
    ).toThrow(/value.*required/)
    expect(() =>
      validateDatasetSpec(
        withTags({ '00091001': { vr: 'SH', value: 'x', extra: 1 } }),
      ),
    ).toThrow(/only "vr" and "value"/)
  })

  it('rejects malformed SQ items', () => {
    expect(() =>
      validateDatasetSpec(withTags({ '00091003': { vr: 'SQ', value: 'x' } })),
    ).toThrow(/requires an array of items/)
    expect(() =>
      validateDatasetSpec(
        withTags({
          '00091003': {
            vr: 'SQ',
            value: [{ NotHex: { vr: 'SH', value: 'x' } }],
          },
        }),
      ),
    ).toThrow(/8-hex-char tags/)
    expect(() =>
      validateDatasetSpec(
        withTags({
          '00091003': { vr: 'SQ', value: [{ '00091004': 'plain' }] },
        }),
      ),
    ).toThrow(/raw \{ vr, value \} form/)
  })
})
