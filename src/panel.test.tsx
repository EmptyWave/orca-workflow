// `orca plugin test .` runs this in Node with the same runtime and checks Orca uses.
import { assert, mockHost, mount, test } from 'orca/testing'
import * as panel from './panel'
import type { WfSnapshot } from './protocol'

const SNAPSHOT: WfSnapshot = {
  at: 1731400000000,
  run: { runId: 'run_1', objective: 'YCLYT-104: переименование' },
  tasks: [
    { id: 'task_a', title: 'plan План', status: 'succeeded', deps: [], dispatchId: 'ctx_1', agent: 'claude', model: 'sonnet-4.6' },
    { id: 'task_c', title: 'dev Разработка', status: 'ready', deps: ['task_a'], dispatchId: null, agent: null, model: null }
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
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab2': 'runs' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const summary = view.summary().join('\n')
  assert.ok(summary.includes('List "Шаги": 2 item(s)'), `список шагов виден: ${summary}`)
  assert.ok(summary.includes('Tabs "Раздел": "Запуски" selected'), 'вкладка Запуски выбрана')
  assert.ok(view.find({ text: 'request-changes' }), 'кнопка гейта видна')
  assert.ok(view.find({ text: /🤖 sonnet-4\.6/ }), 'чип модели у шага plan')
  assert.ok(!view.find({ text: /🤖 claude$/ }), 'шаг без модели не получает чип агента вперёд модели')
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
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab2': 'runs' } } })
  await view.press({ text: 'request-changes' })
  const requests = host.callsOf('plugin.request') as Array<{ name: string; input?: unknown }>
  assert.ok(
    requests.some((r) => r.name === 'gate.resolve'),
    'gate.resolve отправлен'
  )
  assert.deepEqual(view.refusals.filter((r) => r.method === 'plugin.request'), [])
  await view.unmount()
})

test('вкладка Шаблоны: селектор + карандаш, полные данные рендерятся без ошибок', async () => {
  const steps = Array.from({ length: 8 }, (_, i) => ({
    id: `step${i}`,
    title: `Шаг ${i}`,
    specialist: null,
    agent: i % 3 === 0 ? 'claude' : null,
    model: null,
    effort: null,
    spec: 'SPEC '.repeat(200),
    specFile: i % 2 ? `specs/s${i}.md` : null,
    deps: i ? [`step${i - 1}`] : [],
    gate: i % 2 ? { question: 'Готов?'.repeat(50), options: ['approve', 'request-changes'] } : null,
    onReject: null,
    sub: []
  }))
  const tpl = {
    id: 'task-dev',
    title: 'biz.erp: фича — план → ревью → разработка → ревью кода → тесты → коммит',
    source: 'project' as const,
    sourcePath: '/x',
    file: 'workflow.yaml',
    steps,
    error: null
  }
  const host = mockHost({
    storage: {},
    requests: {
      'runs.list': { runs: [], error: null },
      'state.get': { at: 1, run: null, tasks: [], gates: [], workers: [], error: null },
      'workspaces.list': { workspaces: [] },
      'projects.list': { projects: [{ repoId: 'r1', name: 'biz.erp', path: '/x' }] },
      'project.current': { project: { repoId: 'r1', name: 'biz.erp', path: '/x' } },
      'template.list': { templates: [tpl] },
      'settings.get': { libraryDir: '~/l', refreshMs: 10000, defaultAgent: 'claude' },
      'bridge.info': { terminalId: null }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab2': 'templates' } } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(view.errors, [], 'Orca не должен отказывать в раскладке')
  assert.ok(view.find({ label: 'Шаблон' }), 'селектор шаблона виден')
  assert.ok(view.find({ label: 'Редактировать шаблон' }), 'карандаш виден')
  await view.unmount()
})

test('вкладка Настройки показывает значения и мост', async () => {
  const host = mockHost({
    storage: {},
    requests: {
      'runs.list': { runs: [], error: null },
      'state.get': { at: 1, run: null, tasks: [], gates: [], workers: [], error: null },
      'workspaces.list': { workspaces: [] },
      'settings.get': { libraryDir: '~/my-lib', refreshMs: 5000, defaultAgent: 'codex' },
      'bridge.info': { terminalId: 'term_1' }
    }
  })
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab2': 'settings' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(view.find({ text: 'Сохранить' }), 'кнопка сохранения видна')
  assert.ok(view.find({ text: 'Пересоздать мост' }), 'кнопка моста видна')
  assert.ok(view.find({ label: 'Каталог библиотеки шаблонов' }), 'поле каталога видно')
  assert.deepEqual(view.errors, [])
  await view.unmount()
})

test('вкладка Templates: пустой проект показывает подсказку', async () => {
  const host = mockHost({
    storage: {},
    requests: {
      'runs.list': { runs: [], error: null },
      'state.get': { at: 1, run: null, tasks: [], gates: [], workers: [], error: null },
      'workspaces.list': { workspaces: [] },
      'projects.list': { projects: [{ repoId: 'r1', name: 'biz.erp', path: '/x/biz.erp' }] },
      'project.current': { project: { repoId: 'r1', name: 'biz.erp', path: '/x/biz.erp' } },
      'template.list': (input: { source: string; projectPath: string | null }) => {
        assert.equal(input.source, 'project', 'источник по умолчанию — проект')
        assert.equal(input.projectPath, '/x/biz.erp', 'проект берётся из фокуса, без выбора руками')
        return { templates: [] }
      },
      'settings.get': { libraryDir: '~/l', refreshMs: 10000, defaultAgent: 'claude' },
      'bridge.info': { terminalId: null }
    }
  })
  // The Tab control is not pressable in the harness: start on the Templates tab instead.
  const view = await mount(panel, { host, persisted: { plugin: { 'ui.tab2': 'templates' } } })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const summary = view.summary().join('\n')
  assert.ok(summary.includes('EmptyState "Шаблонов нет"'), `пустое состояние видно: ${summary}`)
  await view.unmount()
})
