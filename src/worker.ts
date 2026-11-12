// The plugin's worker: the CLI bridge, orchestration snapshot, gate/task management and
// template materialization. Runs for as long as the plugin is enabled (it owns a status
// bar item), polls a light refresh, and pushes 'state.changed' to open panels.
import { Bridge, BridgeError, shellPath } from './bridge'
import type { WfGate, WfJob, WfRun, WfSnapshot, WfSpecialist, WfStep, WfTask, WfTemplate, WfWorker } from './protocol'
import { applyPlaceholders, materialize, parseTemplate, topoUnits } from './workflow'
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

function fromBase64(text: string): string {
  const bytes = Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

/** Pulls the first JSON document out of terminal output that may carry markers around it. */
function extractJson(text: string): string {
  const trimmed = text.trim()
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  return first >= 0 && last > first ? trimmed.slice(first, last + 1) : trimmed
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** The concise CLI view packs arrays (deps, options) as JSON strings; accept both shapes. */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map(String) : []
    } catch {
      return []
    }
  }
  return []
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
    const out: WfRun[] = []
    for (const row of rows) {
      const runId = String(field(row, 'runId', 'id') ?? '')
      let projectPath: string | null = null
      try {
        const meta = await orca.storage.get(`runmeta.${runId}`)
        if (meta && typeof meta === 'object') {
          const path = (meta as { projectPath?: unknown }).projectPath
          if (typeof path === 'string' && path !== '') projectPath = path
        }
        if (!projectPath) {
          // Runs the autopilot raised know their repo from their own state.
          const auto = await orca.storage.get(`auto.${runId}`)
          if (auto && typeof auto === 'object') {
            const path = (auto as { repoPath?: unknown }).repoPath
            if (typeof path === 'string' && path !== '') projectPath = path
          }
        }
      } catch {
        // metadata is an extra; the run still lists without a project
      }
      out.push({ runId, objective: String(field(row, 'objective') ?? ''), projectPath })
    }
    return out
  }

  async function snapshot(runId: string | null): Promise<WfSnapshot> {
    const at = Date.now()
    const runs = await listRuns()
    if (!runId) {
      return { at, run: null, tasks: [], gates: [], workers: [], error: null }
    }
    const run = runs.find((r) => r.runId === runId) ?? (runId ? { runId, objective: '', projectPath: null } : null)
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
        deps: stringList(field(row, 'deps')),
        dispatchId: dispatch,
        agent: null,
        model: null
      }
    })
    // Template config from instantiate: agent and model per task, when we raised the run.
    const autoStored = await orca.storage.get(`auto.${runId}`)
    if (autoStored && typeof autoStored === 'object') {
      const autoTasks = (autoStored as { tasks?: Record<string, { agent?: string; model?: string | null }> }).tasks ?? {}
      for (const task of tasks) {
        const cfg = autoTasks[task.id]
        if (cfg) {
          task.agent = cfg.agent ?? task.agent
          task.model = cfg.model ?? null
        }
      }
    }
    // Manual agent notes for runs raised before per-step configuration existed.
    const agentsStored = await orca.storage.get(`agents.${runId}`)
    if (agentsStored && typeof agentsStored === 'object') {
      const noted = agentsStored as Record<string, string>
      for (const task of tasks) {
        const agent = noted[task.id]
        if (agent && !task.agent) task.agent = agent
      }
    }
    const byTitleAgent = new Map(
      asArray<Record<string, unknown>>(workerRows.workers ?? workerRows.dispatches).map((row) => [
        String(field(row, 'taskId') ?? ''),
        String(field(row, 'agent') ?? '') || null
      ])
    )
    for (const task of tasks) {
      // A finished dispatch's row can outlive its agent identity; never erase a known agent.
      const live = byTitleAgent.get(task.id)
      if (live) task.agent = live
    }
    const gates: WfGate[] = asArray<Record<string, unknown>>(gateRows.gates).map((row) => {
      const taskId = String(field(row, 'taskId') ?? '')
      return {
        id: String(field(row, 'id') ?? ''),
        taskId,
        taskTitle: tasks.find((t) => t.id === taskId)?.title ?? taskId,
        question: String(field(row, 'question') ?? ''),
        options: stringList(field(row, 'options')),
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
    return { at, run, tasks: orderTasks(tasks), gates, workers, error: null }
  }

  function normalizeStatus(raw: string): WfTask['status'] {
    if (raw === 'pending' || raw === 'blocked' || raw === 'succeeded' || raw === 'failed') return raw
    if (raw === 'completed' || raw === 'done') return 'succeeded'
    if (raw === 'dispatched' || raw === 'working') return 'dispatched'
    return 'unknown'
  }

  /** Pipeline order: dependencies first, then what depends on them; stable for parallel steps. */
  function orderTasks(tasks: WfTask[]): WfTask[] {
    const byId = new Map(tasks.map((t) => [t.id, t]))
    const emitted = new Set<string>()
    const out: WfTask[] = []
    let progress = true
    while (out.length < tasks.length && progress) {
      progress = false
      for (const task of tasks) {
        if (emitted.has(task.id)) continue
        const ready = task.deps.every((dep) => !byId.has(dep) || emitted.has(dep))
        if (ready) {
          emitted.add(task.id)
          out.push(task)
          progress = true
        }
      }
    }
    // A cycle would loop forever above; keep whatever is left in input order.
    for (const task of tasks) if (!emitted.has(task.id)) out.push(task)
    return out
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
      // Auto-pilot: drive the pipeline forward off the same snapshot.
      if (runId) void autopilot(runId, snap).catch((error) => orca.log(`autopilot: ${message(error)}`))
    } finally {
      refreshing = false
    }
  }

  // ---- auto-pilot ---------------------------------------------------------------------------------
  // One-time description, then the pipeline runs itself: ready tasks start with their
  // template agent/model, review verdicts drive on_reject loops, RUN: <id> requests start
  // optional sub-steps. Gates stay the only human stops.

  type AutoState = {
    worktreeName: string
    repoPath: string | null
    baseBranch: string | null
    firstStarted: boolean
    tasks: Record<string, { stepId: string; agent: string; model: string | null; effort: string | null }>
    reviews: Record<string, { devTaskId: string; devStepId: string; maxRounds: number; source: 'verdict' | 'failure' }>
    optionals: Record<string, { parentTaskId: string; stepId: string }>
    verdicts: Record<string, 'approve' | 'request-changes'>
    rounds: Record<string, number>
    actions: number
    stopped: string | null
  }

  async function saveAuto(runId: string, state: AutoState): Promise<void> {
    await orca.storage.set(`auto.${runId}`, state)
  }

  async function loadAuto(runId: string): Promise<AutoState | null> {
    const stored = await orca.storage.get(`auto.${runId}`)
    return stored && typeof stored === 'object' ? (stored as AutoState) : null
  }

  async function autopilot(runId: string, snap: WfSnapshot): Promise<void> {
    const autopilotOn = await orca.settings.get('autoPilot')
    if (autopilotOn === false) return
    const state = await loadAuto(runId)
    if (!state || state.stopped) return
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    let acted = false
    const act = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      if (acted) return
      acted = true
      state.actions += 1
      orca.log(`autopilot[${runId}]: ${what}`)
      try {
        await fn()
      } catch (error) {
        state.stopped = `ошибка: ${message(error)}`
        await saveAuto(runId, state)
        return
      }
      await saveAuto(runId, state)
    }

    // 1. Start ready tasks (the very first one creates the worktree).
    for (const task of snap.tasks) {
      if (acted) break
      if (task.status !== 'ready') continue
      const cfg = state.tasks[task.id]
      if (!cfg) continue // not ours (manual task) — leave for the person
      const from = await fromFlag()
      let worktree = `name:${state.worktreeName}`
      if (!state.firstStarted) {
        state.firstStarted = true
        const repoFlag = state.repoPath ? ` --repo path:${shellQuote(state.repoPath)}` : ''
        const baseFlag = state.baseBranch ? ` --base-branch ${shellQuote(state.baseBranch)}` : ''
        await act(`старт ${cfg.stepId} (new worktree ${state.worktreeName})`, async () =>
          bridge.run(
            `orca orchestration worker-start --task ${shellQuote(task.id)} --from ${from} --worktree new-top-level${repoFlag}${baseFlag} --name ${shellQuote(
              state.worktreeName
            )} --agent ${shellQuote(cfg.agent)}${cfg.model ? ` --model ${shellQuote(cfg.model)}` : ''}${
              cfg.model && cfg.effort ? ` --effort ${shellQuote(cfg.effort)}` : ''
            } --json`,
            90_000
          )
        )
        if (acted) break
      }
      await act(`старт ${cfg.stepId} (в ${worktree})`, async () =>
        bridge.run(
          `orca orchestration worker-start --task ${shellQuote(task.id)} --from ${from} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(cfg.agent)}${cfg.model ? ` --model ${shellQuote(cfg.model)}` : ''}${
            cfg.model && cfg.effort ? ` --effort ${shellQuote(cfg.effort)}` : ''
          } --json`,
          90_000
        )
      )
    }
    if (acted) return

    // 2. Freshly succeeded review units: parse the verdict once, then act.
    for (const task of snap.tasks) {
      if (acted) break
      if (task.status !== 'succeeded' || !task.dispatchId) continue
      const review = state.reviews[task.id]
      if (!review || state.verdicts[task.id]) continue
      const report = await readWorkerReport(task.dispatchId)
      const verdict = parseVerdict(report)
      state.verdicts[task.id] = verdict
      if (verdict === 'request-changes') {
        const round = (state.rounds[review.devTaskId] ?? 0) + 1
        state.rounds[review.devTaskId] = round
        if (round > review.maxRounds) {
          state.stopped = `ревью отклонило работу ${review.maxRounds} раз — конвейер остановлен`
          await saveAuto(runId, state)
          return
        }
        const devTask = byId.get(review.devTaskId)
        const devCfg = state.tasks[review.devTaskId]
        const from2 = await fromFlag()
        await act(`перезапуск ${review.devStepId} (раунд ${round}/${review.maxRounds})`, async () => {
          if (devTask?.dispatchId) {
            await bridge.run(
              `orca orchestration send --to dispatch:${task.dispatchId} --subject "Замечания ревью (раунд ${round})" --body ${shellQuote(
                extractRemarks(report)
              )} --json`
            )
          }
          return bridge.run(
            `orca orchestration worker-start --task ${shellQuote(review.devTaskId)} --from ${from2} --worktree ${shellQuote(
              `name:${state.worktreeName}`
            )} --agent ${shellQuote(devCfg?.agent ?? 'claude')} --json`,
            90_000
          )
        })
        if (acted) return
        // Restart the reviewer right after the reworked dev task finishes: record the pair.
        state.rounds[`__retry_review_${review.devTaskId}`] = 1
        await saveAuto(runId, state)
        return
      }
      // approve: nothing to do, the DAG continues on its own.
      await saveAuto(runId, state)
    }
    if (acted) return

    // 3. After a reworked dev task completes, re-run its reviewer.
    for (const [reviewTaskId, review] of Object.entries(state.reviews)) {
      if (acted) break
      if (review.source !== 'verdict') continue
      const retryMark = state.rounds[`__retry_review_${review.devTaskId}`]
      if (!retryMark) continue
      const devTask = byId.get(review.devTaskId)
      const reviewTask = byId.get(reviewTaskId)
      if (devTask?.status === 'succeeded' && reviewTask?.status === 'succeeded' && state.verdicts[reviewTaskId] === 'request-changes') {
        delete state.rounds[`__retry_review_${review.devTaskId}`]
        const cfg = state.tasks[reviewTaskId]
        const from3 = await fromFlag()
        await act(`перепроверка после правок`, async () =>
          bridge.run(
            `orca orchestration worker-start --task ${shellQuote(reviewTaskId)} --from ${from3} --worktree ${shellQuote(
              `name:${state.worktreeName}`
            )} --agent ${shellQuote(cfg?.agent ?? 'claude')} --json`,
            90_000
          )
        )
      }
    }
    if (acted) return

    // 4. Watched child failures (block on_reject): reject -> retry the goto task.
    for (const [reviewTaskId, review] of Object.entries(state.reviews)) {
      if (acted) break
      if (review.source !== 'failure') continue
      const childTask = byId.get(reviewTaskId)
      if (childTask?.status !== 'failed' || state.verdicts[reviewTaskId]) continue
      state.verdicts[reviewTaskId] = 'request-changes'
      const round = (state.rounds[review.devTaskId] ?? 0) + 1
      state.rounds[review.devTaskId] = round
      if (round > review.maxRounds) {
        state.stopped = `подшаг падал ${review.maxRounds} раз — конвейер остановлен`
        await saveAuto(runId, state)
        return
      }
      const devCfg = state.tasks[review.devTaskId]
      const from4 = await fromFlag()
      await act(`подшаг упал — перезапуск ${review.devStepId} (${round}/${review.maxRounds})`, async () =>
        bridge.run(
          `orca orchestration worker-start --task ${shellQuote(review.devTaskId)} --from ${from4} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(devCfg?.agent ?? 'claude')} --json`,
          90_000
        )
      )
    }
    if (acted) return

    // 5. RUN: <sub-step-id> requests in succeeded parent reports start optional sub-steps.
    for (const [optionalTaskId, link] of Object.entries(state.optionals)) {
      if (acted) break
      if (byId.get(optionalTaskId)?.status && byId.get(optionalTaskId)?.status !== 'pending') continue
      if (state.rounds[`__opt_started_${optionalTaskId}`]) continue
      const parent = byId.get(link.parentTaskId)
      if (!parent?.dispatchId || parent.status !== 'succeeded') continue
      const report = await readWorkerReport(parent.dispatchId)
      const wants = new RegExp(`RUN:\\s*${link.stepId}\\b`).test(report)
      if (!wants) continue
      state.rounds[`__opt_started_${optionalTaskId}`] = 1
      const cfg = state.tasks[optionalTaskId]
      const from5 = await fromFlag()
      await act(`опциональный подшаг ${link.stepId} по запросу из отчёта`, async () =>
        bridge.run(
          `orca orchestration worker-start --task ${shellQuote(optionalTaskId)} --from ${from5} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(cfg?.agent ?? 'claude')} --json`,
          90_000
        )
      )
    }
    void runId
  }

  /** Bounded worker report text (transcript source). */
  async function readWorkerReport(dispatchId: string): Promise<string> {
    try {
      const out = await bridge.run(
        `orca orchestration worker-read --dispatch ${shellQuote(dispatchId)} --limit 200 --json`,
        15_000
      )
      const parsed = JSON.parse(extractJson(out)) as { result?: { rows?: Array<{ text?: string }> } }
      return (parsed.result?.rows ?? []).map((r) => r.text ?? '').join('\n')
    } catch {
      return ''
    }
  }

  /** `VERDICT: approve|request-changes` in the report tail; default approve on failure to say. */
  function parseVerdict(report: string): 'approve' | 'request-changes' {
    const tail = report.slice(-4000)
    const match = tail.match(/VERDICT:\s*(approve|request-changes)/i)
    return match && match[1].toLowerCase() === 'request-changes' ? 'request-changes' : 'approve'
  }

  function extractRemarks(report: string): string {
    const idx = report.lastIndexOf('VERDICT:')
    const remarks = idx >= 0 ? report.slice(Math.max(0, idx - 3000), idx) : report.slice(-3000)
    return remarks.trim().slice(0, 2500) || 'См. полный отчёт ревьюера.'
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
  const wakeSoon = (): void => {
    if (wakeTimer) clearTimeout(wakeTimer)
    wakeTimer = setTimeout(() => {
      wakeTimer = null
      void refresh()
    }, 1_000)
  }
  const eventsSub = orca.events.on('agent.status.changed', wakeSoon)
  // Orca scopes plugin terminal input to the focused workspace; when focus moves, the bridge
  // must be re-ensured in the new workspace before any command can run again.
  const workspaceSub = orca.events.on('workspace.changed', () => {
    void bridge.reset()
    wakeSoon()
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
    workspaceSub.dispose()
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

  /** Reads many files in one bridge command; answers path -> content. Base64 keeps the
   *  payload immune to the terminal's line wrapping. */
  async function readFiles(dir: string, files: string[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    if (files.length === 0) return out
    const parts = files.map((f) => `echo __FILE__${f}; base64 < ${shellQuote(`${dir}/${f}`)}`)
    const output = await bridge.run(parts.join('; '))
    let current: string | null = null
    const chunks: string[] = []
    for (const line of output.split('\n')) {
      if (line.startsWith('__FILE__')) {
        if (current) out[current] = fromBase64(chunks.join(''))
        current = line.slice('__FILE__'.length).trim()
        chunks.length = 0
      } else if (current) {
        chunks.push(line.trim())
      }
    }
    if (current) out[current] = fromBase64(chunks.join(''))
    return out
  }

  async function listTemplates(source: 'library' | 'project', projectPath: string | null): Promise<WfTemplate[]> {
    everUsed = true
    const dir = await workflowsDir(source, projectPath)
    // One bridge command does the whole listing: marker + base64 per yaml file, so a directory
    // of templates costs a single terminal round-trip instead of one per file.
    const listing = await bridge.run(
      `for f in ${shellPath(dir)}/*.yaml; do [ -f "$f" ] || continue; echo "__WF_LS__\${f##*/}"; base64 < "$f"; echo __WF_LE__; done`
    )
    const files: Record<string, string> = {}
    let current: string | null = null
    const chunks: string[] = []
    for (const line of listing.split('\n')) {
      if (line.startsWith('__WF_LS__')) {
        if (current) files[current] = fromBase64(chunks.join(''))
        current = line.slice('__WF_LS__'.length).trim()
        chunks.length = 0
      } else if (line.trim() === '__WF_LE__') {
        if (current) files[current] = fromBase64(chunks.join(''))
        current = null
        chunks.length = 0
      } else if (current !== null) {
        chunks.push(line.trim())
      }
    }
    if (current) files[current] = fromBase64(chunks.join(''))
    const yamlFiles = Object.keys(files)
    if (yamlFiles.length === 0) return []
    const templates: WfTemplate[] = []
    const specFiles: Record<string, string | null> = {}
    for (const file of yamlFiles) {
      const fallbackId = file.replace(/\.workflow\.yaml$|\.yaml$/, '')
      try {
        const parsed = parseTemplate(file, parseYaml(files[file] ?? ''))
        templates.push({
          id: parsed.id,
          title: parsed.title,
          source,
          sourcePath: dir,
          file,
          steps: parsed.steps,
          error: null
        })
        for (const step of parsed.steps) if (parsed.specFiles[step.id]) specFiles[parsed.specFiles[step.id] as string] = null
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
    // Resolve specFile contents in one more round-trip when any template uses them.
    const specDirs = Object.keys(specFiles)
    if (specDirs.length === 0) return templates
    const specs = await readFiles(dir, specDirs)
    for (const template of templates) {
      if (template.error) continue
      template.steps = template.steps.map((step) => {
        const rel = specFilesFor(template, step)
        return rel ? { ...step, spec: specs[rel] ?? step.spec } : step
      })
    }
    return templates
  }

  /** The spec path a step declares (re-parsed from the file we already read; cheap). */
  function specFilesFor(template: WfTemplate, step: WfStep): string | null {
    void template
    return step.specFile
  }

  // ---- specialists (aip-style) -----------------------------------------------------------------

  /** Loads `<repo>/.orca/specialists/*.yaml` and the library's `specialists/` in one batch. */
  async function loadSpecialists(projectPath: string | null, onlyProject = false): Promise<WfSpecialist[]> {
    const dirs: Array<string> = []
    if (projectPath) dirs.push(`${projectPath.replace(/\/+$/, '')}/.orca/specialists`)
    if (!onlyProject) dirs.push((await libraryDir()).replace(/\/workflows$/, '/specialists'))
    const out: WfSpecialist[] = []
    for (const dir of dirs) {
      let listing = ''
      try {
        listing = await bridge.run(
          `for f in ${shellPath(dir)}/*.yaml; do [ -f "$f" ] || continue; echo "__WF_LS__\${f##*/}"; base64 < "$f"; echo __WF_LE__; done`
        )
      } catch {
        continue
      }
      let current: string | null = null
      const chunks: string[] = []
      const flush = (): void => {
        if (current) {
          const slug = current.replace(/\.yaml$/, '')
          try {
            const raw = parseYaml(fromBase64(chunks.join(''))) as { [k: string]: unknown }
            out.push({
              slug,
              agent: String(raw.agent ?? 'claude'),
              model: typeof raw.model === 'string' ? raw.model : null,
              effort: typeof raw.effort === 'string' ? raw.effort : null,
              spec: typeof raw.spec === 'string' ? raw.spec : null,
              error: null
            })
          } catch (error) {
            out.push({ slug, agent: 'claude', model: null, effort: null, spec: null, error: message(error) })
          }
        }
      }
      for (const line of listing.split('\n')) {
        if (line.startsWith('__WF_LS__')) {
          flush()
          current = line.slice('__WF_LS__'.length).trim()
          chunks.length = 0
        } else if (line.trim() === '__WF_LE__') {
          flush()
          current = null
          chunks.length = 0
        } else if (current !== null) {
          chunks.push(line.trim())
        }
      }
      flush()
    }
    return out
  }

  /** Resolves `specialist:` references into agent/model/spec, in steps and sub-children. */
  function resolveSteps(template: WfTemplate, specialists: WfSpecialist[], specs: Record<string, string>): WfStep[] {
    const bySlug = new Map(specialists.map((s) => [s.slug, s]))
    const resolveUnit = (
      specialist: string | null,
      agent: string | null,
      model: string | null,
      effort: string | null,
      spec: string | null,
      specFile: string | null
    ): { agent: string | null; model: string | null; effort: string | null; spec: string | null } => {
      const specOverride = specFile ? (specs[specFile] ?? spec) : spec
      if (!specialist) return { agent, model, effort: model ? effort : null, spec: specOverride ?? spec }
      const sp = bySlug.get(specialist)
      if (!sp) return { agent, model, effort: model ? effort : null, spec: specOverride ?? spec }
      const finalModel = model ?? sp.model
      return {
        agent: agent ?? sp.agent,
        model: finalModel,
        effort: finalModel ? (effort ?? sp.effort) : null,
        spec: specOverride ?? sp.spec
      }
    }
    return template.steps.map((step) => {
      const own = resolveUnit(step.specialist, step.agent, step.model, step.effort, step.spec, step.specFile)
      const sub = (step.sub ?? []).map((child) => ({
        ...child,
        ...resolveUnit(child.specialist, child.agent, child.model, child.effort, child.spec, child.specFile)
      }))
      return { ...step, ...own, sub }
    })
  }

  // ---- instantiate ---------------------------------------------------------------------------------

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
        // Which project this Run belongs to, so the panel can scope its Runs list.
        await orca.storage.set(`runmeta.${run.runId}`, {
          projectPath: input.projectPath,
          templateId: template.id,
          objective: input.objective,
          at: Date.now()
        })
        job.step = 'tasks'
        await saveJob(job, run.runId)
        stepsById = new Map(template.steps.map((s) => [s.id, s]))
        // Resolve specialists into the steps, then flatten blocks into task units.
        const specialists = await loadSpecialists(input.projectPath)
        const specPaths = new Set<string>()
        for (const step of template.steps) {
          if (step.specFile) specPaths.add(step.specFile)
          for (const child of step.sub ?? []) if (child.specFile) specPaths.add(child.specFile)
        }
        const dir = await workflowsDir(input.source, input.projectPath)
        const specs = specPaths.size > 0 ? await readFiles(dir, [...specPaths]) : {}
        const resolved = resolveSteps(template, specialists, specs)
        const { units, blockWatches } = materialize(resolved)
        const taskOf = new Map<string, string>()
        for (const unit of topoUnits(units)) {
          if (!unit.agent) continue
          const spec = applyPlaceholders(unit.spec ?? '', vars)
          const title = applyPlaceholders(unit.title ?? unit.id, vars)
          const specFile = `/tmp/wfv-${job.id}-${unit.id}.md`
          await bridge.run(`printf %s ${shellQuote(toBase64(spec))} | base64 -d > ${specFile}`)
          const deps = unit.deps.map((d) => taskOf.get(d)).filter((d): d is string => Boolean(d))
          const depsFlag = deps.length > 0 ? ` --deps ${shellQuote(JSON.stringify(deps))}` : ''
          const task = await cli<{ taskId: string; id?: string }>(
            `orca orchestration task-create ${from} --run ${shellQuote(run.runId)} --task-title ${shellQuote(
              `${unit.id} ${title}`
            )} --spec-file ${specFile}${depsFlag} --json`
          )
          taskOf.set(unit.id, String(task.taskId ?? task.id ?? ''))
          job.step = `task ${unit.id}`
          await saveJob(job)
          if (unit.gate) {
            await bridge.run(
              `orca orchestration gate-create ${from} --task ${shellQuote(
                taskOf.get(unit.id) as string
              )} --question ${shellQuote(applyPlaceholders(unit.gate.question, vars))} --options ${shellQuote(
                JSON.stringify(unit.gate.options)
              )} --json`
            )
          }
        }
        job.step = 'done'
        job.status = 'done'
        await saveJob(job)
        // Auto-pilot bookkeeping: per-task step configs, review retry pairs, optional subs.
        const autoTasks: Record<string, { stepId: string; agent: string; model: string | null; effort: string | null }> = {}
        for (const unit of units) {
          const taskId = taskOf.get(unit.id)
          if (!taskId || !unit.agent) continue
          autoTasks[taskId] = {
            stepId: unit.id,
            agent: unit.agent,
            model: unit.model,
            effort: unit.model ? unit.effort : null
          }
        }
        // aip semantics: on_reject on a review unit sends the work back to on_reject.goto.
        const autoReviews: Record<
          string,
          { devTaskId: string; devStepId: string; maxRounds: number; source: 'verdict' | 'failure' }
        > = {}
        for (const unit of units) {
          if (!unit.onReject) continue
          const reviewTaskId = taskOf.get(unit.id)
          const devTaskId = taskOf.get(unit.onReject.goto)
          if (reviewTaskId && devTaskId) {
            autoReviews[reviewTaskId] = {
              devTaskId,
              devStepId: unit.onReject.goto,
              maxRounds: unit.onReject.maxRounds,
              source: 'verdict'
            }
          }
        }
        // A parentless block with on_reject: any watched child failing counts as rejection.
        const stepIdToTask = new Map<string, string>()
        for (const unit of units) {
          const t = taskOf.get(unit.id)
          if (t) stepIdToTask.set(unit.id, t)
        }
        for (const watch of blockWatches) {
          const devTaskId = stepIdToTask.get(watch.goto)
          if (!devTaskId) continue
          for (const childId of watch.children) {
            const childTask = stepIdToTask.get(childId)
            if (childTask) {
              autoReviews[childTask] = { devTaskId, devStepId: watch.goto, maxRounds: watch.maxRounds, source: 'failure' }
            }
          }
        }
        // Optional sub-steps: started on a RUN: <id> request from the parent's report.
        const autoOptionals: Record<string, { parentTaskId: string; stepId: string }> = {}
        for (const unit of units) {
          if (!unit.optional) continue
          const parentTaskId = stepIdToTask.get(unit.stepId)
          const ownTaskId = taskOf.get(unit.id)
          if (parentTaskId && ownTaskId) autoOptionals[ownTaskId] = { parentTaskId, stepId: unit.id }
        }
        await orca.storage.set(`auto.${run.runId}`, {
          worktreeName: input.worktreeName,
          repoPath: input.projectPath,
          baseBranch: input.baseBranch,
          firstStarted: false,
          tasks: autoTasks,
          reviews: autoReviews,
          optionals: autoOptionals,
          verdicts: {},
          rounds: {},
          actions: 0,
          stopped: null
        })
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
        // Honest staleness: the bridge failed, so say so instead of passing cache off as live.
        return { ...(cached as WfSnapshot), at: Date.now(), error: `мост недоступен (${message(error)}) — показан последний снимок` }
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

  orca.panels.handle('project.current', async () => {
    everUsed = true
    // The focused workspace's terminal carries a worktreeId of "repoId::repoPath", which names
    // the project directly. One bridge command prints both mappings at once.
    const context = await orca.host.call('workspace.readContext', undefined)
    const terminalId = context?.terminals?.[0]?.id
    if (!terminalId) return { project: null }
    const combined = await bridge.run(
      `echo __WFC__; orca terminal list --json; echo __WFR__; orca repo list --json; echo __WFE__`
    )
    const lines = combined.split('\n')
    const between = (from: string, to: string): string => {
      const start = lines.indexOf(from)
      const end = lines.indexOf(to, start + 1)
      return start >= 0 && end > start ? lines.slice(start + 1, end).join('\n') : ''
    }
    const terminalJson = between('__WFC__', '__WFR__')
    const repoJson = between('__WFR__', '__WFE__')
    if (!terminalJson) return { project: null }
    let worktreeId = ''
    try {
      const listing = JSON.parse(extractJson(terminalJson)) as { result?: { terminals?: Array<{ handle?: string; worktreeId?: string }> } }
      const entry = (listing.result?.terminals ?? []).find((t) => t.handle === terminalId)
      worktreeId = entry?.worktreeId ?? ''
    } catch {
      return { project: null }
    }
    const repoId = worktreeId.split('::')[0]
    if (!repoId) return { project: null }
    try {
      const repos = JSON.parse(extractJson(repoJson)) as { result?: { repos?: Array<{ id?: string; displayName?: string; path?: string }> } }
      const repo = (repos.result?.repos ?? []).find((r) => r.id === repoId)
      if (!repo) return { project: null }
      return { project: { repoId, name: repo.displayName ?? '', path: repo.path ?? '' } }
    } catch {
      return { project: null }
    }
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

  orca.panels.handle('template.edit', async ({ projectPath, templateId }) => {
    everUsed = true
    const templates = await listTemplates('project', projectPath)
    const template = templates.find((t) => t.id === templateId)
    if (!template) throw new BridgeError(`шаблон "${templateId}" не найден`, 'cli_error')
    const filePath = `${template.sourcePath}/${template.file}`
    const list = await orca.host.call('workspace.list', undefined)
    // The project's main checkout is the workspace that owns the workflows directory.
    const home = list.workspaces.find((w) => w.path === projectPath)
    if (!home) {
      throw new BridgeError(
        `у проекта "${projectPath}" нет открытого воркспейса с корнем репозитория — открой файл вручную: ${filePath}`,
        'no_terminal'
      )
    }
    // editor.open takes a path relative to the workspace root.
    await orca.host.call('editor.open', { workspaceId: home.id, path: filePath.slice(projectPath.length + 1) })
    return { opened: true as const }
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

  orca.panels.handle('run.meta.set', async ({ runId, projectPath }) => {
    everUsed = true
    await orca.storage.set(`runmeta.${runId}`, { projectPath, at: Date.now() })
    void refresh()
    return { ok: true as const }
  })

  orca.panels.handle('specialists.list', async ({ projectPath }) => {
    everUsed = true
    return { specialists: await loadSpecialists(projectPath, true) }
  })

  orca.panels.handle('specialists.save', async ({ projectPath, slug, agent, model, effort, spec }) => {
    everUsed = true
    const clean = slug.trim().replace(/[^a-z0-9-]/g, '-')
    if (clean === '') throw new BridgeError('slug специалиста не может быть пустым', 'cli_error')
    const dir = `${projectPath.replace(/\/+$/, '')}/.orca/specialists`
    const yaml = [
      `agent: ${agent.trim() || 'claude'}`,
      model && model.trim() !== '' ? `model: ${model.trim()}` : null,
      effort && effort.trim() !== '' ? `effort: ${effort.trim()}` : null,
      spec.trim() !== '' ? `spec: |\n${spec.replace(/\n$/, '').split('\n').map((l) => '  ' + l).join('\n')}` : null
    ].filter((x): x is string => x !== null).join('\n') + '\n'
    await bridge.run(
      `mkdir -p ${shellPath(dir)} && echo ${shellQuote(toBase64(yaml))} | base64 -d > ${shellPath(`${dir}/${clean}.yaml`)}`
    )
    return { ok: true as const }
  })

  orca.panels.handle('specialists.delete', async ({ projectPath, slug }) => {
    everUsed = true
    // Refuse while any project template still references the specialist.
    const wfDir = `${projectPath.replace(/\/+$/, '')}/.orca/workflows`
    let listing = ''
    try {
      listing = await bridge.run(`ls -1 ${shellPath(wfDir)} 2>/dev/null || true`)
    } catch {
      listing = ''
    }
    for (const file of listing.split('\n').map((l) => l.trim()).filter(Boolean)) {
      let raw = ''
      try {
        raw = fromBase64(await bridge.run(`base64 < ${shellPath(`${wfDir}/${file}`)}`))
      } catch {
        continue
      }
      try {
        const template = parseTemplate(file.replace(/\.yaml$/, ''), parseYaml(raw))
        const uses = [...template.steps, ...template.steps.flatMap((st) => st.sub ?? [])]
          .some((st) => st.specialist === slug)
        if (uses) throw new BridgeError(`специалиста «${slug}» использует шаблон ${file} — сначала убери его из шаблона`, 'cli_error')
      } catch (error) {
        if (error instanceof BridgeError) throw error
      }
    }
    await bridge.run(`rm -f ${shellPath(`${projectPath.replace(/\/+$/, '')}/.orca/specialists/${slug}.yaml`)}`)
    return { ok: true as const }
  })

  orca.panels.handle('ui.set', async ({ key, value }) => {
    everUsed = true
    if (!key.startsWith('html.')) throw new BridgeError('ui.set пишет только ключи html.*', 'cli_error')
    await orca.storage.set(key, value)
    return { ok: true as const }
  })

  orca.panels.handle('run.agents.set', async ({ runId, agents }) => {
    everUsed = true
    await orca.storage.set(`agents.${runId}`, agents)
    void refresh()
    return { ok: true as const }
  })

  orca.panels.handle('bridge.reset', async () => {
    await bridge.reset()
    return { ok: true as const }
  })

  orca.panels.handle('bridge.info', async () => {
    everUsed = true
    const terminalId = bridge.current() ?? (await bridge.ensure().catch(() => null))
    return { terminalId }
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
