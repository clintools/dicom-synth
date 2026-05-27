import { TextDecoder, TextEncoder } from 'node:util'

globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder
globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder

const originalConsoleError = console.error
const originalConsoleWarn = console.warn

console.error = (...args) => {
  const message = args[0]?.toString() || ''
  if (message.includes('Invalid vr type') || message.includes('using UN')) {
    return
  }
  originalConsoleError.apply(console, args)
}

console.warn = (...args) => {
  const message = args[0]?.toString() || ''
  if (message.includes('Unknown name in dataset')) {
    return
  }
  originalConsoleWarn.apply(console, args)
}
