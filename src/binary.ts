/** Byte level comparison plus the hex dump rendering used by the webview. */

import { diffExact, diffLines, type DiffOp } from './diff'
import type { BinaryRow, ByteRange } from './types'

export const ROW_SIZE = 16

export interface ByteChange {
  lStart: number
  lEnd: number
  rStart: number
  rEnd: number
}

/**
 * Compares two byte buffers.
 *
 * The comparison is anchored on 16 byte rows first (that keeps the result
 * stable for large binaries) and refined with an exact byte level diff inside
 * every block that actually changed.
 */
export function diffBytes(left: Buffer, right: Buffer): ByteChange[] {
  const leftRows = toRowKeys(left)
  const rightRows = toRowKeys(right)
  const ops = diffRows(leftRows, rightRows)
  const changes: ByteChange[] = []

  let opIndex = 0
  while (opIndex < ops.length) {
    const op = ops[opIndex]
    if (op.type === 'equal') {
      opIndex += 1
      continue
    }

    let leftEnd = op.aEnd
    let rightEnd = op.bEnd
    while (opIndex < ops.length && ops[opIndex].type !== 'equal') {
      leftEnd = Math.max(leftEnd, ops[opIndex].aEnd)
      rightEnd = Math.max(rightEnd, ops[opIndex].bEnd)
      opIndex += 1
    }

    const lStart = op.aStart * ROW_SIZE
    const lEnd = Math.min(leftEnd * ROW_SIZE, left.length)
    const rStart = op.bStart * ROW_SIZE
    const rEnd = Math.min(rightEnd * ROW_SIZE, right.length)

    if (lStart >= lEnd && rStart >= rEnd) {
      continue
    }

    for (const change of refineChange(left, right, lStart, lEnd, rStart, rEnd)) {
      changes.push(change)
    }
  }

  return mergeChanges(changes)
}

/** Exact byte diff inside a small block; larger blocks stay coarse. */
function refineChange(
  left: Buffer,
  right: Buffer,
  lStart: number,
  lEnd: number,
  rStart: number,
  rEnd: number,
): ByteChange[] {
  const leftLength = lEnd - lStart
  const rightLength = rEnd - rStart
  if (leftLength === 0 || rightLength === 0) {
    return [{ lStart, lEnd, rStart, rEnd }]
  }
  if (leftLength * rightLength > 1_000_000) {
    return [{ lStart, lEnd, rStart, rEnd }]
  }

  const leftPart = left.subarray(lStart, lEnd)
  const rightPart = right.subarray(rStart, rEnd)
  const leftText = Buffer.from(leftPart).toString('latin1')
  const rightText = Buffer.from(rightPart).toString('latin1')
  const ops = diffExact(
    leftText.split(''),
    rightText.split(''),
  )

  const changes: ByteChange[] = []
  let aIndex = 0
  let bIndex = 0
  let pending: ByteChange | null = null

  const flush = () => {
    if (pending) {
      changes.push(pending)
      pending = null
    }
  }

  for (const op of ops) {
    if (op.type === 'equal') {
      flush()
      aIndex = op.aEnd
      bIndex = op.bEnd
      continue
    }
    if (!pending) {
      pending = { lStart: lStart + aIndex, lEnd: lStart + aIndex, rStart: rStart + bIndex, rEnd: rStart + bIndex }
    }
    pending.lEnd = Math.max(pending.lEnd, lStart + op.aEnd)
    pending.rEnd = Math.max(pending.rEnd, rStart + op.bEnd)
    aIndex = op.aEnd
    bIndex = op.bEnd
  }
  flush()

  return changes
}

function mergeChanges(changes: ByteChange[]): ByteChange[] {
  const merged: ByteChange[] = []
  for (const change of changes) {
    const last = merged[merged.length - 1]
    if (
      last &&
      last.lEnd === change.lStart &&
      last.rEnd === change.rStart
    ) {
      last.lEnd = change.lEnd
      last.rEnd = change.rEnd
      continue
    }
    merged.push({ ...change })
  }
  return merged
}

/** Row aligned diff of two hex row lists. */
function diffRows(left: string[], right: string[]): DiffOp[] {
  return diffLines(left, right)
}

function toRowKeys(buffer: Buffer): string[] {
  const rows: string[] = []
  for (let offset = 0; offset < buffer.length; offset += ROW_SIZE) {
    rows.push(buffer.subarray(offset, offset + ROW_SIZE).toString('hex'))
  }
  return rows
}

/**
 * Builds the offset aligned hex dump rows for the webview and marks the bytes
 * that differ.
 */
export function buildHexRows(
  left: Buffer,
  right: Buffer,
  changes: ByteChange[],
): { rows: BinaryRow[]; ranges: ByteRange[] } {
  const rowCount = Math.ceil(Math.max(left.length, right.length) / ROW_SIZE)
  const rows: BinaryRow[] = []
  const ranges: ByteRange[] = []

  for (let index = 0; index < rowCount; index += 1) {
    const offset = index * ROW_SIZE
    const leftChunk = offset < left.length ? left.subarray(offset, offset + ROW_SIZE) : undefined
    const rightChunk = offset < right.length ? right.subarray(offset, offset + ROW_SIZE) : undefined
    rows.push({
      lo: offset,
      ro: offset,
      lb: leftChunk ? leftChunk.toString('hex') : undefined,
      rb: rightChunk ? rightChunk.toString('hex') : undefined,
    })
  }

  for (const change of changes) {
    const firstRow = Math.floor(change.lStart / ROW_SIZE)
    ranges.push({
      id: ranges.length,
      lStart: change.lStart,
      lEnd: change.lEnd,
      rStart: change.rStart,
      rEnd: change.rEnd,
      row: firstRow,
    })

    // Mark the bytes that differ inside the affected rows. The rows are found
    // on both sides so that inserted or removed bytes are highlighted too.
    const affected = new Set<number>()
    for (let row = 0; row < rows.length; row += 1) {
      const offset = row * ROW_SIZE
      const touchesLeft = offset < change.lEnd && offset + ROW_SIZE > change.lStart
      const touchesRight = offset < change.rEnd && offset + ROW_SIZE > change.rStart
      if (touchesLeft || touchesRight) {
        affected.add(row)
      }
    }

    for (const row of affected) {
      const target = rows[row]
      const leftBytes = target.lb ?? ''
      const rightBytes = target.rb ?? ''
      const byteCount = Math.max(leftBytes.length, rightBytes.length) / 2
      const flags: string[] = new Array(byteCount).fill('0')
      for (let byte = 0; byte < byteCount; byte += 1) {
        const leftByte = leftBytes.substr(byte * 2, 2)
        const rightByte = rightBytes.substr(byte * 2, 2)
        if (leftByte !== rightByte) {
          flags[byte] = '1'
        }
      }
      target.mask = flags.join('')
    }
  }

  return { rows, ranges }
}

/** Formats a byte range as a short hex preview. */
export function previewHex(buffer: Buffer, start: number, end: number, limit = 24): string {
  const slice = buffer.subarray(start, Math.min(end, start + limit))
  const hex = slice.toString('hex').match(/.{1,2}/g)?.join(' ') ?? ''
  return end - start > limit ? `${hex} …` : hex
}
