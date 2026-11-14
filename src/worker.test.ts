// Runs src/worker.ts over a mock host whose terminal answers the CLI bridge with canned
// JSON per command, the way the real bridge captures between markers.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import * as main from './worker'
import { spawnHooks } from './bridge'

const TEMPLATE_YAML = `id: demo
title: Демо
steps:
  - id: plan
    worker: planner
    sub:
      - { id: research, worker: researcher, optional: true }
  - { id: review, worker: reviewer, on_reject: { goto: plan, max_rounds: 2 } }
  - id: tests
    sub:
      - { id: test-api, worker: tester }
      - { id: test-ui, worker: tester }
  - id: commit
    worker: committer
    deps: [tests]
    gate: { question: 'Коммитить?', options: [approve, request-changes] }
`

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function makeHost(opts: { focus?: string; storage?: Record<string, unknown> } = {}) {
  let created = 0
  const LS_DIR = '/Users/tester/orca-plugins/workflow-view/workflows'
  const canned = (command: string): string => {
    const dir = LS_DIR
    // Терминал-помощник для --from создаётся CLI-командой — тоже спавном.
    if (command.includes('orca terminal create') && command.includes('workflow-view-runner')) {
      return '{"ok":true,"result":{"terminal":{"handle":"t_helper"}}}'
    }
    // Мутации оркестрации требуют идентичность отправителя, как настоящий CLI.
    const mutation = / (run-create|task-create|gate-create|gate-resolve|task-update|worker-start|run-use|send) /.test(command)
    if (mutation && !command.includes('--from')) {
      throw new Error('no_active_sender_terminal: Could not determine the calling terminal for this orchestration command. Pass --from with your own terminal handle.')
    }
    if (command.includes('orca terminal close')) {
      return ''
    }
    if (command.includes('__WF_PROJ__')) {
      // The workflow-dirs probe: only the biz.erp project has .orca/workflows|workers.
      return command.includes('/Users/tester/PhpstormProjects/biz.erp') ? '__WF_PROJ__' : ''
    }
    if (command.includes('run-list')) {
      return '{"ok":true,"result":{"runs":[{"runId":"run_1","objective":"Демо — цель"}]}}'
    }
    if (command.includes('--ready')) {
      return '{"ok":true,"result":{"tasks":[{"id":"task_b","taskTitle":"dev Разработка"}]}}'
    }
    if (command.includes('task-list') && !command.includes('--ready')) {
      // The concise CLI view: unordered, deps packed as JSON strings — both must survive.
      return JSON.stringify({
        ok: true,
        result: {
          tasks: [
            { id: 'task_b', title: 'dev Разработка', status: 'pending', deps: '["task_a"]' },
            { id: 'task_a', title: 'plan План', status: 'succeeded' }
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
    if (command.includes('gate-resolve') || command.includes('task-update')) {
      return '{"ok":true,"result":{}}'
    }
    if (command.includes('run-create')) {
      return '{"ok":true,"result":{"runId":"run_2"}}'
    }
    if (command.includes('task-create')) {
      created += 1
      const id = `task_${created}`
      return JSON.stringify({ ok: true, result: { taskId: id, id } })
    }
    if (command.includes('gate-create')) {
      return '{"ok":true,"result":{"gateId":"gate_new"}}'
    }
    if (command.includes('worker-start')) {
      return '{"ok":true,"result":{"dispatchId":"ctx_9","state":"ready"}}'
    }
    if (command.includes('__WFC__')) {
      // One batched command: terminal list + repo list between markers.
      return [
        '__WFC__',
        JSON.stringify({
          ok: true,
          result: {
            terminals: [
              { handle: 't1', title: 'workflow-view bridge', worktreeId: 'r1::/Users/tester/PhpstormProjects/biz.erp' },
              { handle: 't2', title: 'Terminal', worktreeId: 'f1::/Users/tester' }
            ]
          }
        }),
        '__WFR__',
        JSON.stringify({
          ok: true,
          result: {
            repos: [
              { id: 'r1', displayName: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp', kind: 'git' },
              { id: 'f1', displayName: '~', path: '/Users/tester', kind: 'folder' }
            ]
          }
        }),
        '__WFE__'
      ].join('\n')
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
    if (command.includes('echo $HOME')) {
      return '/Users/tester'
    }
    if (command.includes('__WF_LS__') && command.includes('base64')) {
      // The whole-directory listing: marker + base64 + end marker per yaml file.
      const files: Record<string, string> = command.includes('/specialists') || command.includes('/workers')
        ? {
            planner: 'agent: claude\nspec: PLAN SPEC {{objective}}\n',
            researcher: 'agent: claude\nspec: RESEARCH SPEC\n',
            reviewer: 'agent: claude\nspec: REVIEW SPEC\n',
            coder: 'agent: claude\nspec: CODE SPEC\n',
            tester: 'agent: claude\nmodel: cheap-model\nfallback: [zcode, kimi]\nspec: TEST SPEC\n',
            committer: 'agent: claude\nspec: COMMIT SPEC\n'
          }
        : { demo: TEMPLATE_YAML }
      const chunks: string[] = []
      for (const [name, content] of Object.entries(files)) {
        chunks.push(`__WF_LS__${name}.yaml`)
        chunks.push(b64(content).replace(/(.{76})/g, '$1\n'))
        chunks.push('__WF_LE__')
      }
      return chunks.join('\n')
    }
    if (command.includes('__FILE__')) {
      // Spec files still read per cat: answer with a marker per `base64 < '<dir>/<rel>'`.
      const chunks: string[] = []
      for (const match of command.matchAll(/base64 < '([^']+)'/g)) {
        const rel = match[1].slice(dir.length + 1)
        chunks.push(`__FILE__${rel}`)
        const content = rel === 'specs/plan.md' ? 'PLAN SPEC {{objective}}' : 'DEV SPEC {{objective}}'
        chunks.push(b64(content).replace(/(.{76})/g, '$1\n'))
      }
      return chunks.join('\n')
    }
    return ''
  }
  currentCanned = canned
  return mockHost({
    storage: opts.storage ?? {},
    results: {
      'workspace.readContext': {
        branch: 'master',
        displayName: 'biz.erp',
        terminals: [opts.focus ? { id: opts.focus, title: 'Terminal' } : { id: 't1', title: 'workflow-view bridge' }]
      },
      'workspace.list': {
        workspaces: [
          { id: 'w1', kind: 'worktree', name: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp', branch: 'master', project: 'repo:1', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'other', path: '/x/other', branch: 'feature/x', project: 'repo:2', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'momento', path: '/Users/tester/orca/workspaces/biz.erp/momento', branch: 'feat/momento', project: 'repo:1', hostId: 'local' }
        ],
        truncated: false
      },
      'editor.open': { opened: true },
      'agent.launch': { terminalId: 't-coord' },
      // Фоновый терминал-помощник для --from создаётся host-вызовом (невидимым).
      'terminal.create': { terminalId: 't_helper' },
      'statusBar.update': { ok: true }
    }
  })
}

/** Every test deactivates its worker even when an assertion fails: the interval would keep
 *  the node:test child process alive forever otherwise. The spawn seam is swapped for the
 *  canned CLI answers and cleared after the helper-terminal close settles. */
let spawnedCommands: string[] = []
let currentCanned: ((command: string) => string) | null = null
const spawned = (): string[] => spawnedCommands

async function withWorker(
  fn: (worker: Awaited<ReturnType<typeof mountWorker>>, host: MockHost) => Promise<void>,
  opts: { focus?: string; storage?: Record<string, unknown> } = {}
): Promise<void> {
  const host = makeHost(opts)
  const canned = currentCanned as (command: string) => string
  spawnedCommands = []
  spawnHooks.exec = async (command) => {
    spawnedCommands.push(command)
    return canned(command)
  }
  const worker = await mountWorker(main, { host })
  try {
    await fn(worker, host)
  } finally {
    await worker.deactivate()
    await new Promise((resolve) => setTimeout(resolve, 60))
    spawnHooks.exec = null
  }
}

test('runs.list и state.get читают оркестрацию через мост', () =>
  withWorker(async (worker) => {
    const runs = await worker.request('runs.list')
    assert.deepEqual(runs.runs, [{ runId: 'run_1', objective: 'Демо — цель', projectPath: null }])
    assert.equal(runs.error, null)

    const state = await worker.request('state.get', { runId: 'run_1' })
    assert.equal(state.error, null)
    assert.equal(state.tasks.length, 2)
    assert.equal(state.tasks[0].id, 'task_a', 'plan идёт раньше dev независимо от порядка task-list')
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
    assert.equal(template.steps.length, 4)
    assert.ok(template.steps.some((s) => s.sub && s.sub.length > 0), 'блок подшагов читается')
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
    assert.ok(job, 'job записан')
    assert.equal(job!.status, 'done', job!.error ?? '')
    // The failover chain from the specialist lands in the run config.
    const auto = (host.data().storage['auto.run_2'] ?? {}) as {
      tasks?: Record<string, { fallback?: string[]; agent?: string; stepId?: string }>
    }
    const testerTasks = Object.values(auto.tasks ?? {}).filter((cfg) => cfg.stepId?.startsWith('test-'))
    assert.equal(testerTasks.length, 2, 'test-api и test-ui в конфиге')
    for (const cfg of testerTasks) assert.deepEqual(cfg.fallback, ['zcode', 'kimi'], `fallback ${cfg.stepId}`)
    assert.equal(job.runId, 'run_2')
    const commands = spawned()
    // plan, research(optional), review, test-api, test-ui, commit — все материализуются.
    assert.equal(commands.filter((c) => c.includes('task-create') && c.includes('--from')).length, 6, 'все юниты (после retry с --from)')
    assert.ok(commands.some((c) => c.includes('gate-create') && c.includes('--from')), 'гейт commit создан')
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
    // Мост одноразовый: сброс просто чистит кэш воркспейсов, лишнего состояния нет.
    await worker.request('bridge.reset')
    const info = await worker.request('bridge.info')
    assert.equal(info.terminalId, null)
  }))

test('templates.updated разбирает YAML редактора без моста', () =>
  withWorker(async (worker) => {
    const answer = await worker.request('templates.updated', {
      projectPath: '/x/biz.erp',
      yaml: 'id: feature-dev\ntitle: Фича\nsteps:\n  - { id: plan, worker: planner }\n  - { id: dev, worker: coder, fallback: [zcode] }\n'
    })
    assert.equal(answer.template.id, 'feature-dev')
    assert.equal(answer.template.error, null)
    assert.equal(answer.template.steps.length, 2)
    assert.deepEqual(answer.template.steps[1].fallback, ['zcode'])
    const broken = await worker.request('templates.updated', { projectPath: '/x/biz.erp', yaml: 'steps: []\n' })
    assert.ok(broken.template.error, 'ошибка парсинга честно видна')
  }))

test('новый ран поднимает координатора-агента, автопилот не вмешивается', () =>
  withWorker(async (worker, host) => {
    const { jobId } = await worker.request('template.instantiate', {
      source: 'library', projectPath: null, templateId: 'demo',
      objective: 'цель Y', baseBranch: null, worktreeName: 'demo-wt', agent: 'claude'
    })
    let job = null
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50))
      job = (await worker.request('job.get', { jobId })).job
      if (job && job.status !== 'running') break
    }
    assert.ok(job, 'job записан')
    assert.equal(job!.status, 'done', job!.error ?? '')
    const launches = host.callsOf('agent.launch') as Array<{ workspaceId: string; agent: string; prompt: string }>
    assert.equal(launches.length, 1, 'сессия координатора запущена')
    assert.ok(launches[0].prompt.includes('run-use'), 'бриф велит привязаться к рану')
    assert.ok(launches[0].prompt.includes('Флоу'), 'в брифе есть флоу')
    const auto = (host.data().storage['auto.run_2'] ?? {}) as { driver?: string; coordinatorTerminal?: string }
    assert.equal(auto.driver, 'coordinator')
    assert.ok(auto.coordinatorTerminal, 'терминал координатора записан')
  }))

test('task.retry сбрасывает шаг и его хвост, автопилот просыпается', () =>
  withWorker(async (worker, host) => {
    const answer = await worker.request('task.retry', { runId: 'run_1', taskId: 'task_a' })
    assert.equal(answer.ok, true)
    assert.deepEqual([...answer.reset].sort(), ['task_a', 'task_b'], 'шаг и зависимый хвост')
    const updates = spawned().filter((c) => c.includes('task-update') && c.includes('--from'))
    assert.equal(updates.length, 2, 'по одному сбросу на задачу')
    assert.ok(updates.every((c) => c.includes('--status pending')), 'статус pending')
  }))

test('run.meta.set привязывает ран к проекту, runs.list её отдаёт', () =>
  withWorker(async (worker) => {
    await worker.request('run.meta.set', { runId: 'run_1', projectPath: '/x/biz.erp' })
    const runs = await worker.request('runs.list')
    assert.equal(runs.runs[0].projectPath, '/x/biz.erp')
  }))

test('мост гоняет CLI спавном: чтения без терминалов, мутации сами достают --from', () =>
  withWorker(async (worker) => {
    const runs = await worker.request('runs.list')
    assert.equal(runs.runs.length, 1)
    assert.ok(spawned().every((c) => !c.includes('orca terminal create')), 'чтения не создают терминалов')

    await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'approve' })
    const resolves = spawned().filter((c) => c.includes('gate-resolve'))
    assert.ok(resolves.length >= 2, 'была повторная попытка после no_active_sender_terminal')
    assert.ok(resolves[resolves.length - 1].includes('--from t_helper'), 'мутация повторена с --from терминала-помощника')
  }))


test('projects.list отдаёт git-репозитории с путями', () =>
  withWorker(async (worker) => {
    const answer = await worker.request('projects.list')
    assert.deepEqual(answer.projects, [
      { repoId: 'r1', name: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp' }
    ])
    const current = await worker.request('project.current')
    assert.deepEqual(current.project, { repoId: 'r1', name: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp' })
    assert.equal(current.isWorkflow, true, 'есть .orca/workflows — проект воркфлоу')
  }))

test('project.current вне проекта держит скоуп на проекте последнего рана', () =>
  withWorker(async (worker) => {
    const current = await worker.request('project.current')
    assert.equal(current.project.path, '/Users/tester/PhpstormProjects/biz.erp', 'фокус в ~, скоуп на biz.erp')
    assert.equal(current.project.name, 'biz.erp')
    assert.equal(current.isWorkflow, true)
  }, {
    focus: 't2',
    storage: { 'runmeta.run_1': { projectPath: '/Users/tester/PhpstormProjects/biz.erp' } }
  }))

test('template.edit открывает файл шаблона в Orca', () =>
  withWorker(async (worker, host) => {
    await worker.request('template.edit', { projectPath: '/Users/tester/PhpstormProjects/biz.erp', templateId: 'demo' })
    const opens = host.callsOf('editor.open') as Array<{ workspaceId: string; path: string }>
    assert.equal(opens.length, 1)
    assert.equal(opens[0].workspaceId, 'w1')
    assert.equal(opens[0].path, '.orca/workflows/demo.yaml')
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
    const commands = spawned()
    const resolve = commands.find((c) => c.includes('gate-resolve'))
    assert.ok(resolve?.includes("'approve'"), 'резолюция передана')
    const start = commands.find((c) => c.includes('worker-start'))
    assert.ok(start?.includes('--model') && start.includes("'some-model'"), 'модель передана')
    assert.ok(start?.includes('--effort') && start.includes("'high'"), 'effort передан')
    assert.ok(start?.includes("'name:ycl-104-momento'"), 'ворктри передан')
  }))
