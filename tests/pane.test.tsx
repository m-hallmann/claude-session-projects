import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import type { FolderScan, LoadStatus, PaneUi, SessionRow } from '../types'

const PANE = {
  plugin: 'session-projects',
  component: 'Pane',
  requestId: 'session-projects',
  props: {
    title: 'Projects',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const row = (id: string, title: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  title,
  status: 'SESSION_STATUS_ARCHIVED',
  bucket: 'SESSION_STATUS_BUCKET_COMPLETED',
  updated: '2026-09-12T10:00:00Z',
  tags: [],
  isUnread: false,
  ...extra,
})

const SESSIONS: SessionRow[] = [
  row('session_a', 'Freight plane strategy losses', { tags: ['project:Freight game'] }),
  row('session_b', 'Game time not progressing', { updated: '2026-09-13T10:00:00Z' }),
  row('session_c', 'STL resize and scale feature', { updated: '2026-09-02T10:00:00Z' }),
  row('session_d', 'HoloLens ecosystem state', { updated: '2026-08-20T10:00:00Z' }),
  row('session_e', 'Read STL docs', {
    updated: '2026-09-01T10:00:00Z',
    status: 'SESSION_STATUS_IDLE',
    bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
  }),
]

const SCANS: Record<string, FolderScan> = {
  session_a: { folder: '/d/vibe-coding/port2port', paths: [], updated: '' },
  session_b: { folder: '/d/vibe-coding/port2port', paths: [], updated: '' },
  session_c: { folder: '/d/vibe-coding/stl-tool', paths: [], updated: '' },
  session_d: { folder: null, paths: [], updated: '' },
  // No command ran in a folder, but it read a file inside stl-tool.
  session_e: { folder: null, paths: ['/d/vibe-coding/stl-tool/docs'], updated: '' },
}

const UI: PaneUi = { filter: 'all', query: '', open: {}, more: {}, editing: null }

const STATUS: LoadStatus = {
  isLoading: false,
  scanned: 0,
  toScan: 0,
  error: null,
  fetchedAt: null,
  currentId: 'session_b',
  currentFolder: null,
}

function seed(on: On, ui: PaneUi = UI) {
  const values: Record<string, unknown> = {
    sessions: { shape: 'sessions-1', value: SESSIONS },
    scans: { shape: 'scans-4', value: SCANS },
    ui: { shape: 'ui-1', value: ui },
    status: { shape: 'status-1', value: STATUS },
  }
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('state.get', (_, e) => {
    const key = (e as { key: string }).key
    return { value: { value: values[key], version: 1 } }
  })
}

test('groups by project and folder, with the folder after the title', async ($, on) => {
  seed(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // The tagged session names the project; its folder-mate joins it.
    expect(await ui.find({ type: 'Text', text: /^Freight game$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /port2port/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Game time not progressing/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /This session is in/ })).toBeDefined()

    // A folder nobody named is a group under the folder's own name.
    expect(await ui.find({ type: 'Text', text: /^stl-tool$/ })).toBeDefined()
    // ...and a session that only read files there is matched to it.
    const stlCount = await ui.find({ type: 'Text', text: /^\s+2$/ })
    expect(stlCount).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /^Unsorted$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the Needs me filter keeps only sessions waiting on you', async ($, on) => {
  seed(on, { ...UI, filter: 'needs' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Read STL docs/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Game time not progressing/ })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-p:freight game' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-f:/d/vibe-coding/stl-tool' })).toBeDefined()
  await ui.unmount()
})

test('an empty list says so', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('state.get', () => ({ value: { value: undefined, version: 0 } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No sessions yet/ })).toBeDefined()
  await ui.unmount()
})

test('a session with no folder of its own is placed by its data dirs and files', async ($, on) => {
  const rows: SessionRow[] = [
    row('m1', 'Mesh editor UI kit evaluation', { updated: '2026-10-01T10:00:00Z' }),
    row('m2', 'Design system audit', { updated: '2026-10-02T10:00:00Z' }),
    row('m3', 'Split for print', { updated: '2026-10-03T10:00:00Z' }),
    row('o1', 'Ship sensor prototype', { updated: '2026-10-04T10:00:00Z' }),
  ]
  const scans: Record<string, FolderScan> = {
    // Its memory dir names the folder, and it read files there.
    m1: {
      folder: null,
      paths: ['/c/Users/me/.claude/projects/D--vibe-coding-mesh-editor/memory', '/d/vibe-coding/mesh editor/docs'],
      updated: '',
    },
    // Only a scratchpad, named after the folder.
    m2: {
      folder: null,
      paths: ['/c/Users/me/AppData/Local/Temp/claude/D--vibe-coding-mesh-editor/abc/scratchpad'],
      updated: '',
    },
    // Worked in a worktree of it.
    m3: { folder: null, paths: ['/d/vibe-coding/mesh editor/.claude/worktrees/x/app/src'], updated: '' },
    // Files deep inside one folder only.
    o1: { folder: null, paths: ['/d/vibe-coding/orbital-combat/docs', '/d/vibe-coding/orbital-combat/crates/a'], updated: '' },
  }
  const values: Record<string, unknown> = {
    sessions: { shape: 'sessions-1', value: rows },
    scans: { shape: 'scans-4', value: scans },
    ui: { shape: 'ui-1', value: UI },
    status: { shape: 'status-1', value: { ...STATUS, currentId: null } },
  }
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^mesh editor$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^orbital-combat$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Unsorted$/ })).toBeUndefined()
  await ui.unmount()
})
