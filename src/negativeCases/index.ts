import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Write a file large enough to pass size checks but with `XXXX` at
 * offset 128 instead of the `DICM` magic bytes.
 * The parent directory is created if it does not exist.
 */
export function writeFakeDicomSignatureFile(filePath: string): void {
  const buf = Buffer.alloc(200, 0)
  buf.write('XXXX', 128, 4, 'ascii')
  mkdirSync(resolve(filePath, '..'), { recursive: true })
  writeFileSync(filePath, buf)
}

/**
 * Write arbitrary non-DICOM content to `filePath`.
 * The parent directory is created if it does not exist.
 */
export function writeNonDicomFile(
  filePath: string,
  content = 'not dicom',
): void {
  mkdirSync(resolve(filePath, '..'), { recursive: true })
  writeFileSync(filePath, content)
}
