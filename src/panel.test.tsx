// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { WfSnapshot } from './protocol'

const SNAPSHOT: WfSnapshot = {
  at: 1731400000000,
  run: { runId: 'run_1', objective: 'YCLYT-104: переименование' },
  tasks: [
    { id: 'task_a', title: 'plan План', status: 'succeeded', deps: [], dispatchId: 'ctx_1', agent: 'claude' },
    { id: 'task_c', title: 'dev Разработка', status: 'ready', deps: ['task_a'], dispatchId: null, agent: null }
  ],
  gates: [
    {
      id: 'gate_1',
      taskId: 'task_c',
      taskTitle: 'dev Разработка',
      question: 'План аппрувнут?',
      options: ['approve', 'request-changes'],
      status: 'pending'
    }
  ],
  workers: [{ dispatchId: 'ctx_1', taskId: 'task_a', taskTitle: 'plan План', state: 'succeeded' }],
  error: null
}

test('рисует шаги, гейты и воркеров из снапшота', async () => {
  const host = mockHost({
    storage: { 'state.snapshot': SNAPSHOT, 'state.selectedRunId': 'run_1' },
    requests: {
      'runs.list': { runs: [{ runId: 'run_1', objective: 'YCLYT-104: переименование' }], error: null },
      'state.get': SNAPSHOT,
      'workspaces.list': { workspaces: [{ id: 'w1', kind: 'worktree', name: 'ycl-104-momento', path: '/x', branch: 'b' }] }
    }
  })
  const view = await mount(panel, { host })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const summary = view.summary().join('\n')
  assert.ok(summary.includes('Table "Шаги": 2 row(s)'), `таблица шагов видна: ${summary}`)
  assert.ok(summary.includes('Tabs "Раздел": "Runs" selected'), 'вкладка Runs выбрана')
  assert.ok(view.find({ text: 'request-changes' }), 'кнопка гейта видна')
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  await view.unmount()
})

test('кнопка гейта зовёт gate.resolve с выбранной резолюцией', async () => {
  const host = mockHost({
    storage: { 'state.snapshot': SNAPSHOT, 'state.selectedRunId': 'run_1' },
    requests: {
      'runs.list': { runs: [{ runId: 'run_1', objective: 'x' }], error: null },
      'state.get': SNAPSHOT,
      'workspaces.list': { workspaces: [] },
      'gate.resolve': (input: { gateId: string; resolution: string }) => {
        assert.equal(input.gateId, 'gate_1')
        assert.equal(input.resolution, 'request-changes')
        return { ok: true }
      }
    }
  })
  const view = await mount(panel, { host })
  await view.press({ text: 'request-changes' })
  const requests = host.callsOf('plugin.request') as Array<{ name: string; input?: unknown }>
  assert.ok(
    requests.some((r) => r.name === 'gate.resolve'),
    'gate.resolve отправлен'
  )
  assert.deepEqual(view.refusals.filter((r) => r.method === 'plugin.request'), [])
  await view.unmount()
})

test('вкладка Templates: пустая библиотека показывает подсказку', async () => {
  const host = mockHost({
    storage: {},
    requests: {
      'runs.list': { runs: [], error: null },
      'state.get': { at: 1, run: null, tasks: [], gates: [], workers: [], error: null },
      'workspaces.list': { workspaces: [] },
      'template.list': { templates: [] }
    }
  })
  // The Tab control is not pressable in the harness: start on the Templates tab instead.
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab': 'templates' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const summary = view.summary().join('\n')
  assert.ok(summary.includes('EmptyState "Шаблонов нет"'), `пустое состояние видно: ${summary}`)
  await view.unmount()
})
