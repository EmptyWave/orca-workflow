// `orca plugin check` renders the panel once per scenario, each with the worker on a fresh
// host. The bridge cannot reach a real terminal there, so terminal reads fail fast and the
// panel renders the storage snapshot the worker keeps in `state.snapshot`.
import { defineCheck, hostError } from 'orca/testing'

/** The bridge dies immediately: the panel shows its cached snapshot or the error callout. */
const results: Record<string, unknown> = {
  'workspace.readContext': {
    branch: 'master',
    displayName: 'biz.erp',
    terminals: []
  },
  'workspace.list': {
    workspaces: [{ id: 'w1', kind: 'worktree', name: 'biz.erp', path: '/x/biz.erp', branch: 'master', project: 'p', hostId: 'local' }],
    truncated: false
  },
  'terminal.create': { terminalId: 't-check' },
  'terminal.sendText': { accepted: true },
  'terminal.read': () => {
    throw hostError('unavailable', 'check: мост недоступен')
  },
  'statusBar.update': { ok: true }
}

export default defineCheck({
  fresh: { results },
  withRun: {
    results,
    storage: {
      'state.snapshot': {
        at: 1731400000000,
        run: { runId: 'run_1', objective: 'YCLYT-104 biz.erp: переименование Booking/Pinpin -> Momento' },
        tasks: [
          { id: 'task_a', title: 'plan План (openspec)', status: 'succeeded', deps: [], dispatchId: 'ctx_1', agent: 'claude', model: 'sonnet-4.6' },
          { id: 'task_b', title: 'plan-review Ревью плана', status: 'succeeded', deps: ['task_a'], dispatchId: 'ctx_2', agent: 'claude', model: 'sonnet-4.6' },
          { id: 'task_c', title: 'dev Разработка', status: 'blocked', deps: ['task_b'], dispatchId: null, agent: null, model: 'sonnet-4.6' },
          { id: 'task_d', title: 'commit Коммит', status: 'pending', deps: ['task_e', 'task_f'], dispatchId: null, agent: null, model: null }
        ],
        gates: [
          {
            id: 'gate_1',
            taskId: 'task_c',
            taskTitle: 'dev Разработка',
            question: 'План аппрувнут? Запускать разработку?',
            options: ['approve', 'request-changes'],
            status: 'pending'
          }
        ],
        workers: [
          { dispatchId: 'ctx_1', taskId: 'task_a', taskTitle: 'plan План (openspec)', state: 'succeeded' },
          { dispatchId: 'ctx_2', taskId: 'task_b', taskTitle: 'plan-review Ревью плана', state: 'succeeded' }
        ],
        error: null
      }
    }
  },
  withError: {
    results,
    storage: {
      'state.snapshot': {
        at: 1731400000000,
        run: null,
        tasks: [],
        gates: [],
        workers: [],
        error: 'мост: таймаут 25000 мс для команды: orca orchestration run-list'
      }
    }
  },
  settings: {
    results,
    persisted: { plugin: { 'ui.tab': 'settings' } },
    settings: {
      libraryDir: '~/orca-plugins/workflow-view/workflows',
      refreshMs: 10000,
      defaultAgent: 'claude'
    },
    storage: { 'bridge.terminalId': 'term_92fe4436-d1fa-491b-89b4-e7598725dd88' }
  }
})
