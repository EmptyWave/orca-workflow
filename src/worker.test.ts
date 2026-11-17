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
  - { id: review, worker: reviewer, on_reject: { goto: plan, max_rounds: 2 }, gate: { question: 'Пускать dev?', options: [approve, request-changes] } }
  - id: tests
    sub:
      - { id: test-api, worker: tester }
      - { id: test-ui, worker: tester }
  - id: commit
    worker: committer
    deps: [tests]
`

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function makeHost(opts: { focus?: string; storage?: Record<string, unknown>; workerRead?: string; inbox?: string; workerList?: string; dispatchTimes?: string } = {}) {
  let created = 0
  const LS_DIR = '/Users/tester/orca-plugins/workflow-view/workflows'
  const canned = (command: string): string => {
    const dir = LS_DIR
    // Терминал-помощник для --from создаётся CLI-командой — тоже спавном.
    if (command.includes('orca agent launch')) {
      return '{"ok":true,"result":{"terminal":{"handle":"t_coord_session"}}}'
    }
    if (command.includes('worker-read')) {
      return opts.workerRead ?? JSON.stringify({ ok: true, result: { dispatchId: 'ctx_x', transcript: { messages: [
        { role: 'assistant', blocks: [{ type: 'text', text: 'Ревью завершено.\nVERDICT: request-changes' }] }
      ] } } })
    }
    if (command.includes('orchestration inbox')) {
      return opts.inbox ?? '{"ok":true,"result":{"messages":[]}}'
    }
    if (command.includes('agent-model-catalog')) {
      return '{"agent":"claude","discovered":{"models":[{"id":"glm-5.3","label":"Glm 5.3"},{"id":"glm-5.3[1m]","label":"Glm 5.3 (1M context)"}]}}\n{"agent":"codex","discovered":{"models":[{"id":"gpt-5","label":"GPT-5"}]}}'
    }
    if (command.includes('orca terminal create') && command.includes('workflow-view-runner')) {
      return '{"ok":true,"result":{"terminal":{"handle":"t_helper"}}}'
    }
    // Мутации оркестрации требуют идентичность отправителя, как настоящий CLI.
    // agent launch несёт бриф с командами флоу (« run-use ») — это не мутация, не гоняем через retry
    const mutation = !command.includes('orca agent launch') && / (run-create|task-create|gate-create|gate-resolve|task-update|worker-start|run-use|send) /.test(command)
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
      return opts.workerList ?? '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_1","taskId":"task_a","state":"succeeded","agent":"claude"}]}}'
    }
    if (command.includes('dispatch_contexts')) {
      return opts.dispatchTimes ?? ''
    }
    if (command.includes('FROM runs;')) {
      // listRuns тянет created_at ранов одним запросом — новейший ран ворктри побеждает
      return 'run_1|2026-11-17 10:00:00\nrun_2|2026-11-17 11:00:00'
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
  opts: { focus?: string; storage?: Record<string, unknown>; workerRead?: string; inbox?: string; workerList?: string; dispatchTimes?: string } = {}
): Promise<void> {
  const host = makeHost(opts)
  const canned = currentCanned as (command: string) => string
  spawnedCommands = []
  spawnHooks.exec = async (command) => {
    spawnedCommands.push(command)
    return canned(command)
  }
  main.coordLaunch.bootWaitMs = 5
  const worker = await mountWorker(main, { host })
  try {
    await fn(worker, host)
  } finally {
    await worker.deactivate()
    await new Promise((resolve) => setTimeout(resolve, 60))
    spawnHooks.exec = null
  }
}

test('вердикт без строки VERDICT берётся из сабджекта done-сообщения', () =>
  withWorker(async (worker, host) => {
    const r = await worker.request('task.report', { dispatchId: 'ctx_x', runId: 'run_2', taskId: 'task_1' })
    assert.ok(String(r.report).includes('пробела'), 'отчёт читается')
    assert.equal(host.data().storage['verdict3.ctx_x'], 'request-changes', 'бейдж попытки видит реджект, а не дефолтный approve')
  }, {
    workerRead: JSON.stringify({ ok: true, result: { transcript: { messages: [
      { role: 'assistant', blocks: [{ type: 'text', text: 'Два критичных пробела в плане.' }] }
    ] } } }),
    inbox: JSON.stringify({ ok: true, result: { messages: [
      { type: 'worker_done', subject: 'Plan-review: request-changes (2 пробела)', payload: { taskId: 'task_1' } }
    ] } })
  }))

test('вердикт не определяется без строки и сабджекта — сентинел none, чтение по dispatchId не пишет ничего', () =>
  withWorker(async (worker, host) => {
    await worker.request('task.report', { dispatchId: 'ctx_x' })
    assert.equal(host.data().storage['verdict3.ctx_x'], undefined, 'чтение без taskId не затирает хранилище дефолтом')
    await worker.request('task.report', { dispatchId: 'ctx_x', runId: 'run_2', taskId: 'task_1' })
    assert.equal(host.data().storage['verdict3.ctx_x'], 'none', 'неуверенный вердикт — сентинел, не approve')
  }, {
    workerRead: JSON.stringify({ ok: true, result: { transcript: { messages: [
      { role: 'assistant', blocks: [{ type: 'text', text: 'Отчёт без вердикта вообще.' }] }
    ] } } })
  }))

test('эхо инструкции не перебивает финальный вердикт: берётся последнее вхождение', () =>
  withWorker(async (worker, host) => {
    await worker.request('task.report', { dispatchId: 'ctx_x', runId: 'run_2', taskId: 'task_1' })
    assert.equal(host.data().storage['verdict3.ctx_x'], 'request-changes', 'последняя строка отчёта — истина')
  }, {
    workerRead: JSON.stringify({ ok: true, result: { transcript: { messages: [
      { role: 'assistant', blocks: [{ type: 'text', text: 'Формат: последняя строка одна из\nVERDICT: approve\nVERDICT: request-changes\n\nИтог ревью.\nVERDICT: request-changes' }] }
    ] } } })
  }))

test('попытки шага идут в порядке создания, а не как worker-list их отдал', () =>
  withWorker(async (worker) => {
    const state = await worker.request('state.get', { runId: 'run_2' })
    assert.deepEqual(
      state.workers.map((w) => w.dispatchId),
      ['ctx_old', 'ctx_new'],
      'первая попытка — старая, реран — второй, хоть CLI отдал свежую первой'
    )
  }, {
    // CLI отдаёт свежий диспетчер первым — как живой worker-list
    workerList: '{"ok":true,"result":{"workers":[{"dispatchId":"ctx_new","taskId":"task_a","state":"succeeded","agent":"claude"},{"dispatchId":"ctx_old","taskId":"task_a","state":"succeeded","agent":"claude"}]}}',
    dispatchTimes: 'ctx_old|2026-11-17 11:13:38\nctx_new|2026-11-17 11:45:45'
  }))

test('runs.list и state.get читают оркестрацию через мост', () =>
  withWorker(async (worker) => {
    const runs = await worker.request('runs.list')
    assert.deepEqual(runs.runs, [{ runId: 'run_1', objective: 'Демо — цель', projectPath: null, worktreePath: null, createdAt: '2026-11-17 10:00:00' }])
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
    const launches = spawned().filter((c) => c.includes('orca agent launch'))
    assert.equal(launches.length, 1, 'сессия координатора запущена через CLI agent launch')
    assert.ok(launches[0].includes('run-use'), 'бриф велит привязаться к рану')
    assert.ok(launches[0].includes('%D0%A4%D0%BB%D0%BE%D1%83') || launches[0].includes('Флоу'), 'в брифе есть флоу')
    const auto = (host.data().storage['auto.run_2'] ?? {}) as { driver?: string; coordinatorTerminal?: string }
    assert.equal(auto.driver, 'coordinator')
    assert.ok(auto.coordinatorTerminal, 'терминал координатора записан')
  }))

test('task.retry сбрасывает шаг и его хвост, автопилот просыпается', () =>
  withWorker(async (worker, host) => {
    const answer = await worker.request('task.retry', { runId: 'run_1', taskId: 'task_a' })
    assert.equal(answer.ok, true)
    assert.deepEqual([...answer.reset].sort(), ['task_a', 'task_b'], 'шаг и зависимый хвост')
    const commands = spawned()
    const updates = commands.filter((c) => c.includes('task-update') && c.includes('--from'))
    assert.equal(updates.length, 2, 'по одному сбросу на задачу')
    assert.ok(updates.every((c) => c.includes('--status pending')), 'статус pending')
    const runUseAt = commands.findIndex((c) => c.includes('run-use'))
    const firstUpdateAt = commands.findIndex((c) => c.includes('task-update'))
    assert.ok(runUseAt >= 0 && runUseAt < firstUpdateAt, 'хелпер привязывается к рану до мутаций (иначе run_required)')
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
