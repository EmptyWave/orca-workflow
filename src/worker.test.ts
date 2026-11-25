// Runs src/worker.ts over a mock host whose terminal answers the CLI bridge with canned
// JSON per command, the way the real bridge captures between markers.
import { assert, mockHost, mountWorker, test, type MockHost } from 'orca/testing'
import * as main from './worker'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const WS_ROOT = '/Users/tester/orca/workspaces/demo'

// Воркспейсы тестового хоста; сцена может подменить список (opts.workspaces).
const DEFAULT_WORKSPACES = [
          { id: 'w1', kind: 'worktree', name: 'biz.erp', path: '/Users/tester/PhpstormProjects/biz.erp', branch: 'master', project: 'repo:1', hostId: 'local' },
          { id: 'w2', kind: 'worktree', name: 'other', path: '/x/other', branch: 'feature/x', project: 'repo:2', hostId: 'local' },
          { id: 'w3', kind: 'worktree', name: 'momento', path: '/Users/tester/orca/workspaces/biz.erp/momento', branch: 'feat/momento', project: 'repo:1', hostId: 'local' }
]

// Карточки воркеров тестового хоста; сцена добавляет/заменяет свои (opts.workers) или убирает (opts.dropWorkers).
const CARDS: Record<string, string> = {
  planner: 'agent: claude\nspec: PLAN SPEC {{objective}}\n',
  researcher: 'agent: claude\nspec: RESEARCH SPEC\n',
  reviewer: 'agent: claude\nspec: REVIEW SPEC\n',
  coder: 'agent: claude\nspec: CODE SPEC\n',
  tester: 'agent: claude\nmodel: cheap-model\nfallback: [zcode, kimi]\nspec: TEST SPEC\n',
  committer: 'agent: claude\nspec: COMMIT SPEC\n'
}

function makeHost(opts: { focus?: string; storage?: Record<string, unknown>; workerRead?: string; inbox?: string; workerList?: string; dispatchTimes?: string; tasks?: string; gates?: string; ready?: string; workspaces?: unknown[]; repoPath?: string; workers?: Record<string, string>; dropWorkers?: string[]; runId?: string | (() => string) } = {}) {
  let created = 0
  const createdWorktrees: string[] = [] // что «создала» команда worktree create в этой сцене
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
      // Как настоящий CLI: селектор `path:` сравнивает адрес СТРОКОЙ, симлинки не разрешает —
      // иначе тест не заметил бы selector_not_found, на котором вживую падал каждый подъём рана.
      const selector = (command.match(/--worktree path:(\S+)/) || [])[1]
      const known = (opts.workspaces ?? DEFAULT_WORKSPACES).map((w) => (w as { path: string }).path)
      if (selector && !known.includes(selector)) {
        throw new Error('selector_not_found: No Orca workspace matched the worktree selector')
      }
      return '{"ok":true,"result":{"terminal":{"handle":"t_helper"}}}'
    }
    // Мутации оркестрации требуют идентичность отправителя, как настоящий CLI — причём КАЖДАЯ
    // мутация в составной команде (`a && b`): мост при отказе дописывает --from только в конец
    // строки, и вторая команда без явного отправителя вживую падает.
    // agent launch несёт бриф с командами флоу (« run-use ») — это не мутация, не гоняем через retry
    const mutationRe = / (run-create|task-create|gate-create|gate-resolve|task-update|worker-start|run-use|send) /
    const withoutSender = command.includes('orca agent launch')
      ? []
      : command.split(' && ').filter((part) => mutationRe.test(part) && !part.includes('--from'))
    if (withoutSender.length > 0) {
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
      // Дефолтный --ready содержит task_b — сцена skip задаёт свой, иначе hold-задача станет «готовой»
      return opts.ready ?? '{"ok":true,"result":{"tasks":[{"id":"task_b","taskTitle":"dev Разработка"}]}}'
    }
    if (command.includes('task-list') && !command.includes('--ready')) {
      if (opts.tasks) return opts.tasks
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
      if (opts.gates) return opts.gates
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
      const id = typeof opts.runId === 'function' ? opts.runId() : opts.runId
      return JSON.stringify({ ok: true, result: { runId: id ?? 'run_2' } })
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
              { id: 'r1', displayName: 'biz.erp', path: opts.repoPath ?? '/Users/tester/PhpstormProjects/biz.erp', kind: 'git' },
              { id: 'f1', displayName: '~', path: '/Users/tester', kind: 'folder' }
            ]
          }
        }),
        '__WFE__'
      ].join('\n')
    }
    if (command.includes('orca worktree create')) {
      // Как настоящая Орка: репозиторий в её реестре сравнивается с селектором СТРОКОЙ —
      // симлинки не разрешаются, `--repo path:<другая запись того же каталога>` → repo_not_found.
      const unquote = (v: string | undefined): string => (v ?? '').replace(/^['"]|['"]$/g, '')
      const repo = unquote((command.match(/--repo (\S+)/) || [])[1])
      const registry = opts.repoPath ?? '/Users/tester/PhpstormProjects/biz.erp'
      const known: Record<string, boolean> = { 'id:r1': true, [`path:${registry}`]: true, 'path:.': true }
      if (!known[repo]) {
        return JSON.stringify({ ok: false, error: { code: 'repo_not_found', message: 'repo_not_found', data: null } })
      }
      const name = unquote((command.match(/--name (\S+)/) || [])[1])
      createdWorktrees.push(name)
      return JSON.stringify({ ok: true, result: { id: `wt:${name}`, displayName: name, path: `${WS_ROOT}/${name}` } })
    }
    if (command.includes('orca worktree list')) {
      const base = (opts.workspaces ?? DEFAULT_WORKSPACES) as Array<{ name: string; path: string; branch?: string | null }>
      const worktrees = [
        ...base.map((w) => ({ displayName: w.name, path: w.path, branch: w.branch ?? null })),
        ...createdWorktrees.map((n) => ({ displayName: n, path: `${WS_ROOT}/${n}`, branch: null }))
      ]
      return JSON.stringify({ ok: true, result: { worktrees } })
    }
    if (command.includes('repo list')) {
      return JSON.stringify({
        ok: true,
        result: {
          repos: [
            { id: 'r1', displayName: 'biz.erp', path: opts.repoPath ?? '/Users/tester/PhpstormProjects/biz.erp', kind: 'git' },
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
        ? Object.fromEntries(Object.entries({ ...CARDS, ...(opts.workers ?? {}) }).filter(([slug]) => !(opts.dropWorkers ?? []).includes(slug)))
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
        workspaces: opts.workspaces ?? DEFAULT_WORKSPACES,
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
  opts: { focus?: string; storage?: Record<string, unknown>; workerRead?: string; inbox?: string; workerList?: string; dispatchTimes?: string; workspaces?: unknown[]; repoPath?: string; workers?: Record<string, string>; dropWorkers?: string[]; runId?: string | (() => string) } = {}
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
    assert.deepEqual(runs.runs, [{ runId: 'run_1', objective: 'Демо — цель', projectPath: null, worktreePath: null, createdAt: '2026-11-17 10:00:00', updatedAt: null, hasCoordinator: false, liveWorkers: 0 }])
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

/** Поднимает демо-ран из библиотеки на заданных карточках (поверх базовых), ждёт окончания job. */
function raiseDemo(
  fn: (r: { job: any; worker: Awaited<ReturnType<typeof mountWorker>>; host: MockHost }) => Promise<void>,
  scene: { workers?: Record<string, string>; dropWorkers?: string[]; worktreeName?: string } = {}
): Promise<void> {
  return withWorker(async (worker, host) => {
    const { jobId } = await worker.request('template.instantiate', {
      source: 'library', projectPath: null, templateId: 'demo',
      objective: 'цель Y', baseBranch: null, worktreeName: scene.worktreeName ?? 'demo-wt', agent: 'claude'
    })
    let job = null
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 50))
      job = (await worker.request('job.get', { jobId })).job
      if (job && job.status !== 'running') break
    }
    await fn({ job, worker, host })
  }, scene)
}

/** Текст брифа из команды его записи в ворктри (`echo <base64> | base64 -d > …/coordinator-brief.<runId>.md`). */
function briefOf(command: string): string {
  const match = command.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)
  return match ? new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0))) : ''
}

const GENERAL_COORDINATOR = 'agent: claude\nmodel: opus\neffort: xhigh\nprompt: |\n  GENERAL-CARD-RULE\n'

/** Команды записи брифа рана. Фильтр — по форме команды, а не по одному имени файла: путь к брифу
 *  назван и в самом брифе, поэтому команда запуска координатора тоже содержит это имя. */
const briefWrites = (runId: string): string[] =>
  spawned().filter((c) => c.includes('base64 -d >') && c.includes(`coordinator-brief.${runId}.md`))

test('координатор по шаблону: карточка coordinator-<id> заменяет общую — агент, модель и текст уходят в запуск', () =>
  raiseDemo(async ({ job, worker }) => {
    assert.equal(job.status, 'done', job.error ?? '')
    const launch = spawned().find((c) => c.includes('orca agent launch')) ?? ''
    assert.ok(launch.includes("--agent 'codex'"), 'агент — из карточки флоу')
    assert.ok(launch.includes("--model 'gpt-5' --effort 'high'"), 'модель и effort — из карточки флоу')
    assert.ok(launch.includes('FLOW-SPECIFIC-RULE-77'), 'текст карточки флоу — в брифе')
    assert.ok(launch.includes('РОЛЬ И СПЕЦИФИКА ЭТОГО ФЛОУ'), 'бриф объявляет блок обязательным')
    assert.ok(!launch.includes('GENERAL-CARD-RULE'), 'текст общей карточки в бриф не попадает')
    assert.ok(!launch.includes("--model 'opus'"), 'общая карточка не доклеивается по частям')
    const written = briefWrites('run_2')
    assert.ok(written.some((c) => briefOf(c).includes('FLOW-SPECIFIC-RULE-77')), 'файл брифа несёт специфику флоу')
    // Пересборка брифа («осведомить координатора») читает ту же карточку и пишет файл ЭТОГО рана.
    const refreshedAnswer = await worker.request('run.brief.refresh', { runId: 'run_2' })
    assert.equal(refreshedAnswer.briefRel, '.orca/coordinator-brief.run_2.md', 'панель получает путь, чтобы назвать его координатору')
    assert.ok(!briefWrites('run_2').at(-1)?.includes(' && cp '), 'новому рану достаточно своего файла — чужие не трогает')
    const refreshed = briefOf(briefWrites('run_2').at(-1) ?? '')
    assert.ok(refreshed.includes('FLOW-SPECIFIC-RULE-77'), 'пересборка брифа вкладывает карточку флоу')
    assert.ok(!refreshed.includes('GENERAL-CARD-RULE'), 'пересборка не тянет общую карточку')
  }, {
    workers: {
      coordinator: GENERAL_COORDINATOR,
      'coordinator-demo': 'agent: codex\nmodel: gpt-5\neffort: high\nprompt: |\n  FLOW-SPECIFIC-RULE-77\n'
    }
  }))

test('координатор по шаблону: карточка чужого флоу не мешает, без своей берётся общая', () =>
  raiseDemo(async ({ job }) => {
    assert.equal(job.status, 'done', job.error ?? '')
    const launch = spawned().find((c) => c.includes('orca agent launch')) ?? ''
    assert.ok(launch.includes("--agent 'codex'") && launch.includes("--model 'opus' --effort 'xhigh'"), 'агент, модель и effort — из общей карточки')
    assert.ok(!launch.includes('FLOW-SPECIFIC-RULE-77'), 'карточка другого флоу в бриф не попадает')
    assert.ok(!launch.includes('GENERAL-CARD-RULE'), 'текст общей карточки не вкладывается: её правила уже в брифе')
    assert.ok(!launch.includes('РОЛЬ И СПЕЦИФИКА ЭТОГО ФЛОУ'), 'пустого блока роли нет')
  }, {
    workers: {
      coordinator: GENERAL_COORDINATOR.replace('agent: claude', 'agent: codex'),
      'coordinator-research': 'agent: codex\nprompt: |\n  FLOW-SPECIFIC-RULE-77\n'
    }
  }))

test('координатор по шаблону: карточка coordinator-<id> без текста — только агент и модель, это не ошибка', () =>
  raiseDemo(async ({ job }) => {
    assert.equal(job.status, 'done', job.error ?? '')
    const launch = spawned().find((c) => c.includes('orca agent launch')) ?? ''
    assert.ok(launch.includes("--agent 'codex'") && !launch.includes('--model'), 'карточка флоу задана без модели — агент на своей')
    assert.ok(!launch.includes('РОЛЬ И СПЕЦИФИКА ЭТОГО ФЛОУ'), 'блока роли нет')
  }, {
    workers: { coordinator: GENERAL_COORDINATOR, 'coordinator-demo': 'agent: codex\n' }
  }))

test('битая карточка coordinator-<id>: ран не создаётся, ошибка называет карточку', () =>
  raiseDemo(async ({ job }) => {
    assert.equal(job.status, 'failed')
    assert.ok(String(job.error).includes('карточка координатора «coordinator-demo» не читается'), job.error)
    assert.equal(spawned().filter((c) => c.includes('run-create')).length, 0, 'конфигурация проверена до run-create — пустого рана не остаётся')
    assert.equal(spawned().filter((c) => c.includes('orca agent launch')).length, 0, 'координатор не запускается')
  }, {
    workers: { 'coordinator-demo': 'agent: claude\nprompt: "незакрытая кавычка\n' }
  }))

test('нет карточки воркера: конфигурация проверена до run-create — пустого рана не остаётся', () =>
  raiseDemo(async ({ job }) => {
    assert.equal(job.status, 'failed')
    assert.ok(String(job.error).includes('нет карточек воркеров: planner'), job.error)
    assert.equal(spawned().filter((c) => c.includes('run-create')).length, 0, 'ран не создан')
  }, { dropWorkers: ['planner'] }))

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

// ---- skip в гейте -----------------------------------------------------------------------------
// Сцена: plan ✓ → [гейт держит dev] dev (+подшаг dev-sub) → tests → commit.
const SKIP_SCENE = (heldStatus: string): string => JSON.stringify({ ok: true, result: { tasks: [
  { id: 'task_d', title: 'commit Коммит', status: 'pending', deps: '["task_c"]' },
  { id: 'task_c', title: 'tests Тесты', status: 'pending', deps: '["task_b"]' },
  { id: 'task_b2', title: 'dev-sub Подшаг', status: 'blocked', deps: '["task_b"]' },
  { id: 'task_b', title: 'dev Разработка', status: heldStatus, deps: '["task_a"]' },
  { id: 'task_a', title: 'plan План', status: 'completed', deps: '[]' }
] } })
const SKIP_GATES = JSON.stringify({ ok: true, result: { gates: [
  { id: 'gate_1', task_id: 'task_b', status: 'pending', question: 'Пускать dev?', options: '["approve","request-changes","skip"]' }
] } })
const SKIP_AUTO = (goto: string | null): Record<string, unknown> => ({
  'auto.run_1': {
    worktreeName: 'wt', repoPath: null, driver: 'coordinator',
    tasks: {
      task_a: { stepId: 'plan', order: 0 }, task_b: { stepId: 'dev', order: 1 }, task_b2: { stepId: 'dev', order: 2 },
      task_c: { stepId: 'tests', order: 3 }, task_d: { stepId: 'commit', order: 4 }
    },
    children: { task_b2: 'task_b' },
    gates: { task_b: { goto } }
  }
})
const skipOpts = (goto: string | null, heldStatus = 'blocked') => ({
  tasks: SKIP_SCENE(heldStatus), gates: SKIP_GATES, storage: SKIP_AUTO(goto), ready: '{"ok":true,"result":{"tasks":[]}}'
})
const updatedIds = (command: string): string[] => [...command.matchAll(/--id '(task_\w+)'/g)].map((m) => m[1])

test('skip с on_skip: закрывает всё до цели, держимую — одной командой с решением гейта', () =>
  withWorker(async (worker, host) => {
    const r = await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'skip', runId: 'run_1' })
    assert.equal(r.resumeAt, 'commit', 'флоу продолжится с on_skip.goto')
    assert.deepEqual(r.skipped, ['task_c', 'task_b2', 'task_b'], 'хвост дальний → ближний, держимая последней')
    const cmds = spawned()
    const solo = cmds.filter((c) => c.includes('task-update') && !c.includes('gate-resolve'))
    assert.deepEqual(solo.flatMap(updatedIds).sort(), ['task_b2', 'task_c'], 'до решения гейта закрыты только задачи между')
    for (const c of solo) assert.ok(c.includes('--status completed') && c.includes('ПРОПУЩЕН'), 'закрыты с пометкой ПРОПУЩЕН')
    const combo = cmds.find((c) => c.includes('gate-resolve'))
    assert.ok(combo, 'держимая закрыта в одной команде с gate-resolve')
    const parts = combo.split(' && ')
    assert.equal(parts.length, 2, 'ровно две команды')
    assert.ok(parts[0].includes("'gate_1'") && /--resolution skip( |$)/.test(parts[0]), 'первая — решение гейта skip')
    assert.ok(parts[1].includes("--id 'task_b'") && parts[1].includes('--status completed'), 'вторая — закрыть держимую')
    for (const part of parts) assert.ok(part.includes('--from'), 'отправитель у КАЖДОЙ команды связки')
    const lastSolo = Math.max(...cmds.map((c, i) => (c.includes('task-update') && !c.includes('gate-resolve') ? i : -1)))
    assert.ok(lastSolo < cmds.indexOf(combo), 'сначала хвост, потом решение гейта — иначе resolve вернул бы задачи в ready')
    const touched = cmds.filter((c) => c.includes('task-update')).flatMap(updatedIds)
    assert.ok(!touched.includes('task_a') && !touched.includes('task_d'), 'выполненный и целевой шаги не тронуты')
    assert.deepEqual(Object.keys(host.data().storage['skipped.run_1'] as object).sort(), ['task_b', 'task_b2', 'task_c'], 'пропуск запомнен')
    assert.ok(cmds.some((c) => c.includes('orchestration send') && c.includes('skip')), 'координатор извещён через ящик')
  }, skipOpts('commit')))

test('skip без on_skip: закрывает только держимый шаг с его подшагами', () =>
  withWorker(async (worker, host) => {
    const r = await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'skip', runId: 'run_1' })
    assert.equal(r.resumeAt, null)
    assert.deepEqual(r.skipped, ['task_b2', 'task_b'])
    const touched = spawned().filter((c) => c.includes('task-update')).flatMap(updatedIds)
    assert.deepEqual(touched.sort(), ['task_b', 'task_b2'], 'последующие шаги не тронуты')
    assert.deepEqual(Object.keys(host.data().storage['skipped.run_1'] as object).sort(), ['task_b', 'task_b2'])
  }, skipOpts(null)))

test('skip: шаг уже выполняется — отказ до любых мутаций', () =>
  withWorker(async (worker, host) => {
    await assert.rejects(
      () => worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'skip', runId: 'run_1' }),
      /уже выполняется/,
      'работающий шаг не пропускается'
    )
    const mutations = spawned().filter((c) => / (gate-resolve|task-update) /.test(c))
    assert.equal(mutations.length, 0, 'ни гейт не решён, ни одна задача не закрыта')
    assert.equal(host.data().storage['skipped.run_1'], undefined, 'записи о пропуске нет')
  }, skipOpts('commit', 'dispatched')))

test('skip: «Перезапустить шаг» снимает пропуск со всего хвоста', () =>
  withWorker(async (worker, host) => {
    await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'skip', runId: 'run_1' })
    assert.ok(host.data().storage['skipped.run_1'], 'пропуск записан')
    await worker.request('task.retry', { runId: 'run_1', taskId: 'task_b' })
    const left = host.data().storage['skipped.run_1'] as Record<string, unknown> | undefined
    assert.ok(!left || Object.keys(left).length === 0, 'шаг и его хвост снова в работе: записи о пропуске нет')
  }, skipOpts('commit')))

// ---- адрес проекта через симлинк (переезд на другой логин) --------------------------------------
test('адрес проекта через симлинк: помощник создаётся в воркспейсе проекта, а не selector_not_found', () => {
  // Как на новом Маке: старый домашний каталог — симлинк, реестр Орки отдаёт адрес через него,
  // а воркспейс зарегистрирован по настоящему адресу. macOS: сам tmpdir лежит за симлинком —
  // берём настоящий адрес, чтобы сравнивать не две разные записи одного каталога.
  const real = realpathSync.native(mkdtempSync(join(tmpdir(), 'wfv-real-')))
  const link = join(tmpdir(), `wfv-link-${process.pid}-${Date.now()}`)
  symlinkSync(real, link, 'dir')
  return withWorker(async (worker, host) => {
    try {
      const { project } = await worker.request('project.current') as { project: { path: string } | null }
      assert.equal(project?.path, real, 'адрес проекта из реестра приведён к настоящему')
      await worker.request('gate.resolve', { gateId: 'gate_1', resolution: 'approve' })
      const created = host.callsOf('terminal.create') as Array<{ workspaceId?: string }> | undefined
      assert.equal(created?.length, 1, 'терминал-помощник создан host-вызовом')
      assert.equal(created?.[0]?.workspaceId, 'w1', 'в воркспейсе проекта')
      assert.ok(!spawned().some((c) => c.includes('orca terminal create')), 'резервная команда CLI не понадобилась — именно она падала с selector_not_found')
    } finally {
      rmSync(link, { force: true })
      rmSync(real, { recursive: true, force: true })
    }
  }, { repoPath: link, workspaces: [{ id: 'w1', kind: 'worktree', name: 'biz.erp', path: real, branch: 'master', project: 'repo:1', hostId: 'local' }] })
})

// ---- создание ворктри при подъёме рана --------------------------------------------------------
// Сцена переезда: реестр Орки знает проект через симлинк, панель передаёт настоящий адрес.
async function raiseInTemp(
  fn: (r: { real: string; link: string; worker: Awaited<ReturnType<typeof mountWorker>>; host: MockHost; job: () => Promise<any> }) => Promise<void>,
  scene: (dirs: { real: string; link: string }) => Record<string, unknown> = () => ({})
): Promise<void> {
  const real = realpathSync.native(mkdtempSync(join(tmpdir(), 'wfv-proj-')))
  const link = join(tmpdir(), `wfv-plink-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
  symlinkSync(real, link, 'dir')
  try {
    return await withWorker(async (worker, host) => {
      const job = async (): Promise<any> => {
        const { jobId } = await worker.request('template.instantiate', {
          source: 'library', projectPath: real, templateId: 'demo',
          objective: 'цель Z', baseBranch: null, worktreeName: 'demo-wt', agent: 'claude'
        })
        let j = null
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 50))
          j = (await worker.request('job.get', { jobId })).job
          if (j && j.status !== 'running') break
        }
        return j
      }
      await fn({ real, link, worker, host, job })
    }, scene({ real, link }))
  } finally {
    rmSync(link, { force: true })
    rmSync(real, { recursive: true, force: true })
  }
}

test('подъём рана: репозиторий выбирается по id, когда реестр знает проект через симлинк', () =>
  raiseInTemp(async ({ job }) => {
    const j = await job()
    assert.equal(j.status, 'done', j.error ?? '')
    const create = spawned().find((c) => c.includes('orca worktree create'))
    assert.ok(create, 'ворктри создаётся')
    assert.ok(create.includes("--repo 'id:r1'"), 'селектор репозитория — id, а не адрес: ' + create.slice(0, 120))
    assert.ok(!create.includes('|| true'), 'отказ создания больше не глушится')
    assert.equal(spawned().filter((c) => c.includes('orca agent launch')).length, 1, 'координатор запущен в созданном ворктри')
  }, (dirs) => ({ repoPath: dirs.link })))

test('подъём рана: реестр не знает адрес проекта — подъём останавливается с причиной, а не молчит', () =>
  raiseInTemp(async ({ job }) => {
    const j = await job()
    assert.equal(j.status, 'failed')
    assert.ok(/не создан: repo_not_found/.test(j.error), 'в отчёте — ответ Орки, а не обрывок команды: ' + j.error)
    assert.equal(spawned().filter((c) => c.includes('orca agent launch')).length, 0, 'координатора не запускают в несуществующий ворктри')
  }, () => ({ repoPath: '/elsewhere/another-checkout' })))

test('подъём рана: имя свободного воркспейса без ранов используется повторно — без создания', () =>
  raiseInTemp(async ({ job }) => {
    const j = await job()
    assert.equal(j.status, 'done', j.error ?? '')
    assert.equal(spawned().filter((c) => c.includes('orca worktree create')).length, 0, 'существующий ворктри не пересоздаётся')
    const launch = spawned().find((c) => c.includes('orca agent launch'))
    assert.ok(launch?.includes(`path:${WS_ROOT}/demo-wt`), 'координатор стартует в существующем ворктри')
  }, () => ({
    workspaces: [{ id: 'w9', kind: 'worktree', name: 'demo-wt', path: `${WS_ROOT}/demo-wt`, branch: 'feat/x', project: 'repo:1', hostId: 'local' }]
  })))

test('подъём рана: воркспейс, в котором уже поднимались раны, используется — новая сессия координатора в нём, без суффикса', () =>
  raiseInTemp(async ({ job, host }) => {
    const j = await job()
    assert.equal(j.status, 'done', j.error ?? '')
    assert.equal(spawned().filter((c) => c.includes('orca worktree create')).length, 0, 'новый ворктри рядом не создаётся')
    const launch = spawned().find((c) => c.includes('orca agent launch'))
    assert.ok(launch?.includes(`path:${WS_ROOT}/demo-wt`), 'координатор стартует в существующем воркспейсе')
    const auto = host.data().storage['auto.run_2'] as { worktreeName?: string }
    assert.equal(auto.worktreeName, 'demo-wt', 'ран помнит имя воркспейса — по нему стартуют воркеры')
  }, (dirs) => ({
    repoPath: dirs.link, // реестр знает проект — создание ворктри прошло бы, но его нет
    // в этом воркспейсе уже поднимался ран
    storage: { 'runmeta.run_1': { projectPath: '/Users/tester/PhpstormProjects/biz.erp', worktreePath: `${WS_ROOT}/demo-wt` } },
    workspaces: [{ id: 'w9', kind: 'worktree', name: 'demo-wt', path: `${WS_ROOT}/demo-wt`, branch: 'feat/x', project: 'repo:1', hostId: 'local' }]
  })))

test('подъём рана: два рана в одном воркспейсе — бриф у каждого свой, чужой не перезаписывается', () => {
  // Очередь id ранов: мок отвечает на каждый run-create следующим id — сцена читает её снаружи колбэка.
  const ids = ['run_2', 'run_3']
  const queue = [...ids]
  return withWorker(async (worker, host) => {
    for (const runId of ids) {
      const { jobId } = await worker.request('template.instantiate', {
        source: 'library', projectPath: null, templateId: 'demo',
        objective: `цель ${runId}`, baseBranch: null, worktreeName: 'demo-wt', agent: 'claude'
      })
      let job = null
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 50))
        job = (await worker.request('job.get', { jobId })).job
        if (job && job.status !== 'running') break
      }
      assert.equal(job.status, 'done', `${runId}: ` + (job.error ?? ''))
    }
    const files = spawned().filter((c) => c.includes('base64 -d >')).map((c) => (c.match(/coordinator-brief\.(run_\d+)\.md/) || [])[1]).filter(Boolean)
    assert.deepEqual([...new Set(files)].sort(), ['run_2', 'run_3'], 'у каждого рана — свой файл брифа: ' + files.join(','))
    for (const runId of ids) {
      const own = briefWrites(runId)
      assert.ok(own.length > 0 && own.every((c) => briefOf(c).includes(`Ты координатор рана ${runId}.`)), `бриф ${runId} называет свой ран`)
      const auto = host.data().storage[`auto.${runId}`] as { worktreeName?: string }
      assert.equal(auto.worktreeName, 'demo-wt', 'оба рана живут в одном воркспейсе')
    }
    assert.equal(spawned().filter((c) => c.includes('orca worktree create')).length, 0, 'второй ворктри не создаётся')
  }, {
    runId: () => queue.shift() ?? 'run_extra',
    workspaces: [{ id: 'w9', kind: 'worktree', name: 'demo-wt', path: `${WS_ROOT}/demo-wt`, branch: 'feat/x', project: 'repo:1', hostId: 'local' }]
  })
})

test('↻ бриф рана, поднятого до раздельных брифов, обновляет и старый общий файл — координатор знает старый путь', () =>
  withWorker(async (worker) => {
    const answer = await worker.request('run.brief.refresh', { runId: 'run_1' })
    assert.equal(answer.briefRel, '.orca/coordinator-brief.run_1.md')
    const write = spawned().filter((c) => c.includes('base64 -d >')).at(-1) ?? ''
    const dir = `${WS_ROOT}/demo-wt/.orca`
    assert.ok(write.includes(`> '${dir}/coordinator-brief.run_1.md'`), 'свой файл записан: ' + write.slice(-160))
    assert.ok(write.includes(`&& cp '${dir}/coordinator-brief.run_1.md' '${dir}/coordinator-brief.md'`), 'старый общий файл обновлён тем же текстом: ' + write.slice(-160))
    assert.ok(briefOf(write).includes('Ты координатор рана run_1.'), 'бриф — этого рана')
  }, {
    storage: {
      'runmeta.run_1': { projectPath: null, templateId: 'demo', objective: 'цель' },
      // Состояние рана, поднятого до раздельных брифов: без briefRel.
      'auto.run_1': { worktreeName: 'demo-wt', worktreePath: `${WS_ROOT}/demo-wt`, repoPath: null, driver: 'coordinator' }
    }
  }))

test('подъём рана: вписана папка воркспейса, а не его имя — ран запоминает имя (по нему Орка находит воркспейс)', () =>
  raiseDemo(async ({ job, host }) => {
    assert.equal(job.status, 'done', job.error ?? '')
    assert.equal(spawned().filter((c) => c.includes('orca worktree create')).length, 0, 'воркспейс найден по папке — не создаётся')
    const launch = spawned().find((c) => c.includes('orca agent launch')) ?? ''
    assert.ok(launch.includes(`path:${WS_ROOT}/momento-re`), 'координатор стартует в этом воркспейсе')
    assert.ok(!launch.includes('name:momento-re'), 'селектор name: по папке Орка не понимает — в брифе его нет')
    assert.ok(launch.includes('name:YCLPRODUCT-68'), 'воркерам — имя воркспейса: ' + launch.slice(launch.indexOf('Ворктри воркеров'), launch.indexOf('Ворктри воркеров') + 60))
    const auto = host.data().storage['auto.run_2'] as { worktreeName?: string; worktreePath?: string | null }
    assert.equal(auto.worktreeName, 'YCLPRODUCT-68', 'состояние рана хранит displayName')
    assert.equal(auto.worktreePath, `${WS_ROOT}/momento-re`, 'путь воркспейса известен сразу — панель привяжет ран и до запуска координатора')
  }, {
    worktreeName: 'momento-re',
    workspaces: [{ id: 'w9', kind: 'worktree', name: 'YCLPRODUCT-68', path: `${WS_ROOT}/momento-re`, branch: 'YCLPRODUCT-68', project: 'repo:1', hostId: 'local' }]
  }))
