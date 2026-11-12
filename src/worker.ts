// The plugin's worker: the CLI bridge, orchestration snapshot, gate/task management and
// template materialization. Runs for as long as the plugin is enabled (it owns a status
// bar item), polls a light refresh, and pushes 'state.changed' to open panels.
import { Bridge, BridgeError, shellPath } from './bridge'
import type { WfGate, WfJob, WfRun, WfSnapshot, WfStep, WfTask, WfTemplate, WfWorker } from './protocol'
import { applyPlaceholders, parseTemplate } from './workflow'
import { parseYaml, type YamlValue } from './yaml'
import type { OrcaWorkerApi } from 'orca/worker'

const DEFAULT_LIBRARY = '~/orca-plugins/workflow-view/workflows'
const DEFAULT_REFRESH_MS = 10_000
const MIN_REFRESH_MS = 2_000
const MAX_REFRESH_MS = 120_000

function clampRefresh(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_REFRESH_MS
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(n)))
}

type Envelope<T> = { ok: boolean; result: T; error?: { message?: string } }

function shellQuote(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

function field(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (record[name] !== undefined && record[name] !== null) return record[name]
  }
  return null
}

let stopTimer: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const bridge = new Bridge(orca)
  let everUsed = false
  let refreshing = false
  let lastSnapshot = ''
  stopTimer = null

  // ---- bridge helpers -------------------------------------------------------------------------

  async function fromFlag(): Promise<string> {
    return `--from ${await bridge.ensure()}`
  }

  async function cli<T>(command: string, timeoutMs?: number): Promise<T> {
    const envelope = await bridge.json<Envelope<T>>(command, timeoutMs)
    if (envelope && envelope.ok === true) return envelope.result
    throw new BridgeError(
      (envelope && envelope.error && envelope.error.message) || `команда не удалась: ${command.slice(0, 120)}`,
      'cli_error'
    )
  }

  // ---- snapshot --------------------------------------------------------------------------------

  async function listRuns(): Promise<WfRun[]> {
    const result = await cli<{ runs?: unknown } | unknown[]>('orca orchestration run-list --limit 20 --json')
    const rows: Record<string, unknown>[] = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : asArray<Record<string, unknown>>(result.runs)
    return rows.map((row) => ({
      runId: String(field(row, 'runId', 'id') ?? ''),
      objective: String(field(row, 'objective') ?? '')
    }))
  }

  async function snapshot(runId: string | null): Promise<WfSnapshot> {
    const at = Date.now()
    const runs = await listRuns()
    if (!runId) {
      return { at, run: null, tasks: [], gates: [], workers: [], error: null }
    }
    const run = runs.find((r) => r.runId === runId) ?? (runId ? { runId, objective: '' } : null)
    const [taskRows, readyRows, gateRows, workerRows] = await Promise.all([
      cli<{ tasks?: unknown }>(`orca orchestration task-list --run ${shellQuote(runId)} --json`),
      cli<{ tasks?: unknown }>(`orca orchestration task-list --run ${shellQuote(runId)} --ready --brief --json`),
      cli<{ gates?: unknown }>(`orca orchestration gate-list --run ${shellQuote(runId)} --json`),
      cli<{ workers?: unknown; dispatches?: unknown }>(`orca orchestration worker-list --run ${shellQuote(runId)} --json`)
    ])
    const readyIds = new Set(
      asArray<Record<string, unknown>>(readyRows.tasks).map((row) => String(field(row, 'id') ?? ''))
    )
    const tasks: WfTask[] = asArray<Record<string, unknown>>(taskRows.tasks).map((row) => {
      const id = String(field(row, 'id') ?? '')
      const rawStatus = String(field(row, 'status') ?? 'unknown')
      const dispatch = String(field(row, 'dispatchId') ?? '') || null
      return {
        id,
        title: String(field(row, 'taskTitle', 'title') ?? ''),
        status: dispatch ? 'dispatched' : readyIds.has(id) ? 'ready' : normalizeStatus(rawStatus),
        deps: asArray(field(row, 'deps')) .map(String),
        dispatchId: dispatch,
        agent: null
      }
    })
    const byTitleAgent = new Map(
      asArray<Record<string, unknown>>(workerRows.workers ?? workerRows.dispatches).map((row) => [
        String(field(row, 'taskId') ?? ''),
        String(field(row, 'agent') ?? '') || null
      ])
    )
    for (const task of tasks) if (byTitleAgent.has(task.id)) task.agent = byTitleAgent.get(task.id) ?? null
    const gates: WfGate[] = asArray<Record<string, unknown>>(gateRows.gates).map((row) => {
      const taskId = String(field(row, 'taskId') ?? '')
      return {
        id: String(field(row, 'id') ?? ''),
        taskId,
        taskTitle: tasks.find((t) => t.id === taskId)?.title ?? taskId,
        question: String(field(row, 'question') ?? ''),
        options: asArray(field(row, 'options')).map(String),
        status: String(field(row, 'status') ?? 'pending') === 'resolved' ? 'resolved' : 'pending'
      }
    })
    const workers: WfWorker[] = asArray<Record<string, unknown>>(workerRows.workers ?? workerRows.dispatches).map(
      (row) => ({
        dispatchId: String(field(row, 'dispatchId', 'id') ?? ''),
        taskId: String(field(row, 'taskId') ?? '') || null,
        taskTitle: tasks.find((t) => t.id === String(field(row, 'taskId') ?? ''))?.title ?? null,
        state: String(field(row, 'state', 'status') ?? '?')
      })
    )
    return { at, run, tasks, gates, workers, error: null }
  }

  function normalizeStatus(raw: string): WfTask['status'] {
    if (raw === 'pending' || raw === 'blocked' || raw === 'succeeded' || raw === 'failed') return raw
    if (raw === 'completed' || raw === 'done') return 'succeeded'
    if (raw === 'dispatched' || raw === 'working') return 'dispatched'
    return 'unknown'
  }

  // ---- refresh + status bar --------------------------------------------------------------------

  async function refresh(): Promise<void> {
    if (refreshing || !everUsed) return
    refreshing = true
    try {
      const storedRun = await orca.storage.get('state.selectedRunId')
      const runId = typeof storedRun === 'string' && storedRun !== '' ? storedRun : null
      let snap: WfSnapshot
      try {
        snap = await snapshot(runId)
      } catch (error) {
        snap = { at: Date.now(), run: null, tasks: [], gates: [], workers: [], error: message(error) }
      }
      const serialized = JSON.stringify(snap)
      if (serialized !== lastSnapshot) {
        lastSnapshot = serialized
        await orca.storage.set('state.snapshot', snap)
        orca.panels.post('state.changed', {
          at: snap.at,
          pendingGates: snap.gates.filter((g) => g.status === 'pending').length,
          readyTasks: snap.tasks.filter((t) => t.status === 'ready').length
        })
      }
      await updateStatusBar(snap)
    } finally {
      refreshing = false
    }
  }

  async function updateStatusBar(snap: WfSnapshot): Promise<void> {
    const pendingGates = snap.gates.filter((g) => g.status === 'pending').length
    const ready = snap.tasks.filter((t) => t.status === 'ready').length
    const text = snap.error ? 'WF: ошибка' : pendingGates > 0 ? `WF: ⏳ ${pendingGates} гейт(ов)` : ready > 0 ? `WF: ▶ ${ready}` : 'WF: ок'
    await orca.host.call('statusBar.update', {
      id: 'wf-status',
      text,
      tone: pendingGates > 0 ? 'warning' : snap.error ? 'danger' : 'neutral',
      tooltip: snap.error ?? (snap.run ? snap.run.objective : 'Workflow View')
    })
  }

  // The refresh loop reads the interval setting every cycle, so Settings changes apply at once.
  let stopped = false
  let wakeTimer: ReturnType<typeof setTimeout> | null = null
  const eventsSub = orca.events.on('agent.status.changed', () => {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      void refresh()
    }, 1_000)
  })
  const loop = async (): Promise<void> => {
    while (!stopped) {
      const storedMs = await orca.settings.get('refreshMs')
      const ms = clampRefresh(storedMs)
      await new Promise((resolve) => setTimeout(resolve, ms))
      if (stopped) break
      await refresh()
    }
  }
  void loop()
  stopTimer = () => {
    stopped = true
    if (wakeTimer) clearTimeout(wakeTimer)
    eventsSub.dispose()
  }

  // ---- templates ---------------------------------------------------------------------------------

  async function libraryDir(): Promise<string> {
    const stored = await orca.settings.get('libraryDir')
    const raw = typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : DEFAULT_LIBRARY
    return raw.startsWith('~/') ? (await bridge.run('echo $HOME')).trim() + raw.slice(1) : raw
  }

  async function workflowsDir(source: 'library' | 'project', projectPath: string | null): Promise<string> {
    if (source === 'library') return libraryDir()
    if (!projectPath) throw new BridgeError('project-источник требует projectPath', 'no_terminal')
    return `${projectPath.replace(/\/+$/, '')}/.orca/workflows`
  }

  /** Reads many files in one bridge command; answers path -> content. */
  async function readFiles(dir: string, files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    if (files.length === 0) return out
    const parts = files.map((f) => `echo __FILE__${f}; cat ${shellQuote(`${dir}/${f}`)}`)
    const output = await bridge.run(parts.join('; '))
    let current: string | null = null
    const chunks: string[] = []
    for (const line of output.split('\n')) {
      if (line.startsWith('__FILE__')) {
        if (current) out[current] = chunks.join('\n')
        current = line.slice('__FILE__'.length).trim()
        chunks.length = 0
      } else if (current) {
        chunks.push(line)
      }
    }
    if (current) out[current] = chunks.join('\n')
    return out
  }

  async function listTemplates(source: 'library' | 'project', projectPath: string | null): Promise<WfTemplate[]> {
    everUsed = true
    const dir = await workflowsDir(source, projectPath)
    const listing = await bridge.run(`ls -1 ${shellPath(dir)}/*.yaml 2>/dev/null || true`)
    const yamlFiles = listing
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.endsWith('.yaml'))
      .map((l) => l.slice(dir.length + 1))
    if (yamlFiles.length === 0) return []
    const contents = await readFiles(dir, yamlFiles)
    const templates: WfTemplate[] = []
    const specFiles: Record<string, string | null> = {}
    for (const file of yamlFiles) {
      const fallbackId = file.replace(/\.yaml$/, '')
      try {
        const parsed = parseTemplate(file, parseYaml(contents[file] ?? ''))
        templates.push({
          id: parsed.id,
          title: parsed.title,
          source,
          sourcePath: dir,
          file,
          steps: parsed.steps.map((s) => ({ ...s, spec: null })),
          error: null
        })
        for (const step of parsed.steps) if (parsed.specFiles[step.id]) specFiles[parsed.specFiles[step.id] as string] = null
        templates[templates.length - 1].steps = parsed.steps
      } catch (error) {
        templates.push({
          id: fallbackId,
          title: fallbackId,
          source,
          sourcePath: dir,
          file,
          steps: [],
          error: message(error)
        })
      }
    }
    // Resolve specFile contents (paths relative to the workflows dir) in one read.
    const specs = await readFiles(dir, Object.keys(specFiles))
    for (const template of templates) {
      if (template.error) continue
      const parsed = parseTemplate(template.file, parseYaml(contents[template.file] ?? ''))
      template.steps = parsed.steps.map((step) => {
        const rel = parsed.specFiles[step.id]
        return { ...step, spec: rel ? (specs[rel] ?? null) : step.spec }
      })
    }
    return templates
  }

  // ---- instantiate ---------------------------------------------------------------------------------

  function topoOrder(steps: WfStep[]): WfStep[] {
    const byId = new Map(steps.map((s) => [s.id, s]))
    const seen = new Set<string>()
    const order: WfStep[] = []
    const visit = (id: string, stack: Set<string>): void => {
      if (seen.has(id)) return
      if (stack.has(id)) throw new BridgeError(`цикл в deps через шаг "${id}"`, 'cli_error')
      stack.add(id)
      for (const dep of byId.get(id)?.deps ?? []) visit(dep, stack)
      stack.delete(id)
      seen.add(id)
      const step = byId.get(id)
      if (step) order.push(step)
    }
    for (const step of steps) visit(step.id, new Set())
    return order
  }

  /** Task ids a step depends on, through barrier steps (steps without an agent). */
  function taskDeps(step: WfStep, taskOf: Map<string, string>): string[] {
    const out: string[] = []
    const walk = (id: string): void => {
      const dep = stepsById.get(id)
      if (!dep) return
      if (dep.agent && taskOf.has(dep.id)) {
        out.push(taskOf.get(dep.id) as string)
        return
      }
      for (const d of dep.deps) walk(d)
    }
    for (const dep of step.deps) walk(dep)
    return [...new Set(out)]
  }

  /** Checkpoints of barrier ancestors plus the step's own; consumed set prevents duplicates. */
  function gatesFor(step: WfStep, consumed: Set<string>): Array<NonNullable<WfStep['gate']>> {
    const gates: Array<NonNullable<WfStep['gate']>> = []
    if (step.agent && step.gate) gates.push(step.gate)
    const walk = (id: string): void => {
      const dep = stepsById.get(id)
      if (!dep || dep.agent) return
      if (dep.gate && !consumed.has(dep.id)) {
        consumed.add(dep.id)
        gates.push(dep.gate)
      }
      for (const d of dep.deps) walk(d)
    }
    for (const dep of step.deps) walk(dep)
    return gates
  }

  let stepsById = new Map<string, WfStep>()

  async function loadTemplate(
    source: 'library' | 'project',
    projectPath: string | null,
    templateId: string
  ): Promise<WfTemplate> {
    const templates = await listTemplates(source, projectPath)
    const template = templates.find((t) => t.id === templateId)
    if (!template) throw new BridgeError(`шаблон "${templateId}" не найден`, 'cli_error')
    if (template.error) throw new BridgeError(`шаблон "${templateId}": ${template.error}`, 'cli_error')
    return template
  }

  async function saveJob(job: WfJob, runId?: string | null): Promise<void> {
    const stored = await orca.storage.get('jobs')
    const jobs = (typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {}) as Record<
      string,
      WfJob
    >
    if (runId !== undefined && runId !== null) job.runId = runId
    jobs[job.id] = job
    const ids = Object.keys(jobs).sort()
    for (const id of ids.slice(0, Math.max(0, ids.length - 20))) delete jobs[id]
    await orca.storage.set('jobs', jobs)
    orca.panels.post('job.progress', { job })
  }

  async function runInstantiate(input: {
    source: 'library' | 'project'
    projectPath: string | null
    templateId: string
    objective: string
    baseBranch: string | null
    worktreeName: string
    agent: string
  }): Promise<string> {
    const template = await loadTemplate(input.source, input.projectPath, input.templateId)
    const job: WfJob = {
      id: `job_${Date.now().toString(36)}`,
      kind: 'instantiate',
      label: template.title,
      status: 'running',
      step: 'run-create',
      runId: null,
      error: null
    }
    await saveJob(job)
    void (async () => {
      try {
        const from = await fromFlag()
        const vars: Record<string, string> = {
          objective: input.objective,
          repo: input.projectPath ?? '',
          base_branch: input.baseBranch ?? '',
          worktree: input.worktreeName
        }
        const run = await cli<{ runId: string }>(
          `orca orchestration run-create ${from} --objective ${shellQuote(`${template.title} — ${input.objective}`)} --json`
        )
        job.step = 'tasks'
        await saveJob(job, run.runId)
        stepsById = new Map(template.steps.map((s) => [s.id, s]))
        const order = topoOrder(template.steps)
        const taskOf = new Map<string, string>()
        const consumed = new Set<string>()
        for (const step of order) {
          if (!step.agent) continue
          const spec = applyPlaceholders(step.spec ?? '', vars)
          const title = applyPlaceholders(step.title ?? step.id, vars)
          const specFile = `/tmp/wfv-${job.id}-${step.id}.md`
          await bridge.run(`printf %s ${shellQuote(toBase64(spec))} | base64 -d > ${specFile}`)
          const deps = taskDeps(step, taskOf)
          const depsFlag = deps.length > 0 ? ` --deps ${shellQuote(JSON.stringify(deps))}` : ''
          const task = await cli<{ taskId: string; id?: string }>(
            `orca orchestration task-create ${from} --run ${shellQuote(run.runId)} --task-title ${shellQuote(
              `${step.id} ${title}`
            )} --spec-file ${specFile}${depsFlag} --json`
          )
          taskOf.set(step.id, String(task.taskId ?? task.id ?? ''))
          job.step = `gate ${step.id}`
          await saveJob(job)
          for (const gate of gatesFor(step, consumed)) {
            await bridge.run(
              `orca orchestration gate-create ${from} --task ${shellQuote(
                taskOf.get(step.id) as string
              )} --question ${shellQuote(applyPlaceholders(gate.question, vars))} --options ${shellQuote(
                JSON.stringify(gate.options)
              )} --json`
            )
          }
        }
        job.step = 'done'
        job.status = 'done'
        await saveJob(job)
        await refresh()
      } catch (error) {
        job.status = 'failed'
        job.error = message(error)
        await saveJob(job)
      }
    })()
    return job.id
  }

  // ---- handlers ------------------------------------------------------------------------------------

  orca.panels.handle('runs.list', async () => {
    everUsed = true
    try {
      return { runs: await listRuns(), error: null }
    } catch (error) {
      return { runs: [], error: message(error) }
    }
  })

  orca.panels.handle('workspaces.list', async () => {
    everUsed = true
    const list = await orca.host.call('workspace.list', undefined)
    return {
      workspaces: list.workspaces.map((w) => ({ id: w.id, kind: w.kind, name: w.name, path: w.path, branch: w.branch }))
    }
  })

  orca.panels.handle('projects.list', async () => {
    everUsed = true
    const result = await cli<{ repos?: unknown }>('orca repo list --json')
    const repos = asArray<Record<string, unknown>>(result.repos)
    return {
      projects: repos
        .filter((repo) => field(repo, 'kind') === 'git')
        .map((repo) => ({
          repoId: String(field(repo, 'id') ?? ''),
          name: String(field(repo, 'displayName') ?? ''),
          path: String(field(repo, 'path') ?? '')
        }))
        .filter((p) => p.path !== '')
    }
  })

  orca.panels.handle('state.get', async ({ runId }) => {
    everUsed = true
    void refresh()
    try {
      const snap = await snapshot(runId ?? null)
      lastSnapshot = JSON.stringify(snap)
      await orca.storage.set('state.snapshot', snap)
      return snap
    } catch (error) {
      const cached = await orca.storage.get('state.snapshot')
      if (cached && typeof cached === 'object') {
        return { ...(cached as WfSnapshot), at: Date.now(), error: message(error) }
      }
      return { at: Date.now(), run: null, tasks: [], gates: [], workers: [], error: message(error) }
    }
  })

  orca.panels.handle('gate.resolve', async ({ gateId, resolution }) => {
    everUsed = true
    await bridge.run(
      `orca orchestration gate-resolve --id ${shellQuote(gateId)} --resolution ${shellQuote(resolution)} ${await fromFlag()} --json`
    )
    void refresh()
    return { ok: true as const }
  })

  orca.panels.handle('task.start', async ({ taskId, agent, model, effort, worktree }) => {
    everUsed = true
    const modelFlags = model ? ` --model ${shellQuote(model)}` : ''
    const effortFlags = model && effort ? ` --effort ${shellQuote(effort)}` : ''
    const result = await cli<{ dispatchId: string; state: string }>(
      `orca orchestration worker-start --task ${shellQuote(taskId)} --agent ${shellQuote(agent)} --worktree ${shellQuote(
        worktree
      )}${modelFlags}${effortFlags} ${await fromFlag()} --json`,
      90_000
    )
    void refresh()
    return { dispatchId: result.dispatchId, state: result.state }
  })

  orca.panels.handle('template.list', async ({ source, projectPath }) => ({
    templates: await listTemplates(source, projectPath ?? null)
  }))

  orca.panels.handle('template.instantiate', async (input) => ({
    jobId: await runInstantiate(input)
  }))

  orca.panels.handle('template.copy', async ({ from, to, templateId, fromProjectPath, toProjectPath }) => {
    everUsed = true
    const templates = await listTemplates(from, fromProjectPath ?? null)
    const template = templates.find((t) => t.id === templateId)
    if (!template) throw new BridgeError(`шаблон "${templateId}" не найден`, 'cli_error')
    const fromDir = template.sourcePath as string
    const toDir = await workflowsDir(to, toProjectPath ?? null)
    await bridge.run(
      `mkdir -p ${shellPath(toDir)} && cp ${shellQuote(`${fromDir}/${template.file}`)} ${shellPath(
        toDir
      )}/ && { [ -d ${shellQuote(`${fromDir}/specs`)} ] && cp -R ${shellQuote(`${fromDir}/specs`)} ${shellPath(
        toDir
      )}/; true; }`
    )
    return { ok: true as const }
  })

  orca.panels.handle('job.get', async ({ jobId }) => {
    const stored = await orca.storage.get('jobs')
    const jobs = (typeof stored === 'object' && stored !== null ? stored : {}) as Record<string, WfJob>
    return { job: jobs[jobId] ?? null }
  })

  orca.panels.handle('settings.get', async () => {
    const library = await orca.settings.get('libraryDir')
    const agent = await orca.settings.get('defaultAgent')
    return {
      libraryDir: typeof library === 'string' && library.trim() !== '' ? library.trim() : DEFAULT_LIBRARY,
      refreshMs: clampRefresh(await orca.settings.get('refreshMs')),
      defaultAgent: typeof agent === 'string' && agent.trim() !== '' ? agent.trim() : 'claude'
    }
  })

  orca.panels.handle('settings.save', async (input) => {
    const libraryDir = input.libraryDir.trim() !== '' ? input.libraryDir.trim() : DEFAULT_LIBRARY
    const defaultAgent = input.defaultAgent.trim() !== '' ? input.defaultAgent.trim() : 'claude'
    const refreshMs = clampRefresh(input.refreshMs)
    await orca.settings.set('libraryDir', libraryDir)
    await orca.settings.set('refreshMs', refreshMs)
    await orca.settings.set('defaultAgent', defaultAgent)
    return { libraryDir, refreshMs, defaultAgent }
  })

  orca.panels.handle('bridge.reset', async () => {
    await bridge.reset()
    return { ok: true as const }
  })

  orca.panels.handle('bridge.info', async () => {
    const stored = await orca.storage.get('bridge.terminalId')
    return { terminalId: typeof stored === 'string' && stored !== '' ? stored : null }
  })
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function deactivate(): void {
  stopTimer?.()
  stopTimer = null
}
