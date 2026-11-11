/** One session as the pane keeps it, from the session list. */
export type SessionRow = {
  id: string
  title: string
  /** SESSION_STATUS_RUNNING, SESSION_STATUS_IDLE, SESSION_STATUS_ARCHIVED, ... */
  status: string
  /** SESSION_STATUS_BUCKET_WORKING, _BLOCKED, _REVIEW_READY, _COMPLETED, _FAILED */
  bucket: string
  updated: string
  tags: string[]
  isUnread: boolean
}

/** What a scan of one session's transcript found. */
export type FolderScan = {
  /** The folder the session worked in, normalized ("/d/vibe-coding/port2port"); null when none was found. */
  folder: string | null
  /** Folders of absolute file paths the session touched, for matching against known folders. */
  paths: string[]
  /** The session's updated time when it was scanned. */
  updated: string
  /** Why the scan failed, when it did. */
  error?: string
}

export type Editing = { kind: 'session'; id: string } | { kind: 'group'; key: string } | null

export type Filter = 'all' | 'needs' | 'active'

export type PaneUi = {
  filter: Filter
  query: string
  /** Groups the person opened (true) or closed (false); absent follows the default. */
  open: Record<string, boolean>
  /** Groups showing all their sessions. */
  more: Record<string, boolean>
  editing: Editing
}

export type LoadStatus = {
  isLoading: boolean
  scanned: number
  toScan: number
  error: string | null
  fetchedAt: number | null
  currentId: string | null
  currentFolder: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-projects': {
      sessions: Shaped<SessionRow[]>
      scans: Shaped<Record<string, FolderScan>>
      ui: Shaped<PaneUi>
      status: Shaped<LoadStatus>
    }
  }
}
