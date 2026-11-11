import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Editing, Filter, FolderScan, LoadStatus, PaneUi, SessionRow } from '../types'

const PANE = 'session-projects'
const SERVER = 'claude-code-remote'
const TAG = 'project:'
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

/** "D:\\vibe-coding\\port2port" and "/d/vibe-coding/port2port/" both become "/d/vibe-coding/port2port". */
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
    const rows = await fetchSessions($)
    await update($, sessions, () => rows)

    const { currentId } = await read($, status)
    const known = await read($, scans)
    const todo = rows.filter(r => {
      if (r.id === currentId) return false
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
    const now = await $.clock.now()
    await update($, status, s => ({ ...s, isLoading: false, fetchedAt: now, toScan: 0, scanned: 0 }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, status, s => ({
      ...s,
      isLoading: false,
      error: /not connected|unknown server|no server|not found/i.test(message)
        ? "This session can't read your session list (that needs a cloud session)."
        : message.slice(0, 160),
    }))
  } finally {
    running = false
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

/** How Claude Code names a folder's own data dirs: "D:\\vibe-coding\\mesh editor" is "d--vibe-coding-mesh-editor". */
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

  for (const { r, scan, keys, dirs } of facts) {
    if (r.id === current.id && current.folder) {
      out.set(r.id, current.folder)
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
    if (out.get(r.id)) continue
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
  for (let i = 0; i < ids.length; i += 50) {
    await callText($, 'set_session_tags', {
      session_ids: ids.slice(i, i + 50),
      add,
      remove,
    })
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
    const currentId = remoteId ? 'session_' + remoteId.replace(/^(cse|session)_/, '') : null
    const cwd = normPath(e.cwd || (await $.session.cwd()))
    await update($, status, s => ({ ...s, currentId, currentFolder: isVague(cwd) ? null : cwd }))

    for (const old of ['scans', 'scans-2', 'scans-3', 'debug-sample', 'debug-bridge']) await $.store.delete(old)
    const stored = await $.store.get(STORE_SCANS)
    if (stored && typeof stored === 'object') {
      await update($, scans, all => ({ ...(stored as Record<string, FolderScan>), ...all }))
    }

    void $.ui.open({ id: PANE, title: 'Projects' })
    $.clock.after(300, () => void refresh($))
    $.clock.every(REFRESH_MS, () => void refresh($))

    return next(e)
  })

  on('command.run', { command: 'projects' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Projects' })
    $.clock.after(0, () => void refresh($))
    return { text: 'Projects pane opened.' }
  })

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
                            <Link href={'https://claude.ai/code/' + r.id} label={r.title} />
                          </Box>
                          {isHere && (
                            <Text size="caption" dimColor>
                              this session
                            </Text>
                          )}
                          {r.isUnread && <Text color="claude">•</Text>}
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
