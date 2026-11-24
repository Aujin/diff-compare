/** Text decoding helpers shared by the file comparison and the sync routines. */

export interface DecodedText {
  text: string
  /** Dominant end of line sequence of the file. */
  eol: string
  /** Whether the file ends with a line break. */
  trailingNewline: boolean
  /** Byte order mark that was found, if any. */
  bom: string | null
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]
const UTF16LE_BOM = [0xff, 0xfe]
const UTF16BE_BOM = [0xfe, 0xff]

/**
 * Heuristic used to decide whether a file should be shown as text or as a
 * binary blob: a NUL byte or invalid UTF-8 means binary.
 */
export function isBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  for (const byte of sample) {
    if (byte === 0) {
      return true
    }
  }
  return !isValidUtf8(sample)
}

function isValidUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Decodes a buffer into text, keeping track of the line ending style. */
export function decodeText(buffer: Buffer): DecodedText {
  let body = buffer
  let bom: string | null = null

  if (startsWith(buffer, UTF8_BOM)) {
    bom = 'utf8'
    body = buffer.subarray(3)
  } else if (startsWith(buffer, UTF16LE_BOM)) {
    bom = 'utf16le'
    body = buffer.subarray(2)
  } else if (startsWith(buffer, UTF16BE_BOM)) {
    bom = 'utf16be'
    const swapped = Buffer.from(buffer.subarray(2))
    swapped.swap16()
    body = swapped
  }

  let text: string
  if (bom === 'utf16le' || bom === 'utf16be') {
    text = body.toString('utf16le')
  } else {
    text = body.toString('utf8')
  }

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = text.endsWith('\n')
  return { text, eol, trailingNewline, bom }
}

function startsWith(buffer: Buffer, prefix: number[]): boolean {
  if (buffer.length < prefix.length) {
    return false
  }
  for (let index = 0; index < prefix.length; index += 1) {
    if (buffer[index] !== prefix[index]) {
      return false
    }
  }
  return true
}

/** Splits text into lines, remembering the end of line style. */
export function splitLines(text: string): { lines: string[]; eol: string; trailingNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], eol: '\n', trailingNewline: false }
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const trailingNewline = text.endsWith('\n')
  const lines = text.split(/\r\n|\n/)
  if (trailingNewline) {
    lines.pop()
  }
  return { lines, eol, trailingNewline }
}

/** Joins lines back into text. */
export function joinLines(lines: string[], eol: string, trailingNewline: boolean): string {
  if (lines.length === 0) {
    return ''
  }
  return lines.join(eol) + (trailingNewline ? eol : '')
}
