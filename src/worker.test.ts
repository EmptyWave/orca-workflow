// Runs src/worker.ts over a mock host whose terminal answers the CLI bridge with canned
// JSON per command, the way the real bridge captures between markers.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import * as main from './worker'

const TEMPLATE_YAML = `id: demo
title: Демо
steps:
  - id: plan
    agent: claude
    specFile: specs/plan.md
  - id: gate1
    deps: [plan]
    gate: { question: 'Пускать dev?', options: [approve, request-changes] }
  - id: dev
    agent: claude
    specFile: specs/dev.md
    deps: [gate1]
    gate: { question: 'Отчёт принят?', options: [approve, request-changes] }
`

function makeHost() {
  let sends = 0
  let lastCommand = ''
  const LS_DIR = '/Users/tester/orca-plugins/workflow-view/workflows'
  const canned = (command: string): string => {
    const dir = LS_DIR
    if (command.includes('run-list')) {
      return '{"ok":true,"result":{"runs":[{"runId":"run_1","objective":"Демо — цель"}]}}'
    }
    if (command.includes('--ready')) {
      return '{"ok":true,"result":{"tasks":[{"id":"task_b","taskTitle":"dev Разработка"}]}}'
    }
    if (command.includes('task-list')) {
      return JSON.stringify({
        ok: true,
        result: {
          tasks: [
            { id: 'task_a', taskTitle: 'plan План', status: 'succeeded', deps: [] },
            { id: 'task_b', taskTitle: 'dev Разработка', status: 'pending', deps: ['task_a'] }
          ]
        }
      })
    }
    if (command.includes('gate-list')) {
      return JSON.stringify({
        ok: true,
        result: {
          gates: [{ id: 'gate_1', taskId: 'task_b', status: 'pending', question: 'Пускать dev?', options: ['approve', 'request-changes'] }]
        }
      })
    }
    if (command.includes('worker-list')) {
      return '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_1","taskId":"task_a","state":"succeeded","agent":"claude"}]}}'
    }
    if (command.includes('run-create')) {
      return '{"ok":true,"result":{"runId":"run_2"}}'
    }
    if (command.includes('task-create')) {
      return '{"ok":true,"result":{"taskId":"task_new","id":"task_new"}}'
    }
    if (command.includes('gate-create')) {
      return '{"ok":true,"result":{"gateId":"gate_new"}}'
    }
    if (command.includes('worker-start')) {
      return '{"ok":true,"result":{"dispatchId":"ctx_9","state":"ready"}}'
    }
    if (command.includes('repo list')) {
      return JSON.stringify({
        ok: true,
        result: {
          repos: [
            { id: 'r1', displayName: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp', kind: 'git' },
            { id: 'f1', displayName: '~', path: '/Users/tester', kind: 'folder' }
          ]
        }
      })
    }
    if (command.includes('__WF_ALIVE__')) {
      return '__WF_ALIVE__'
    }
    if (command.includes('terminal list')) {
      return JSON.stringify({
        ok: true,
        result: {
          terminals: [{ handle: 't1', title: 'workflow-view bridge' }]
        }
      })
    }
    if (command.includes('echo $HOME')) {
      return '/Users/tester'
    }
    if (command.includes('__WF_LS__')) {
      return '__WF_LS__demo.yaml'
    }
    if (command.includes('__FILE__')) {
      // One bridge command cats several files: answer with a marker per `cat '<dir>/<rel>'`.
      const chunks: string[] = []
      for (const match of command.matchAll(/cat '([^']+)'/g)) {
        const rel = match[1].slice(dir.length + 1)
        chunks.push(`__FILE__${rel}`)
        if (rel === 'demo.yaml') chunks.push(TEMPLATE_YAML)
        else if (rel === 'specs/plan.md') chunks.push('PLAN SPEC {{objective}}')
        else chunks.push('DEV SPEC {{objective}}')
      }
      return chunks.join('\n')
    }
    return ''
  }
  return mockHost({
    storage: {},
    results: {
      'workspace.list': {
        workspaces: [{ id: 'w1', kind: 'worktree', name: 'biz.erp', path: '/x/biz.erp', branch: 'master', project: 'p', hostId: 'local' }],
        truncated: false
      },
      'terminal.create': { terminalId: 't1' },
      'terminal.sendText': (params: { text: string }) => {
        sends += 1
        lastCommand = params.text
        return { accepted: true }
      },
      'terminal.read': () => ({
        lines: [`__WF${sends}B__`, canned(lastCommand), `__WF${sends}E_0__`],
        truncated: false
      }),
      'statusBar.update': { ok: true }
    }
  })
}

/** Every test deactivates its worker even when an assertion fails: the interval would keep
 *  the node:test child process alive forever otherwise. */
async function withWorker(fn: (worker: Awaited<ReturnType<typeof mountWorker>>, host: MockHost) => Promise<void>): Promise<void> {
  const host = makeHost()
  const worker = await mountWorker(main, { host })
  try {
    await fn(worker, host)
  } finally {
    await worker.deactivate()
  }
}

test('runs.list и state.get читают оркестрацию через мост', () =>
  withWorker(async (worker) => {
    const runs = await worker.request('runs.list')
    assert.deepEqual(runs.runs, [{ runId: 'run_1', objective: 'Демо — цель' }])
    assert.equal(runs.error, null)

    const state = await worker.request('state.get', { runId: 'run_1' })
    assert.equal(state.error, null)
    assert.equal(state.tasks.length, 2)
    assert.equal(state.tasks[0].status, 'succeeded')
    assert.equal(state.tasks[1].status, 'ready')
    assert.equal(state.gates[0].taskId, 'task_b')
    assert.equal(state.workers[0].dispatchId, 'ctx_1')
    assert.equal(state.tasks[1].agent, null)
  }))

test('template.list читает библиотеку и резолвит specFile', () =>
  withWorker(async (worker) => {
    const answer = await worker.request('template.list', { source: 'library', projectPath: null })
    assert.equal(answer.templates.length, 1)
    const template = answer.templates[0]
    assert.equal(template.id, 'demo')
    assert.equal(template.error, null)
    assert.equal(template.steps.length, 3)
    assert.equal(template.steps[0].spec, 'PLAN SPEC {{objective}}')
  }))

test('template.instantiate создаёт Run, задачи и гейты барьера', () =>
  withWorker(async (worker, host) => {
    const { jobId } = await worker.request('template.instantiate', {
      source: 'library',
      projectPath: null,
      templateId: 'demo',
      objective: 'цель X',
      baseBranch: null,
      worktreeName: 'demo-wt',
      agent: 'claude'
    })
    let job = null as null | { status: string; runId: string | null; error: string | null }
    for (let i = 0; i < 60; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      job = (await worker.request('job.get', { jobId })).job
      if (job && job.status !== 'running') break
    }
    assert.ok(job, 'job должен записаться')
    assert.equal(job.status, 'done', job.error ?? '')
    assert.equal(job.runId, 'run_2')
    const commands = host.callsOf('terminal.sendText').map((c) => (c as { text: string }).text)
    assert.equal(commands.filter((c) => c.includes('task-create')).length, 2, 'plan + dev')
    // Гейт барьера gate1 + собственный гейт dev — оба на задаче dev (task_new).
    assert.equal(commands.filter((c) => c.includes('gate-create') && c.includes('task_new')).length, 2)
    const specWrite = commands.find((c) => c.includes('base64 -d'))
    assert.ok(specWrite, 'спека пишется через base64')
  }))

test('settings.save нормализует и пишет настройки; bridge.reset чистит handle', () =>
  withWorker(async (worker, host) => {
    const saved = await worker.request('settings.save', {
      libraryDir: '  ',
      refreshMs: 500,
      defaultAgent: '  codex '
    })
    assert.equal(saved.libraryDir, '~/orca-plugins/workflow-view/workflows', 'пустой путь -> дефолт')
    assert.equal(saved.refreshMs, 2000, 'интервал зажат снизу')
    assert.equal(saved.defaultAgent, 'codex', 'агент обрезан')
    assert.deepEqual(host.data().settings, {
      libraryDir: '~/orca-plugins/workflow-view/workflows',
      refreshMs: 2000,
      defaultAgent: 'codex'
    })
    const read = await worker.request('settings.get')
    assert.equal(read.refreshMs, 2000)
    await worker.request('bridge.reset')
    assert.equal((host.data().storage['bridge.terminalId'] ?? null), null)
    const info = await worker.request('bridge.info')
    assert.equal(info.terminalId, null)
  }))

test('projects.list отдаёт git-репозитории с путями', () =>
  withWorker(async (worker) => {
    const answer = await worker.request('projects.list')
    assert.deepEqual(answer.projects, [
      { repoId: 'r1', name: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp' }
    ])
  }))

test('gate.resolve и task.start доходят до CLI с флагами', () =>
  withWorker(async (worker, host) => {
    await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'approve' })
    await worker.request('task.start', {
      taskId: 'task_b',
      agent: 'claude',
      model: 'some-model',
      effort: 'high',
      worktree: 'name:ycl-104-momento'
    })
    const commands = host.callsOf('terminal.sendText').map((c) => (c as { text: string }).text)
    const resolve = commands.find((c) => c.includes('gate-resolve'))
    assert.ok(resolve?.includes("'approve'"), 'резолюция передана')
    const start = commands.find((c) => c.includes('worker-start'))
    assert.ok(start?.includes('--model') && start.includes("'some-model'"), 'модель передана')
    assert.ok(start?.includes('--effort') && start.includes("'high'"), 'effort передан')
    assert.ok(start?.includes("'name:ycl-104-momento'"), 'ворктри передан')
  }))
