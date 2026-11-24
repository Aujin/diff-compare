/**
 * Line based diff engine.
 *
 * The heavy lifting is done by a classic LCS dynamic program, which is exact
 * and fast enough for the region that actually changed (common prefix and
 * suffix are trimmed away first).  When a region is too large for the DP
 * table, a patience style anchor pass splits it into smaller pieces; regions
 * that are still too large fall back to "replace this block", which is the
 * coarse but honest answer for chunks that cannot be matched line by line.
 */

/** Maximum number of cells in the LCS table (4M cells ~ 16 MB of Int32Array). */
const LCS_CELL_LIMIT = 4_000_000

export type DiffOpType = 'equal' | 'delete' | 'insert'

export interface DiffOp {
  type: DiffOpType
  /** Range in the left sequence (end exclusive). */
  aStart: number
  aEnd: number
  /** Range in the right sequence (end exclusive). */
  bStart: number
  bEnd: number
}

export interface Row {
  t: 'eq' | 'chg' | 'del' | 'ins'
  l?: [number, string]
  r?: [number, string]
  h?: number
}

export interface Hunk {
  id: number
  kind: 'change' | 'delete' | 'insert'
  lBefore: number
  lCount: number
  rBefore: number
  rCount: number
  row: number
}

/** Splits a diff into aligned rows and groups the differing rows into hunks. */
export function buildRows(
  left: string[],
  right: string[],
  ops: DiffOp[],
): { rows: Row[]; hunks: Hunk[] } {
  const rows: Row[] = []
  const hunks: Hunk[] = []

  let aIndex = 0
  let bIndex = 0
  let opIndex = 0

  while (opIndex < ops.length) {
    const op = ops[opIndex]
    if (op.type === 'equal') {
      for (let i = 0; i < op.aEnd - op.aStart; i += 1) {
        rows.push({
          t: 'eq',
          l: [aIndex + i + 1, left[aIndex + i]],
          r: [bIndex + i + 1, right[bIndex + i]],
        })
      }
      aIndex = op.aEnd
      bIndex = op.bEnd
      opIndex += 1
      continue
    }

    // Collect the whole block of consecutive non equal operations.
    let aEnd = op.aStart
    let bEnd = op.bStart
    while (opIndex < ops.length && ops[opIndex].type !== 'equal') {
      aEnd = Math.max(aEnd, ops[opIndex].aEnd)
      bEnd = Math.max(bEnd, ops[opIndex].bEnd)
      opIndex += 1
    }

    const leftCount = aEnd - op.aStart
    const rightCount = bEnd - op.bStart
    const hunkId = hunks.length
    const rowStart = rows.length
    const kind: Hunk['kind'] =
      leftCount > 0 && rightCount > 0 ? 'change' : leftCount > 0 ? 'delete' : 'insert'

    const steps = Math.max(leftCount, rightCount)
    for (let step = 0; step < steps; step += 1) {
      const hasLeft = step < leftCount
      const hasRight = step < rightCount
      const row: Row = { t: 'chg', h: hunkId }
      if (hasLeft) {
        row.l = [aIndex + step + 1, left[aIndex + step]]
      }
      if (hasRight) {
        row.r = [bIndex + step + 1, right[bIndex + step]]
      }
      if (!hasLeft) {
        row.t = 'ins'
      } else if (!hasRight) {
        row.t = 'del'
      }
      rows.push(row)
    }

    hunks.push({
      id: hunkId,
      kind,
      lBefore: aIndex,
      lCount: leftCount,
      rBefore: bIndex,
      rCount: rightCount,
      row: rowStart,
    })

    aIndex = aEnd
    bIndex = bEnd
  }

  return { rows, hunks }
}

/**
 * Exact LCS diff without the patience fallback. The caller has to make sure
 * the input is small enough for the dynamic programming table.
 */
export function diffExact(left: string[], right: string[]): DiffOp[] {
  if (left.length === 0 && right.length === 0) {
    return []
  }
  if (left.length === 0) {
    return [{ type: 'insert', aStart: 0, aEnd: 0, bStart: 0, bEnd: right.length }]
  }
  if (right.length === 0) {
    return [{ type: 'delete', aStart: 0, aEnd: left.length, bStart: 0, bEnd: 0 }]
  }
  return lcsDiff(left, right)
}

/** Diffs two line arrays. */
export function diffLines(left: string[], right: string[]): DiffOp[] {
  const ops: DiffOp[] = []

  let start = 0
  while (start < left.length && start < right.length && left[start] === right[start]) {
    start += 1
  }

  let endLeft = left.length
  let endRight = right.length
  while (
    endLeft > start &&
    endRight > start &&
    left[endLeft - 1] === right[endRight - 1]
  ) {
    endLeft -= 1
    endRight -= 1
  }

  if (start > 0) {
    ops.push({ type: 'equal', aStart: 0, aEnd: start, bStart: 0, bEnd: start })
  }

  for (const op of diffCore(left.slice(start, endLeft), right.slice(start, endRight))) {
    ops.push({
      type: op.type,
      aStart: op.aStart + start,
      aEnd: op.aEnd + start,
      bStart: op.bStart + start,
      bEnd: op.bEnd + start,
    })
  }

  if (endLeft < left.length) {
    ops.push({
      type: 'equal',
      aStart: endLeft,
      aEnd: left.length,
      bStart: endRight,
      bEnd: right.length,
    })
  }

  return mergeOps(ops)
}

function diffCore(left: string[], right: string[]): DiffOp[] {
  if (left.length === 0 && right.length === 0) {
    return []
  }
  if (left.length === 0) {
    return [{ type: 'insert', aStart: 0, aEnd: 0, bStart: 0, bEnd: right.length }]
  }
  if (right.length === 0) {
    return [{ type: 'delete', aStart: 0, aEnd: left.length, bStart: 0, bEnd: 0 }]
  }
  if (left.length * right.length <= LCS_CELL_LIMIT) {
    return lcsDiff(left, right)
  }
  return patienceDiff(left, right)
}

/** Exact LCS diff via dynamic programming. */
function lcsDiff(left: string[], right: string[]): DiffOp[] {
  const n = left.length
  const m = right.length
  const width = m + 1

  // Compare ids instead of strings: long lines then cost a single integer compare.
  const ids = new Map<string, number>()
  const idOf = (line: string): number => {
    const found = ids.get(line)
    if (found !== undefined) {
      return found
    }
    const next = ids.size + 1
    ids.set(line, next)
    return next
  }
  const leftIds = new Int32Array(n)
  const rightIds = new Int32Array(m)
  for (let i = 0; i < n; i += 1) {
    leftIds[i] = idOf(left[i])
  }
  for (let j = 0; j < m; j += 1) {
    rightIds[j] = idOf(right[j])
  }

  const table = new Int32Array((n + 1) * (m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowBase = i * width
    const nextBase = (i + 1) * width
    for (let j = m - 1; j >= 0; j -= 1) {
      table[rowBase + j] =
        leftIds[i] === rightIds[j]
          ? table[nextBase + j + 1] + 1
          : Math.max(table[nextBase + j], table[rowBase + j + 1])
    }
  }

  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (leftIds[i] === rightIds[j]) {
      ops.push({ type: 'equal', aStart: i, aEnd: i + 1, bStart: j, bEnd: j + 1 })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      ops.push({ type: 'delete', aStart: i, aEnd: i + 1, bStart: j, bEnd: j })
      i += 1
    } else {
      ops.push({ type: 'insert', aStart: i, aEnd: i, bStart: j, bEnd: j + 1 })
      j += 1
    }
  }
  if (i < n) {
    ops.push({ type: 'delete', aStart: i, aEnd: n, bStart: j, bEnd: j })
  }
  if (j < m) {
    ops.push({ type: 'insert', aStart: i, aEnd: i, bStart: j, bEnd: m })
  }

  return ops
}

/**
 * Patience style diff: anchor on lines that occur exactly once on both sides,
 * then diff the gaps between the anchors.
 */
function patienceDiff(left: string[], right: string[]): DiffOp[] {
  const anchors = findAnchors(left, right)
  const ops: DiffOp[] = []
  let leftPos = 0
  let rightPos = 0

  for (const [leftAt, rightAt] of anchors) {
    ops.push(...diffSegment(left, right, leftPos, rightPos, leftAt, rightAt))
    ops.push({ type: 'equal', aStart: leftAt, aEnd: leftAt + 1, bStart: rightAt, bEnd: rightAt + 1 })
    leftPos = leftAt + 1
    rightPos = rightAt + 1
  }
  ops.push(...diffSegment(left, right, leftPos, rightPos, left.length, right.length))

  return mergeOps(ops)
}

function diffSegment(
  left: string[],
  right: string[],
  leftStart: number,
  rightStart: number,
  leftEnd: number,
  rightEnd: number,
): DiffOp[] {
  const leftPart = left.slice(leftStart, leftEnd)
  const rightPart = right.slice(rightStart, rightEnd)
  if (leftPart.length === 0 && rightPart.length === 0) {
    return []
  }
  if (leftPart.length * rightPart.length <= LCS_CELL_LIMIT) {
    return lcsDiff(leftPart, rightPart).map((op) => ({
      type: op.type,
      aStart: op.aStart + leftStart,
      aEnd: op.aEnd + leftStart,
      bStart: op.bStart + rightStart,
      bEnd: op.bEnd + rightStart,
    }))
  }
  // Too big to be exact: report it as one replacement.
  const ops: DiffOp[] = []
  if (leftPart.length > 0) {
    ops.push({ type: 'delete', aStart: leftStart, aEnd: leftEnd, bStart: rightStart, bEnd: rightStart })
  }
  if (rightPart.length > 0) {
    ops.push({ type: 'insert', aStart: leftEnd, aEnd: leftEnd, bStart: rightStart, bEnd: rightEnd })
  }
  return ops
}

function findAnchors(left: string[], right: string[]): Array<[number, number]> {
  const leftCount = new Map<string, number>()
  const rightCount = new Map<string, number>()
  for (const line of left) {
    leftCount.set(line, (leftCount.get(line) ?? 0) + 1)
  }
  for (const line of right) {
    rightCount.set(line, (rightCount.get(line) ?? 0) + 1)
  }

  const rightPosition = new Map<string, number>()
  for (let index = 0; index < right.length; index += 1) {
    const line = right[index]
    if (rightCount.get(line) === 1) {
      rightPosition.set(line, index)
    }
  }

  const candidates: Array<[number, number]> = []
  for (let index = 0; index < left.length; index += 1) {
    const line = left[index]
    if (leftCount.get(line) !== 1) {
      continue
    }
    const target = rightPosition.get(line)
    if (target !== undefined) {
      candidates.push([index, target])
    }
  }

  // Longest increasing subsequence over the right hand positions.
  const tails: number[] = []
  const tailIndex: number[] = []
  const previous: number[] = new Array(candidates.length).fill(-1)

  for (let i = 0; i < candidates.length; i += 1) {
    const value = candidates[i][1]
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (tails[mid] < value) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    tails[low] = value
    tailIndex[low] = i
    previous[i] = low > 0 ? tailIndex[low - 1] : -1
  }

  const anchors: Array<[number, number]> = []
  let cursor = tails.length > 0 ? tailIndex[tails.length - 1] : -1
  while (cursor >= 0) {
    anchors.push(candidates[cursor])
    cursor = previous[cursor]
  }
  anchors.reverse()
  return anchors
}

function mergeOps(ops: DiffOp[]): DiffOp[] {
  const merged: DiffOp[] = []
  for (const op of ops) {
    if (op.aEnd === op.aStart && op.bEnd === op.bStart) {
      continue
    }
    const last = merged[merged.length - 1]
    if (last && last.type === op.type) {
      last.aEnd = op.aEnd
      last.bEnd = op.bEnd
      continue
    }
    merged.push({ ...op })
  }
  return merged
}
