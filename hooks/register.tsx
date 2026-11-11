import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Editing, Filter, FolderScan, LoadStatus, PaneUi, SessionRow } from '../types'

const PANE = 'session-projects'
const SERVER = 'claude-code-remote'
const TAG = 'project:'
/** Each session's folder, kept on the session so a fresh machine needn't scan it again. */
const FOLDER_TAG = 'folder:'
const NO_FOLDER = 'none'
const MAX_TAG = 128
const STORE_SESSIONS = 'sessions-1'
const MAX_PAGES = 5
const ROWS_SHOWN = 5
const REFRESH_MS = 2 * 60 * 1000

const sessions = atom({ plugin: 'session-projects', key: 'sessions' } as const, [], {
  shape: 'sessions-1',
})
const scans = atom({ plugin: 'session-projects', key: 'scans' } as const, {}, {
  shape: 'scans-4',
})
const STORE_SCANS = 'scans-4'
const ui = atom(
  { plugin: 'session-projects', key: 'ui' } as const,
  { filter: 'all', query: '', open: {}, more: {}, editing: null },
  { shape: 'ui-1' },
)
const status = atom(
  { plugin: 'session-projects', key: 'status' } as const,
  {
    isLoading: false,
    scanned: 0,
    toScan: 0,
    error: null,
    fetchedAt: null,
    currentId: null,
    currentFolder: null,
  },
  { shape: 'status-1' },
)

type $ = EngineInterface

// ---------------------------------------------------------------------------
// Talking to the session service

type Ccr = Record<string, unknown>

function textOf(result: { content: readonly unknown[] }): string {
  return result.content
    .map(block => {
      const b = block as { type?: string; text?: string }
      return b.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('')
}

/** The JSON inside a result, without the untrusted-data wrapper some results carry. */
function parseCcr(text: string): Ccr {
  const marked = text.indexOf('{"ccr"')
  const start = marked >= 0 ? marked : text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('unexpected answer from the session service')
  const parsed = JSON.parse(text.slice(start, end + 1)) as Ccr
  const ccr = parsed.ccr
  return ccr && typeof ccr === 'object' ? (ccr as Ccr) : parsed
}

async function callText($: $, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = textOf(result)
  // An answer over the size limit is saved to a file and replaced by a note naming it.
  const saved = /exceeds maximum allowed tokens[\s\S]*?saved to (\S+?\.(?:txt|json))/.exec(text.slice(0, 2000))
  if (saved) return (await $.fs.read(saved[1]!)) as string
  if (result.isError) throw new Error(text.slice(0, 200) || `${tool} failed`)
  return text
}

async function fetchSessions($: $): Promise<SessionRow[]> {
  const rows: SessionRow[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const args: Record<string, unknown> = { limit: 100, mine: true }
    if (after) args.after_id = after
    const ccr = parseCcr(await callText($, 'list_sessions', args))
    const data = Array.isArray(ccr.data) ? (ccr.data as Ccr[]) : []
    for (const s of data) {
      if (typeof s.id !== 'string') continue
      rows.push({
        id: s.id,
        title: typeof s.title === 'string' && s.title ? s.title : 'Untitled session',
        status: String(s.session_status ?? ''),
        bucket: String(s.status_bucket ?? ''),
        updated: String(s.updated_at ?? s.created_at ?? ''),
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
        isUnread: s.unread === true,
      })
    }
    if (ccr.has_more !== true || typeof ccr.last_id !== 'string') break
    after = ccr.last_id
  }
  return rows
}

// ---------------------------------------------------------------------------
// Folders

/** "D:\\projects\\birdwatch" and "/d/projects/birdwatch/" both become "/d/projects/birdwatch". */
function normPath(raw: string): string {
  let p = raw.replace(/\\/g, '/')
  const drive = /^([A-Za-z]):(\/|$)/.exec(p)
  if (drive) p = '/' + drive[1]!.toLowerCase() + p.slice(2)
  p = p.replace(/\/+$/, '')
  return p || '/'
}

function isAbsolute(raw: string): boolean {
  return raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)
}

/** A folder that says nothing about the project: a root, a home, a temp dir. */
function isVague(p: string): boolean {
  const lc = p.toLowerCase()
  return (
    lc === '/' ||
    lc === '/root' ||
    lc === '/home' ||
    lc === '/tmp' ||
    lc.startsWith('/tmp/') ||
    lc.startsWith('/private/') ||
    lc.startsWith('/var/folders/') ||
    /^\/[a-z]$/.test(lc) ||
    /^\/(home|users|[a-z]\/users)\/[^/]+$/.test(lc)
  )
}

function baseName(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : p
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse('"' + s + '"') as string
  } catch {
    return s
  }
}

function mostCommon(list: string[]): string | null {
  const counts = new Map<string, { value: string; n: number }>()
  for (const v of list) {
    const k = v.toLowerCase()
    const c = counts.get(k)
    if (c) c.n++
    else counts.set(k, { value: v, n: 1 })
  }
  let best: { value: string; n: number } | null = null
  for (const c of counts.values()) if (!best || c.n > best.n) best = c
  return best?.value ?? null
}

/** Reads the newest part of a session's transcript for the folder its commands ran in. */
async function scanSession($: $, row: SessionRow): Promise<FolderScan> {
  const cwds: string[] = []
  const paths = new Set<string>()
  let before: string | undefined
  for (let page = 0; page < 5; page++) {
    const args: Record<string, unknown> = { session_id: row.id, kinds: ['assistant'], limit: 25 }
    if (before) args.before_id = before
    const text = await callText($, 'list_events', args)
    for (const m of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
      const v = unescapeJson(m[1]!)
      if (v && isAbsolute(v)) {
        const p = normPath(v)
        if (!isVague(p)) cwds.push(p)
      }
    }
    for (const m of text.matchAll(/"(file_path|notebook_path|path)":"((?:[^"\\]|\\.)*)"/g)) {
      const v = unescapeJson(m[2]!)
      if (v && isAbsolute(v) && paths.size < 60) {
        const p = m[1] === 'path' ? normPath(v) : dirName(normPath(v))
        if (!isVague(p)) paths.add(p)
      }
    }
    if (cwds.length >= 3) break
    let ccr: Ccr
    try {
      ccr = parseCcr(text)
    } catch {
      break
    }
    if (ccr.has_more !== true || typeof ccr.first_id !== 'string') break
    before = ccr.first_id
  }
  return { folder: mostCommon(cwds), paths: [...paths], updated: row.updated }
}

// ---------------------------------------------------------------------------
// Loading

let running = false

async function refresh($: $): Promise<void> {
  if (running) return
  running = true
  try {
    await update($, status, s => ({ ...s, isLoading: true, error: null }))
    let rows: SessionRow[]
    try {
      rows = await fetchSessions($)
    } catch (err) {
      if (!isNotConnected(err)) throw err
      await refreshLocal($)
      return
    }
    await update($, status, s => ({ ...s, mode: 'cloud' as const, cloudNote: null }))
    await update($, sessions, () => rows)
    await saveSessions($)

    const { currentId } = await read($, status)
    const known = await read($, scans)
    const todo = rows.filter(r => {
      if (r.id === currentId || folderTagOf(r) !== undefined) return false
      const s = known[r.id]
      return !s || (s.folder === null && s.updated !== r.updated)
    })
    await update($, status, s => ({ ...s, scanned: 0, toScan: todo.length }))

    let found: Record<string, FolderScan> = {}
    for (let i = 0; i < todo.length; i++) {
      const row = todo[i]!
      try {
        found[row.id] = await scanSession($, row)
      } catch (err) {
        found[row.id] = {
          folder: null,
          paths: [],
          updated: row.updated,
          error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
        }
      }
      if (Object.keys(found).length >= 4 || i === todo.length - 1) {
        const batch = found
        found = {}
        await update($, scans, all => ({ ...all, ...batch }))
        await update($, status, s => ({ ...s, scanned: i + 1 }))
      }
    }
    await $.store.set(STORE_SCANS, await read($, scans))
    try {
      await cacheFolders($)
    } catch (err) {
      $.ui.log(`session-projects: folder tags not saved: ${String(err)}`)
    }
    const now = await $.clock.now()
    await update($, status, s => ({ ...s, isLoading: false, fetchedAt: now, toScan: 0, scanned: 0 }))
    await saveSessions($)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, status, s => ({
      ...s,
      isLoading: false,
      error: message.slice(0, 160),
    }))
  } finally {
    running = false
  }
}

// ---------------------------------------------------------------------------
// Sessions on this computer, for a session without the cloud session tools

const MAX_LOCAL_FILES = 200
const MAX_READ = 4 * 1024 * 1024
const STORE_LOCAL_INDEX = 'local-index-1'
const STORE_LOCAL_PROJECTS = 'local-projects-1'
const API = 'https://api.anthropic.com/v1/code/sessions'

type LocalEntry = { mtimeMs: number; size: number; cwd: string | null; title: string | null }

function isNotConnected(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /not connected|unknown (mcp )?server|no (such )?server|not found|nothing beneath the plugins answers mcp/i.test(m)
}

async function configDir($: $): Promise<string | null> {
  const explicit = await $.env.get('CLAUDE_CONFIG_DIR')
  if (explicit) return explicit.replace(/\\/g, '/').replace(/\/+$/, '')
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  return home ? home.replace(/\\/g, '/').replace(/\/+$/, '') + '/.claude' : null
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? line.slice(0, 79) + '…' : line
}

/** What a saved transcript says about its session: the folder it ran in, and a title. */
function readTranscript(text: string): { cwd: string | null; title: string | null } {
  let cwd: string | null = null
  let title: string | null = null
  let first: string | null = null
  for (const line of text.split('\n')) {
    if (!line) continue
    if (cwd && first && !line.includes('itle"') && !line.includes('"summary"')) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (!cwd && typeof o.cwd === 'string' && o.cwd) cwd = o.cwd
    const type = o.type
    if (type === 'custom-title' || type === 'ai-title' || type === 'title' || type === 'summary') {
      const v = o.customTitle ?? o.aiTitle ?? o.title ?? o.summary
      if (typeof v === 'string' && v.trim()) title = v.trim()
    }
    if (!first) {
      if (type === 'queue-operation' && o.operation === 'enqueue' && typeof o.content === 'string') {
        first = o.content
      } else if (type === 'user') {
        const content = (o.message as { content?: unknown } | undefined)?.content
        const text =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? (content.find(b => (b as { type?: string })?.type === 'text') as { text?: string } | undefined)?.text
              : undefined
        if (typeof text === 'string' && text.trim() && !text.trimStart().startsWith('<')) first = text
      }
    }
  }
  return { cwd, title: title ? clip(title) : first ? clip(first) : null }
}

/** Sessions Claude Code has saved on this computer, newest first, each with its exact folder. */
async function fetchLocalSessions($: $): Promise<SessionRow[]> {
  const dir = await configDir($)
  if (!dir) return []
  const root = dir + '/projects'
  let projectDirs: { name: string; kind: string }[] = []
  try {
    projectDirs = (await $.fs.list(root)).filter(d => d.kind === 'dir')
  } catch {
    return []
  }
  const files: { path: string; id: string; dir: string; mtimeMs: number; size: number }[] = []
  for (const d of projectDirs) {
    let entries: { name: string; kind: string; size: number; mtimeMs: number }[] = []
    try {
      entries = await $.fs.list(root + '/' + d.name)
    } catch {
      continue
    }
    for (const f of entries) {
      if (f.kind === 'file' && f.name.endsWith('.jsonl')) {
        files.push({ path: `${root}/${d.name}/${f.name}`, id: f.name.slice(0, -6), dir: d.name, mtimeMs: f.mtimeMs, size: f.size })
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const seen = new Set<string>()
  const chosen = files.filter(f => {
    if (seen.has(f.id)) return false
    seen.add(f.id)
    return true
  }).slice(0, MAX_LOCAL_FILES)

  const index = ((await $.store.get(STORE_LOCAL_INDEX)) ?? {}) as Record<string, LocalEntry>
  const todo = chosen.filter(f => {
    const c = index[f.path]
    return !c || c.mtimeMs !== f.mtimeMs || c.size !== f.size
  })
  await update($, status, s => ({ ...s, scanned: 0, toScan: todo.length }))
  for (let i = 0; i < todo.length; i++) {
    const f = todo[i]!
    const entry: LocalEntry = { mtimeMs: f.mtimeMs, size: f.size, cwd: null, title: null }
    if (f.size <= MAX_READ) {
      try {
        Object.assign(entry, readTranscript(await $.fs.read(f.path)))
      } catch {
        // unreadable: placed by its folder's other sessions below
      }
    }
    index[f.path] = entry
    if (i % 10 === 9 || i === todo.length - 1) await update($, status, s => ({ ...s, scanned: i + 1 }))
  }
  const kept: Record<string, LocalEntry> = {}
  for (const f of chosen) if (index[f.path]) kept[f.path] = index[f.path]!
  await $.store.set(STORE_LOCAL_INDEX, kept)

  // Every transcript in one project dir ran in the same folder.
  const dirCwd = new Map<string, string>()
  for (const f of chosen) {
    const c = kept[f.path]?.cwd
    if (c && !dirCwd.has(f.dir)) dirCwd.set(f.dir, c)
  }
  const live = await liveSessions($, dir)
  return chosen.map(f => {
    const entry = kept[f.path]
    const cwd = entry?.cwd ?? dirCwd.get(f.dir) ?? null
    const folder = cwd ? normPath(cwd) : null
    const date = ago(new Date(f.mtimeMs).toISOString(), f.mtimeMs + 8 * 24 * 3600 * 1000)
    const state = live.get(f.id)
    return {
      id: 'local:' + f.id,
      title: entry?.title ?? `Long session from ${date}`,
      status: state ? 'SESSION_STATUS_RUNNING' : 'SESSION_STATUS_IDLE',
      bucket: state === 'busy' ? 'SESSION_STATUS_BUCKET_WORKING' : 'SESSION_STATUS_BUCKET_COMPLETED',
      updated: new Date(f.mtimeMs).toISOString(),
      tags: [FOLDER_TAG + (folder && !isVague(folder) ? folder : NO_FOLDER)],
      isUnread: false,
      source: 'local' as const,
      resume: cwd ? `cd "${cwd}" && claude --resume ${f.id}` : `claude --resume ${f.id}`,
    }
  })
}

/** Sessions running now on this computer, by id: Claude Code keeps a small file for each. */
async function liveSessions($: $, dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    for (const f of await $.fs.list(dir + '/sessions')) {
      if (f.kind !== 'file' || !f.name.endsWith('.json')) continue
      try {
        const o = JSON.parse(await $.fs.read(`${dir}/sessions/${f.name}`)) as { sessionId?: unknown; status?: unknown }
        if (typeof o.sessionId === 'string') out.set(o.sessionId, typeof o.status === 'string' ? o.status : 'idle')
      } catch {
        // a session that just ended
      }
    }
  } catch {
    // no running sessions recorded
  }
  return out
}

/** Your cloud sessions, read with this computer's login; Remote Control ones are already local. */
async function fetchCloudViaApi($: $): Promise<{ rows: SessionRow[]; note: string | null }> {
  const auth = await $.session.authorize()
  if (!auth) return { rows: [], note: 'Cloud sessions need a claude.ai login.' }
  const rows: SessionRow[] = []
  let after: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${API}?limit=100` + (after ? `&after_id=${encodeURIComponent(after)}` : '')
    const r = await $.http.fetch(url, {
      auth: auth.handle,
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'ccr-byoc-2025-07-29' },
    })
    if (!r.ok) {
      return { rows, note: rows.length ? null : `Cloud sessions aren't available with this login (${r.status}).` }
    }
    const body = JSON.parse(r.text) as Ccr
    const data = Array.isArray(body.data) ? (body.data as Ccr[]) : []
    for (const s of data) {
      if (typeof s.id !== 'string') continue
      const kind = String(s.environment_kind ?? (s.environment as Ccr | undefined)?.kind ?? '')
      if (/bridge/i.test(kind)) continue
      rows.push({
        id: 'session_' + s.id.replace(/^(cse|session)_/, ''),
        title: typeof s.title === 'string' && s.title ? s.title : 'Untitled session',
        status: String(s.session_status ?? s.status ?? ''),
        bucket: String(s.status_bucket ?? ''),
        updated: String(s.updated_at ?? s.last_event_at ?? s.created_at ?? ''),
        tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
        isUnread: s.unread === true,
        source: 'cloud',
      })
    }
    if (body.has_more !== true || typeof body.last_id !== 'string' || body.last_id === after) break
    after = body.last_id
  }
  return { rows, note: null }
}

function withProject(row: SessionRow, name: string): SessionRow {
  return { ...row, tags: [...row.tags.filter(t => !t.startsWith(TAG)), ...(name ? [TAG + name] : [])] }
}

async function refreshLocal($: $): Promise<void> {
  const local = await fetchLocalSessions($)
  let cloud: SessionRow[] = []
  let note: string | null = null
  try {
    ;({ rows: cloud, note } = await fetchCloudViaApi($))
  } catch {
    note = "Cloud sessions couldn't be read from this computer."
  }
  const assigned = ((await $.store.get(STORE_LOCAL_PROJECTS)) ?? {}) as Record<string, string>
  const rows = [...cloud, ...local].map(r => (r.id in assigned ? withProject(r, assigned[r.id]!) : r))
  await update($, sessions, () => rows)
  const now = await $.clock.now()
  await update($, status, s => ({
    ...s,
    isLoading: false,
    fetchedAt: now,
    toScan: 0,
    scanned: 0,
    mode: 'local' as const,
    cloudNote: note,
  }))
  await saveSessions($)
}

/** The folder a session's tag records: a path, null for "none found", undefined for no tag. */
function folderTagOf(row: SessionRow): string | null | undefined {
  const tag = row.tags.find(t => t.startsWith(FOLDER_TAG))
  if (tag === undefined) return undefined
  const value = tag.slice(FOLDER_TAG.length)
  return value === NO_FOLDER || value === '' ? null : value
}

async function saveSessions($: $): Promise<void> {
  const rows = await read($, sessions)
  const { fetchedAt } = await read($, status)
  await $.store.set(STORE_SESSIONS, { rows, fetchedAt })
}

/**
 * Records each session's folder as a tag on the session, so the next fresh machine knows it without
 * reading the session again. Archived sessions with no folder are marked "none"; open ones are left
 * untagged, as they may still start working in one.
 */
async function cacheFolders($: $): Promise<void> {
  const rows = await read($, sessions)
  const all = await read($, scans)
  const { currentId, currentFolder } = await read($, status)
  const resolved = resolveFolders(rows, all, { id: currentId, folder: currentFolder })
  const wanted = new Map<string, string[]>()
  for (const r of rows) {
    const folder = resolved.get(r.id) ?? null
    const value = folder ?? (isArchived(r) ? NO_FOLDER : undefined)
    if (value === undefined || (FOLDER_TAG + value).length > MAX_TAG) continue
    if (r.tags.includes(FOLDER_TAG + value)) continue
    wanted.set(value, [...(wanted.get(value) ?? []), r.id])
  }
  for (const [value, ids] of wanted) {
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50)
      const remove = [
        ...new Set(
          rows.filter(r => chunk.includes(r.id)).flatMap(r => r.tags.filter(t => t.startsWith(FOLDER_TAG))),
        ),
      ]
      await callText($, 'set_session_tags', { session_ids: chunk, add: [FOLDER_TAG + value], remove })
      await update($, sessions, list =>
        list.map(r =>
          chunk.includes(r.id)
            ? { ...r, tags: [...r.tags.filter(t => !t.startsWith(FOLDER_TAG)), FOLDER_TAG + value] }
            : r,
        ),
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Grouping

type Group = {
  key: string
  name: string
  folders: string[]
  rows: SessionRow[]
  latest: string
  isNamed: boolean
  isUnsorted: boolean
}

function projectOf(row: SessionRow): string | null {
  const tag = row.tags.find(t => t.startsWith(TAG))
  const name = tag?.slice(TAG.length).trim()
  return name ? name : null
}

/** Folder names that are a part of a project, not the project itself. */
const GENERIC = new Set([
  'docs', 'doc', 'src', 'app', 'apps', 'lib', 'libs', 'tools', 'tool', 'test', 'tests', 'scripts',
  'script', 'assets', 'public', 'build', 'dist', 'out', 'bin', 'packages', 'crates', 'reference',
])

/** How Claude Code names a folder's own data dirs: "D:\\projects\\tile studio" is "d--projects-tile-studio". */
function folderKey(p: string): string {
  const drive = /^\/([a-z])(\/|$)/i.exec(p)
  const native = drive ? drive[1]!.toUpperCase() + ':' + p.slice(2) : p
  return native.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

/** Claude Code's data dirs for a session (memory, scratchpad, tool results) carry its folder's key. */
function keysOf(paths: string[]): Set<string> {
  const keys = new Set<string>()
  for (const p of paths) {
    const m = /\/\.claude\/projects\/([^/]+)/.exec(p) ?? /\/temp\/claude\/([^/]+)/i.exec(p)
    const key = m?.[1]?.toLowerCase()
    if (key && !['-home-user', '-root', '-tmp'].includes(key)) keys.add(key)
  }
  return keys
}

function isInternal(p: string): boolean {
  const lc = p.toLowerCase()
  return lc.includes('/.claude/') || lc.includes('/appdata/local/temp') || isVague(p)
}

function prefixes(p: string): string[] {
  const parts = p.split('/').filter(Boolean)
  return parts.map((_, i) => '/' + parts.slice(0, i + 1).join('/'))
}

function isUnder(p: string, folder: string): boolean {
  const lp = p.toLowerCase()
  const lf = folder.toLowerCase()
  return lp === lf || lp.startsWith(lf + '/')
}

function commonAncestor(dirs: string[]): string | null {
  if (dirs.length === 0) return null
  let common = dirs[0]!.split('/').filter(Boolean)
  for (const d of dirs.slice(1)) {
    const parts = d.split('/').filter(Boolean)
    let i = 0
    while (i < common.length && i < parts.length && common[i]!.toLowerCase() === parts[i]!.toLowerCase()) i++
    common = common.slice(0, i)
  }
  while (common.length > 2 && GENERIC.has(common[common.length - 1]!.toLowerCase())) common.pop()
  return common.length ? '/' + common.join('/') : null
}

/**
 * Each session's folder. First what is certain: the folder its commands ran in, or the folder its
 * Claude Code data dirs are named after. Then, for the rest, the folders the certain ones found.
 */
function resolveFolders(
  rows: SessionRow[],
  all: Record<string, FolderScan>,
  current: { id: string | null; folder: string | null },
): Map<string, string | null> {
  const out = new Map<string, string | null>()
  const facts = rows.map(r => {
    const scan = all[r.id]
    const paths = scan?.paths ?? []
    const dirs = [...(scan?.folder ? [scan.folder] : []), ...paths]
      .map(p => p.split('/.claude/worktrees/')[0]!)
      .filter(p => !isInternal(p))
    return { r, scan, keys: keysOf(paths), dirs }
  })

  const settled = new Set<string>()
  for (const { r, scan, keys, dirs } of facts) {
    if (r.id === current.id && current.folder) {
      out.set(r.id, current.folder)
      continue
    }
    const tagged = folderTagOf(r)
    if (tagged !== undefined) {
      out.set(r.id, tagged)
      settled.add(r.id)
      continue
    }
    let found: string | null = null
    for (const d of dirs) {
      for (const pre of prefixes(d)) if (keys.has(folderKey(pre))) found = found ?? pre
    }
    out.set(r.id, found ?? scan?.folder ?? null)
  }

  const sure = [...new Set([...out.values()].filter((f): f is string => f !== null))]
  const parents = [...new Set(sure.map(dirName))]
  for (const { r, keys, dirs } of facts) {
    if (out.get(r.id) || settled.has(r.id)) continue
    let found: string | null = sure.find(f => keys.has(folderKey(f))) ?? null
    if (!found && dirs.length) {
      const votes: string[] = []
      for (const d of dirs) {
        const best = sure.filter(f => isUnder(d, f)).sort((a, b) => b.length - a.length)[0]
        if (best) votes.push(best)
      }
      found = mostCommon(votes)
    }
    if (!found) {
      for (const key of keys) {
        const parent = parents.find(p => key.startsWith(folderKey(p) + '-'))
        if (parent) found = found ?? parent + '/' + key.slice(folderKey(parent).length + 1)
      }
    }
    if (!found) {
      const ca = commonAncestor(dirs)
      // A folder that holds several known projects is no project of its own.
      if (ca && !isVague(ca) && !parents.some(p => p.toLowerCase() === ca.toLowerCase())) found = ca
    }
    out.set(r.id, found)
  }
  return out
}

function buildGroups(
  rows: SessionRow[],
  all: Record<string, FolderScan>,
  current: { id: string | null; folder: string | null },
): Group[] {
  const folders = resolveFolders(rows, all, current)

  // A folder whose sessions were filed under a project sends its other sessions there too.
  const votes = new Map<string, string[]>()
  for (const r of rows) {
    const f = folders.get(r.id)
    const p = projectOf(r)
    if (f && p) votes.set(f.toLowerCase(), [...(votes.get(f.toLowerCase()) ?? []), p])
  }

  const groups = new Map<string, Group>()
  for (const r of rows) {
    const folder = folders.get(r.id) ?? null
    const project =
      projectOf(r) ?? (folder ? mostCommon(votes.get(folder.toLowerCase()) ?? []) : null)
    const key = project
      ? 'p:' + project.toLowerCase()
      : folder
        ? 'f:' + folder.toLowerCase()
        : 'unsorted'
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        name: project ?? (folder ? baseName(folder) : 'Unsorted'),
        folders: [],
        rows: [],
        latest: '',
        isNamed: project !== null,
        isUnsorted: key === 'unsorted',
      }
      groups.set(key, g)
    }
    g.rows.push(r)
    if (r.updated > g.latest) g.latest = r.updated
    if (folder) {
      const b = baseName(folder)
      if (!g.folders.some(x => x.toLowerCase() === b.toLowerCase())) g.folders.push(b)
    }
  }
  const list = [...groups.values()]
  for (const g of list) g.rows.sort((a, b) => (a.updated < b.updated ? 1 : -1))
  return list.sort((a, b) => {
    if (a.isUnsorted !== b.isUnsorted) return a.isUnsorted ? 1 : -1
    return a.latest < b.latest ? 1 : -1
  })
}

function needsMe(r: SessionRow): boolean {
  return /BLOCKED|REVIEW_READY|FAILED/.test(r.bucket)
}

function isArchived(r: SessionRow): boolean {
  return r.status.includes('ARCHIVED')
}

function applyFilter(groups: Group[], filter: Filter, query: string): Group[] {
  const q = query.trim().toLowerCase()
  const out: Group[] = []
  for (const g of groups) {
    const groupHit =
      q !== '' &&
      (g.name.toLowerCase().includes(q) || g.folders.some(f => f.toLowerCase().includes(q)))
    const rows = g.rows.filter(r => {
      if (filter === 'needs' && !needsMe(r)) return false
      if (filter === 'active' && isArchived(r)) return false
      return q === '' || groupHit || r.title.toLowerCase().includes(q)
    })
    if (rows.length > 0) out.push({ ...g, rows })
  }
  return out
}

// ---------------------------------------------------------------------------
// Filing sessions into projects

async function fileSessions($: $, ids: string[], name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ').slice(0, 60)
  const rows = await read($, sessions)
  const chosen = rows.filter(r => ids.includes(r.id))
  const remove = [
    ...new Set(chosen.flatMap(r => r.tags.filter(t => t.startsWith(TAG) && t !== TAG + clean))),
  ]
  const add = clean ? [TAG + clean] : []
  if ((await read($, status)).mode === 'local') {
    const assigned = ((await $.store.get(STORE_LOCAL_PROJECTS)) ?? {}) as Record<string, string>
    for (const id of ids) assigned[id] = clean
    await $.store.set(STORE_LOCAL_PROJECTS, assigned)
  } else {
    for (let i = 0; i < ids.length; i += 50) {
      await callText($, 'set_session_tags', {
        session_ids: ids.slice(i, i + 50),
        add,
        remove,
      })
    }
  }
  await update($, sessions, list =>
    list.map(r =>
      ids.includes(r.id)
        ? { ...r, tags: [...r.tags.filter(t => !t.startsWith(TAG)), ...add] }
        : r,
    ),
  )
  await update($, ui, u => ({ ...u, editing: null }))
  const n = ids.length === 1 ? 'Session' : `${ids.length} sessions`
  $.ui.toast(clean ? `${n} filed under ${clean}` : `${n} removed from its project`)
}

/** Copies the command that reopens a session on this computer. */
async function copyResume($: $, command: string, surface: string): Promise<void> {
  const copied = await $.ui.copy({ text: command, surface: surface as never })
  $.ui.toast(copied.isCopied ? 'Copied. Paste it in a terminal to resume.' : command)
}

async function fileSafely($: $, ids: string[], name: string): Promise<void> {
  try {
    await fileSessions($, ids, name)
  } catch (err) {
    $.ui.toast(`Couldn't file: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Drawing helpers

const COLORS = ['#d97757', '#4a7fd1', '#3fa66a', '#8a5cc7', '#c9a227', '#2fa3a3', '#d1567e', '#7a8f3a']

function colorOf(key: string): string {
  if (key === 'unsorted') return '#a8a49a'
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return COLORS[h % COLORS.length]!
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function ago(iso: string, now: number): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const min = Math.floor((now - t) / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours}h`
  if (hours < 48) return 'yesterday'
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  const d = new Date(t)
  const label = `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
  return d.getUTCFullYear() === new Date(now).getUTCFullYear() ? label : `${label} ${d.getUTCFullYear()}`
}

function dot(r: SessionRow): { glyph: string; color: string } {
  if (/WORKING/.test(r.bucket)) return { glyph: '●', color: 'success' }
  if (/FAILED/.test(r.bucket)) return { glyph: '●', color: 'error' }
  if (/BLOCKED|REVIEW_READY/.test(r.bucket)) return { glyph: '●', color: 'warning' }
  return { glyph: '○', color: 'inactive' }
}

/** The grouped list as markdown, for where no pane can be drawn. */
async function listText($: $, query: string): Promise<string> {
  const rows = await read($, sessions)
  const all = await read($, scans)
  const load = await read($, status)
  const now = await $.clock.now()
  const groups = applyFilter(
    buildGroups(rows, all, { id: load.currentId, folder: load.currentFolder }),
    'all',
    query,
  )
  const head =
    '**Projects**' +
    (query ? ` matching "${query}"` : '') +
    (load.fetchedAt ? ` · updated ${ago(new Date(load.fetchedAt).toISOString(), now)}` : '')
  if (rows.length === 0) return head + '\n\nNo sessions yet.'
  if (groups.length === 0) return head + '\n\nNothing matches.'
  const lines = [head]
  for (const g of groups) {
    const folders = g.folders.filter(f => f.toLowerCase() !== g.name.toLowerCase())
    lines.push('', `**${g.name}**${folders.length ? ` · \`${folders.join(', ')}\`` : ''} · ${g.rows.length}`)
    const shown = query ? g.rows : g.rows.slice(0, ROWS_SHOWN)
    for (const r of shown) {
      const state = /WORKING/.test(r.bucket) ? 'working · ' : needsMe(r) ? 'needs you · ' : ''
      const title = r.title.replace(/[[\]]/g, '')
      const here = r.id === load.currentId ? ' · this session' : ''
      lines.push(
        r.resume
          ? `- ${title} · ${state}${ago(r.updated, now)}${here} · \`${r.resume}\``
          : `- [${title}](https://claude.ai/code/${r.id}) · ${state}${ago(r.updated, now)}${here}`,
      )
    }
    if (shown.length < g.rows.length) {
      lines.push(`- …and ${g.rows.length - shown.length} more: \`/projects ${g.name}\``)
    }
  }
  return lines.join('\n')
}

function isOpenByDefault(g: Group, index: number, currentId: string | null, now: number): boolean {
  if (g.rows.some(r => r.id === currentId)) return true
  if (index < 2 && !g.isUnsorted) return true
  return now - Date.parse(g.latest) < 3 * 24 * 3600 * 1000
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const command of [
      { name: 'projects', description: 'Show your sessions grouped by project' },
      { name: 'file-under', description: 'File this session under a project: /file-under <name>' },
    ]) {
      try {
        await $.command.register(command)
      } catch (err) {
        $.ui.log(`session-projects: /${command.name} not registered: ${String(err)}`)
      }
    }

    const remoteId = await $.env.get('CLAUDE_CODE_REMOTE_SESSION_ID')
    const currentId = remoteId
      ? 'session_' + remoteId.replace(/^(cse|session)_/, '')
      : 'local:' + (await $.session.id())
    const cwd = normPath(e.cwd || (await $.session.cwd()))
    await update($, status, s => ({ ...s, currentId, currentFolder: isVague(cwd) ? null : cwd }))

    for (const old of ['scans', 'scans-2', 'scans-3', 'debug-sample', 'debug-bridge']) await $.store.delete(old)
    const stored = await $.store.get(STORE_SCANS)
    if (stored && typeof stored === 'object') {
      await update($, scans, all => ({ ...(stored as Record<string, FolderScan>), ...all }))
    }
    // Start from the last list this machine saw; the refresh below brings it up to date.
    const cached = (await $.store.get(STORE_SESSIONS)) as { rows?: unknown; fetchedAt?: unknown } | undefined
    if (cached && Array.isArray(cached.rows) && (await read($, sessions)).length === 0) {
      const rows = cached.rows as SessionRow[]
      const fetchedAt = typeof cached.fetchedAt === 'number' ? cached.fetchedAt : null
      await update($, sessions, () => rows)
      await update($, status, s => ({ ...s, fetchedAt: s.fetchedAt ?? fetchedAt }))
    }

    // Drawn once an app that shows plugin panes is attached; until then it waits, open.
    void $.ui.open({ id: PANE, title: 'Projects' })
    await $.store.delete('diag')
    $.clock.after(300, () => void refresh($))
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'projects' }, async ($, e) => {
    const opened = await $.ui.open({ id: PANE, title: 'Projects' })
    const query = e.args.trim()
    if (opened.isPlaced && !query) {
      $.clock.after(0, () => void refresh($))
      return { text: 'Projects pane opened.' }
    }
    // No app here draws plugin panes: answer with the list as text.
    if ((await read($, sessions)).length === 0) {
      try {
        const rows = await fetchSessions($)
        await update($, sessions, () => rows)
      } catch (err) {
        if (!isNotConnected(err)) throw err
        $.clock.after(0, () => void refresh($))
        return { text: 'Reading the sessions saved on this computer for the first time. Run `/projects` again in a few seconds.' }
      }
    }
    $.clock.after(0, () => void refresh($))
    const note = opened.isPlaced
      ? ''
      : "\n\n_This app doesn't show plugin panels, so here is the list as text. `/projects <word>` filters it._"
    return { text: (await listText($, query)) + note }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: "Couldn't load your sessions: the session service didn't answer." },
  )

  on('command.run', { command: 'file-under' }, async ($, e) => {
    const { currentId } = await read($, status)
    if (!currentId) return { text: "Can't tell which session this is, so it can't be filed." }
    const name = e.args.trim()
    if (!name) {
      const editing: Editing = { kind: 'session', id: currentId }
      await update($, ui, u => ({ ...u, editing }))
      await $.ui.open({ id: PANE, title: 'Projects' })
      return { text: 'Pick a project for this session in the Projects pane.' }
    }
    await fileSessions($, [currentId], name)
    return { text: `This session is now in ${name.trim()}.` }
  }).catch(($, e, next) =>
    next.called ? next(e) : { text: "Couldn't file this session: the session service didn't answer." },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Input } = $.ui.resolve(e)
    const rows = await read($, sessions)
    const all = await read($, scans)
    const view = await read($, ui)
    const load = await read($, status)
    const now = await $.clock.now()
    // Row actions show on hover where there is a pointer; the terminal shows them always.
    const reveal: { display?: 'none'; hover?: { display: 'flex' } } =
      e.surface === 'terminal' ? {} : { display: 'none', hover: { display: 'flex' } }

    const current = { id: load.currentId, folder: load.currentFolder }
    const groups = buildGroups(rows, all, current)
    const shown = applyFilter(groups, view.filter, view.query)
    const names = groups.filter(g => g.isNamed).map(g => g.name)
    const currentRow = rows.find(r => r.id === load.currentId)
    const currentGroup = groups.find(g => g.rows.some(r => r.id === load.currentId))

    const setUi = (fn: (u: PaneUi) => PaneUi) => update($, ui, fn)
    const edit = (editing: Editing) => setUi(u => ({ ...u, editing }))

    const editor = (ids: string[], key: string, hasProject: boolean) => (
      <Box flexDirection="column" gap="xs" paddingY="xs">
        <Input
          key={'edit-' + key}
          placeholder={ids.length > 1 ? 'Name this project' : 'Project name'}
          submitLabel="file"
          autoFocus
          onSubmit={value => {
            if (value.trim()) void fileSafely($, ids, value)
          }}
        />
        <Box flexDirection="row" flexWrap="wrap" gap="xs">
          {names.slice(0, 8).map(n => (
            <Button key={'pick-' + key + '-' + n} label={n} onPress={() => fileSafely($, ids, n)} />
          ))}
          {hasProject && (
            <Button key={'unfile-' + key} label="Remove from project" onPress={() => fileSafely($, ids, '')} />
          )}
          <Button key={'cancel-' + key} label="Cancel" onPress={() => edit(null)} />
        </Box>
      </Box>
    )

    let note = ''
    if (load.error) note = load.error
    else if (load.isLoading && load.toScan > 0) note = `Finding folders ${load.scanned}/${load.toScan}…`
    else if (load.isLoading && rows.length > 0 && load.fetchedAt)
      note = `Updated ${ago(new Date(load.fetchedAt).toISOString(), now)} · refreshing…`
    else if (load.isLoading) note = 'Loading…'
    else if (load.fetchedAt) note = `Updated ${ago(new Date(load.fetchedAt).toISOString(), now)}`

    const chip = (filter: Filter, label: string) => (
      <Button
        key={'filter-' + filter}
        label={label}
        variant={view.filter === filter ? 'primary' : 'secondary'}
        onPress={() => setUi(u => ({ ...u, filter }))}
      />
    )

    return (
      <Box flexDirection="column" gap="sm" paddingX="xs">
        <Box flexDirection="row" alignItems="center" gap="sm">
          <Box flexGrow={1}>
            <Text weight="semibold" size="heading">
              Projects
            </Text>
          </Box>
          <Text size="caption" dimColor color={load.error ? 'error' : undefined}>
            {note}
          </Text>
          <Button key="refresh" label="Refresh" plain dimColor onPress={() => void refresh($)} />
        </Box>

        {load.mode === 'local' && (
          <Text size="caption" dimColor>
            {'Sessions on this computer' + (load.cloudNote ? '. ' + load.cloudNote : ', and your cloud sessions.')}
          </Text>
        )}

        {load.currentId && (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX="sm" paddingY="xs">
            <Box flexDirection="row" alignItems="center" gap="sm">
              <Box flexGrow={1} flexShrink={1}>
                {currentGroup && !currentGroup.isUnsorted ? (
                  <Text>
                    This session is in{' '}
                    <Text color="claude" weight="semibold">
                      {currentGroup.name}
                    </Text>
                    {currentGroup.isNamed ? '' : ' (folder)'}
                  </Text>
                ) : (
                  <Text>This session isn't in a project yet</Text>
                )}
              </Box>
              <Button
                key="move-current"
                label={currentGroup && !currentGroup.isUnsorted ? 'Move…' : 'File it…'}
                onPress={() => edit({ kind: 'session', id: load.currentId! })}
              />
            </Box>
            {view.editing?.kind === 'session' &&
              view.editing.id === load.currentId &&
              editor([load.currentId], 'current', currentRow ? projectOf(currentRow) !== null : false)}
          </Box>
        )}

        <Input
          key="query"
          placeholder="Filter sessions…"
          value={view.query}
          submitLabel="filter"
          onInput={query => void setUi(u => ({ ...u, query }))}
          onSubmit={query => void setUi(u => ({ ...u, query }))}
        />
        <Box flexDirection="row" gap="xs" flexWrap="wrap">
          {chip('all', 'All')}
          {chip('needs', 'Needs me')}
          {chip('active', 'Hide archived')}
        </Box>

        {rows.length === 0 && !load.error && (
          <Text dimColor>{load.isLoading ? 'Loading your sessions…' : 'No sessions yet.'}</Text>
        )}
        {rows.length > 0 && shown.length === 0 && <Text dimColor>Nothing matches.</Text>}

        <Box flexDirection="column">
          {shown.map((g, index) => {
            const isOpen =
              view.query.trim() !== '' ||
              (view.open[g.key] ?? isOpenByDefault(g, index, load.currentId, now))
            const showAll = view.more[g.key] === true
            const visible = showAll ? g.rows : g.rows.slice(0, ROWS_SHOWN)
            const folders = g.folders.filter(f => f.toLowerCase() !== g.name.toLowerCase())
            const isEditing = view.editing?.kind === 'group' && view.editing.key === g.key
            return (
              <Box flexDirection="column" paddingTop="xs">
                <Box key={'gh-' + g.key} flexDirection="row" alignItems="center" gap="xs">
                  <Box flexGrow={1} flexShrink={1}>
                    <Button
                      key={'toggle-' + g.key}
                      plain
                      onPress={() =>
                        setUi(u => ({ ...u, open: { ...u.open, [g.key]: !isOpen } }))
                      }
                    >
                      {isOpen ? '▾ ' : '▸ '}
                      <Text color={colorOf(g.key)}>■ </Text>
                      <Text weight="semibold">{g.name}</Text>
                      {folders.length > 0 && (
                        <Text size="caption" dimColor>
                          {'  ' + folders.join(' · ')}
                        </Text>
                      )}
                      <Text size="caption" dimColor>
                        {'  ' + g.rows.length}
                      </Text>
                    </Button>
                  </Box>
                  {!g.isUnsorted && (
                    <Box {...reveal}>
                      <Button
                        key={'name-' + g.key}
                        label={g.isNamed ? 'Rename' : 'Name'}
                        plain
                        dimColor
                        onPress={() => edit(isEditing ? null : { kind: 'group', key: g.key })}
                      />
                    </Box>
                  )}
                  <Text size="caption" dimColor>
                    {ago(g.latest, now)}
                  </Text>
                </Box>
                {isEditing &&
                  editor(
                    groups.find(x => x.key === g.key)?.rows.map(r => r.id) ?? [],
                    g.key,
                    g.isNamed,
                  )}
                {isOpen && g.isUnsorted && (
                  <Text size="caption" dimColor>
                    {'   No folder found. Use Move on a row, or ask Claude to sort these.'}
                  </Text>
                )}
                {isOpen &&
                  visible.map(r => {
                    const d = dot(r)
                    const isHere = r.id === load.currentId
                    const isMoving = view.editing?.kind === 'session' && view.editing.id === r.id && !isHere
                    return (
                      <Box flexDirection="column">
                        <Box key={'row-' + r.id} flexDirection="row" alignItems="center" gap="xs" paddingLeft="md">
                          <Text color={d.color}>{d.glyph}</Text>
                          <Box flexGrow={1} flexShrink={1}>
                            {r.source === 'local' ? (
                              <Text wrap="truncate-end">{r.title}</Text>
                            ) : (
                              <Link href={'https://claude.ai/code/' + r.id} label={r.title} />
                            )}
                          </Box>
                          {isHere && (
                            <Text size="caption" dimColor>
                              this session
                            </Text>
                          )}
                          {r.isUnread && <Text color="claude">•</Text>}
                          {r.resume && !isHere && (
                            <Button
                              key={'resume-' + r.id}
                              label="Resume"
                              plain
                              dimColor
                              onPress={() => void copyResume($, r.resume!, e.surface)}
                            />
                          )}
                          {!isHere && (
                            <Box {...reveal}>
                              <Button
                                key={'move-' + r.id}
                                label="Move"
                                plain
                                dimColor
                                onPress={() => edit(isMoving ? null : { kind: 'session', id: r.id })}
                              />
                            </Box>
                          )}
                          <Text size="caption" dimColor tabular>
                            {ago(r.updated, now)}
                          </Text>
                        </Box>
                        {isMoving && editor([r.id], 'row-' + r.id, projectOf(r) !== null)}
                      </Box>
                    )
                  })}
                {isOpen && g.rows.length > ROWS_SHOWN && (
                  <Box paddingLeft="md">
                    <Button
                      key={'more-' + g.key}
                      label={showAll ? 'Show fewer' : `Show ${g.rows.length - ROWS_SHOWN} more`}
                      plain
                      onPress={() => setUi(u => ({ ...u, more: { ...u.more, [g.key]: !showAll } }))}
                    />
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>

        <Box flexDirection="row" gap="sm" flexWrap="wrap">
          <Text size="caption" dimColor>
            <Text color="success">●</Text> working <Text color="warning">●</Text> needs you ○ done{' '}
            <Text color="claude">•</Text> unread
          </Text>
        </Box>
      </Box>
    )
  })
}
