/** Shared message and payload types between the extension host and the webview. */

import type { Locale } from './i18n'

export type Side = 'left' | 'right'

export type ViewMode = 'text' | 'hex' | 'binary'

/** `auto` lets the extension pick text or hex based on the file content. */
export type ViewModeSetting = ViewMode | 'auto'

export type PaneKind = 'file' | 'folder'

export interface PaneItem {
  kind: PaneKind
  uri: string
  name: string
  path: string
}

export interface SideInfo {
  kind: PaneKind
  uri: string
  name: string
  path: string
  size?: number
  binary?: boolean
  lines?: number
}

export type RowType = 'eq' | 'chg' | 'del' | 'ins'

export interface TextRow {
  /** Row kind: equal, changed, only on the left, only on the right. */
  t: RowType
  /** Left side: [line number, text]. */
  l?: [number, string]
  /** Right side: [line number, text]. */
  r?: [number, string]
  /** Id of the hunk this row belongs to (only for differing rows). */
  h?: number
}

export interface Hunk {
  id: number
  kind: 'change' | 'delete' | 'insert'
  /** Number of left lines before the hunk. */
  lBefore: number
  /** Number of left lines inside the hunk. */
  lCount: number
  /** Number of right lines before the hunk. */
  rBefore: number
  /** Number of right lines inside the hunk. */
  rCount: number
  /** Index of the first row of the hunk inside `TextRow[]`. */
  row: number
}

export interface ByteRange {
  id: number
  /** Byte range on the left file (end exclusive). */
  lStart: number
  lEnd: number
  /** Byte range on the right file (end exclusive). */
  rStart: number
  rEnd: number
  /** Index of the first affected row inside `BinaryRow[]`. */
  row: number
}

export interface BinaryRow {
  /** Byte offset of the row on the left side. */
  lo: number
  /** Byte offset of the row on the right side. */
  ro: number
  /** Hex payload of the left row (may be shorter at the end of the file). */
  lb?: string
  /** Hex payload of the right row. */
  rb?: string
  /** Per byte flags: `1` when the byte differs from its counterpart. */
  mask?: string
}

export type EntryStatus = 'only-left' | 'only-right' | 'modified' | 'same'

export interface FolderEntry {
  /** Relative path, always with `/` separators. */
  path: string
  type: 'file' | 'dir'
  status: EntryStatus
  leftSize?: number
  rightSize?: number
  leftType?: string
  rightType?: string
  /** Uri of the entry on the left side, when it exists there. */
  leftUri?: string
  /** Uri of the entry on the right side, when it exists there. */
  rightUri?: string
}

export interface TextPayload {
  rows: TextRow[]
  hunks: Hunk[]
  leftLines: number
  rightLines: number
  truncated?: boolean
}

export interface BinaryPayload {
  rows: BinaryRow[]
  ranges: ByteRange[]
  leftSize: number
  rightSize: number
  truncated?: boolean
}

export interface FolderPayload {
  entries: FolderEntry[]
  leftCount: number
  rightCount: number
  truncated?: boolean
}

export interface ComparisonPayload {
  kind: 'none' | 'file' | 'folder' | 'mismatch'
  left?: SideInfo
  right?: SideInfo
  viewMode: ViewMode
  text?: TextPayload
  binary?: BinaryPayload
  folder?: FolderPayload
  notice?: string
}

export type HostMessage =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'newPanel' }
  | { type: 'drop'; side: Side; uris: string[] }
  | { type: 'addWorkspaceFolder'; side?: Side }
  | { type: 'pickTarget'; side?: Side }
  | { type: 'addActiveEditor'; side: Side }
  | { type: 'swap' }
  | { type: 'clear'; side?: Side }
  | { type: 'setViewMode'; mode: ViewModeSetting }
  | { type: 'syncHunk'; hunkId: number; target: Side }
  | { type: 'syncRange'; rangeId: number; target: Side }
  | { type: 'syncEntry'; path: string; target: Side }
  | { type: 'syncAll'; target: Side }
  | { type: 'openFile'; uri: string }
  | { type: 'focusSearch' }
  | { type: 'undo' }
  | { type: 'log'; message: string }

export type WebviewMessage =
  | { type: 'comparison'; payload: ComparisonPayload }
  | {
      type: 'state'
      viewMode: ViewModeSetting
      hasLeft: boolean
      hasRight: boolean
      canUndo: boolean
      locale: Locale
      strings: Record<string, string>
    }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'focusSearch' }
