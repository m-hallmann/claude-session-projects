import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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
  row('session_a', 'Fix login redirect', { tags: ['project:Bird app'] }),
  row('session_b', 'Timer stops after resume', { updated: '2026-09-13T10:00:00Z' }),
  row('session_c', 'Add CSV export', { updated: '2026-09-02T10:00:00Z' }),
  row('session_d', 'Compare charting libraries', { updated: '2026-08-20T10:00:00Z' }),
  row('session_e', 'Read the API docs', {
    updated: '2026-09-01T10:00:00Z',
    status: 'SESSION_STATUS_IDLE',
    bucket: 'SESSION_STATUS_BUCKET_REVIEW_READY',
  }),
]

const SCANS: Record<string, FolderScan> = {
  session_a: { folder: '/d/projects/birdwatch', paths: [], updated: '' },
  session_b: { folder: '/d/projects/birdwatch', paths: [], updated: '' },
  session_c: { folder: '/d/projects/kiln-app', paths: [], updated: '' },
  session_d: { folder: null, paths: [], updated: '' },
  // No command ran in a folder, but it read a file inside kiln-app.
  session_e: { folder: null, paths: ['/d/projects/kiln-app/docs'], updated: '' },
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
    expect(await ui.find({ type: 'Text', text: /^Bird app$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /birdwatch/ })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: /Timer stops after resume/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /This session is in/ })).toBeDefined()

    // A folder nobody named is a group under the folder's own name.
    expect(await ui.find({ type: 'Text', text: /^kiln-app$/ })).toBeDefined()
    // ...and a session that only read files there is matched to it.
    const kilnCount = await ui.find({ type: 'Text', text: /^\s+2$/ })
    expect(kilnCount).toBeDefined()

    expect(await ui.find({ type: 'Text', text: /^Unsorted$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the Needs me filter keeps only sessions waiting on you', async ($, on) => {
  seed(on, { ...UI, filter: 'needs' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link', text: /Read the API docs/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Timer stops after resume/ })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-p:bird app' })).toBeUndefined()
  expect(await ui.find({ key: 'toggle-f:/d/projects/kiln-app' })).toBeDefined()
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
    row('m1', 'Pick a UI kit', { updated: '2026-10-01T10:00:00Z' }),
    row('m2', 'Audit the color tokens', { updated: '2026-10-02T10:00:00Z' }),
    row('m3', 'Undo for drag and drop', { updated: '2026-10-03T10:00:00Z' }),
    row('o1', 'Flood map prototype', { updated: '2026-10-04T10:00:00Z' }),
  ]
  const scans: Record<string, FolderScan> = {
    // Its memory dir names the folder, and it read files there.
    m1: {
      folder: null,
      paths: ['/c/Users/me/.claude/projects/D--projects-tile-studio/memory', '/d/projects/tile studio/docs'],
      updated: '',
    },
    // Only a scratchpad, named after the folder.
    m2: {
      folder: null,
      paths: ['/c/Users/me/AppData/Local/Temp/claude/D--projects-tile-studio/abc/scratchpad'],
      updated: '',
    },
    // Worked in a worktree of it.
    m3: { folder: null, paths: ['/d/projects/tile studio/.claude/worktrees/x/app/src'], updated: '' },
    // Files deep inside one folder only.
    o1: { folder: null, paths: ['/d/projects/river-sim/docs', '/d/projects/river-sim/crates/a'], updated: '' },
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
  expect(await ui.find({ type: 'Text', text: /^tile studio$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^river-sim$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Unsorted$/ })).toBeUndefined()
  await ui.unmount()
})

test('a folder tag places a session without reading it, and "none" keeps it unsorted', async ($, on) => {
  const rows: SessionRow[] = [
    row('t1', 'Fix login redirect', { tags: ['folder:/d/projects/birdwatch'] }),
    row('t2', 'Timer stops after resume', { tags: ['folder:/d/projects/birdwatch'] }),
    row('t3', 'Compare charting libraries', { tags: ['folder:none'] }),
  ]
  const values: Record<string, unknown> = {
    sessions: { shape: 'sessions-1', value: rows },
    // Nothing scanned on this machine yet.
    scans: { shape: 'scans-4', value: {} },
    ui: { shape: 'ui-1', value: UI },
    status: { shape: 'status-1', value: { ...STATUS, currentId: null } },
  }
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^birdwatch$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\s+2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Unsorted$/ })).toBeDefined()
  await ui.unmount()
})

test('a stale list says it is being refreshed', async ($, on) => {
  const values: Record<string, unknown> = {
    sessions: { shape: 'sessions-1', value: SESSIONS },
    scans: { shape: 'scans-4', value: SCANS },
    ui: { shape: 'ui-1', value: UI },
    status: {
      shape: 'status-1',
      value: { ...STATUS, isLoading: true, fetchedAt: Date.parse('2026-11-11T11:00:00Z') },
    },
  }
  on('clock.now', () => ({ value: Date.parse('2026-11-11T12:00:00Z') }))
  on('state.get', (_, e) => ({ value: { value: values[(e as { key: string }).key], version: 1 } }))

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Updated 1h · refreshing/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Timer stops after resume/ })).toBeDefined()
  await ui.unmount()
})

test('on start the pane shows the list this machine saved last time', async ($, on) => {
  mock.clock(on, { now: Date.parse('2026-11-11T12:00:00Z') })
  mock.env(on, { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_b' })
  mock.store(on, {
    'sessions-1': { rows: SESSIONS, fetchedAt: Date.parse('2026-11-11T09:00:00Z') },
    'scans-4': SCANS,
  })
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/home/user', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Bird app$/ })).toBeDefined()
  expect(await ui.find({ type: 'Link', text: /Timer stops after resume/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Updated 3h/ })).toBeDefined()
  await ui.unmount()
})
