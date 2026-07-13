// Zero-copy view of a Buffer/Uint8Array's bytes as an ArrayBuffer — the input
// shape dcmjs's DicomMessage.readFile expects. Slices to the view's window so a
// Buffer that shares a larger pooled ArrayBuffer yields only its own bytes.
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}
