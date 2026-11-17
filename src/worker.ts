// The plugin's worker: the CLI bridge, orchestration snapshot, gate/task management and
// template materialization. Runs for as long as the plugin is enabled (it owns a status
// bar item), polls a light refresh, and pushes 'state.changed' to open panels.
import { Bridge, BridgeError, expandHome, shellPath, sleep } from './bridge'
import type { WfGate, WfJob, WfRun, WfSnapshot, WfSpecialist, WfStep, WfTask, WfTemplate, WfWorker } from './protocol'
import { applyPlaceholders, materialize, parseTemplate, rechecksDue, topoUnits } from './workflow'
import { parseYaml, type YamlValue } from './yaml'
import { homedir } from 'node:os'
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
let activeBridge: Bridge | null = null

/** Test seam: the agent boot wait before verifying the coordinator terminal. */
export const coordLaunch = { bootWaitMs: 8_000 }

export default function activate(orca: OrcaWorkerApi): void {
  const bridge = new Bridge(orca)
  activeBridge = bridge
  let everUsed = false
  let refreshing = false
  let lastSnapshot = ''
  stopTimer = null

  // ---- bridge helpers -------------------------------------------------------------------------

  async function cli<T>(command: string, timeoutMs?: number): Promise<T> {
    const envelope = await bridge.json<Envelope<T>>(command, timeoutMs)
    if (envelope && envelope.ok === true) return envelope.result
    throw new BridgeError(
      (envelope && envelope.error && envelope.error.message) || `команда не удалась: ${command.slice(0, 120)}`,
      'cli_error'
    )
  }

  // ---- snapshot --------------------------------------------------------------------------------

  /** Storage reads on the request path are raced: a hung storage call must not take the
   *  request (and the bridge queue behind it) down with it. */
  function storageGet<T>(key: string): Promise<T | null> {
    return Promise.race([
      orca.storage.get(key).catch(() => null),
      sleep(3_000).then(() => null)
    ]) as Promise<T | null>
  }

  async function listRuns(): Promise<WfRun[]> {
    const result = await cli<{ runs?: unknown } | unknown[]>('orca orchestration run-list --limit 20 --json')
    const rows: Record<string, unknown>[] = Array.isArray(result)
      ? (result as Record<string, unknown>[])
      : asArray<Record<string, unknown>>(result.runs)
    const out: WfRun[] = []
    for (const row of rows) {
      const runId = String(field(row, 'runId', 'id') ?? '')
      let projectPath: string | null = null
      let worktreePath: string | null = null
      try {
        const meta = await storageGet<{ projectPath?: unknown; worktreePath?: unknown }>(`runmeta.${runId}`)
        if (meta && typeof meta === 'object') {
          const wp = meta.worktreePath
          if (typeof wp === 'string' && wp !== '') worktreePath = wp
        }
        if (meta && typeof meta === 'object') {
          const path = meta.projectPath
          if (typeof path === 'string' && path !== '') projectPath = path
        }
        // AutoState knows the run's own worktree even when runmeta already carried the project.
        const auto = await storageGet<{ repoPath?: unknown; worktreeName?: unknown; worktreePath?: unknown }>(`auto.${runId}`)
        if (auto && typeof auto === 'object') {
          const path = auto.repoPath
          if (!projectPath && typeof path === 'string' && path !== '') projectPath = path
          if (typeof auto.worktreePath === 'string' && auto.worktreePath !== '') worktreePath = auto.worktreePath
          else if (worktreePath === null && typeof auto.worktreeName === 'string' && typeof path === 'string' && path !== '') {
            worktreePath = `${homedir()}/orca/workspaces/${path.split('/').filter(Boolean).pop()}/${auto.worktreeName}`
          }
        }
      } catch {
        // metadata is an extra; the run still lists without a project
      }
      out.push({ runId, objective: String(field(row, 'objective') ?? ''), projectPath, worktreePath })
    }
    return out
  }

  async function snapshot(runId: string | null): Promise<WfSnapshot> {
    const at = Date.now()
    const runs = await listRuns()
    if (!runId) {
      return { at, run: null, tasks: [], gates: [], workers: [], error: null, pilot: null }
    }
    const run = runs.find((r) => r.runId === runId) ?? (runId ? { runId, objective: '', projectPath: null } : null)
    const [taskRows, readyRows, gateRows, workerRows] = await Promise.all([
      cli<{ tasks?: unknown }>(`orca orchestration task-list --run ${shellQuote(runId)} --json`),
      cli<{ tasks?: unknown }>(`orca orchestration task-list --run ${shellQuote(runId)} --ready --brief --json`),
      cli<{ gates?: unknown }>(`orca orchestration gate-list --run ${shellQuote(runId)} --full --json`),
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
        order: null,
        optional: false,
        parallel: null,
        expectsVerdict: false,
        dispatchId: dispatch,
        agent: null,
        model: null,
        fallback: [],
        parentTaskId: null
      }
    })
    // Template config from instantiate: agent and model per task, when we raised the run.
    const autoStored = await orca.storage.get(`auto.${runId}`)
    if (autoStored && typeof autoStored === 'object') {
      const autoData = (autoStored as {
        tasks?: Record<string, { agent?: string; model?: string | null; fallback?: string[] }>
        children?: Record<string, string>
        optionals?: Record<string, { parentTaskId: string }>
      }) ?? {}
      const autoTasks = autoData.tasks ?? {}
      for (const task of tasks) {
        const cfg = autoTasks[task.id]
        if (cfg) {
          task.agent = cfg.agent ?? task.agent
          task.model = cfg.model ?? null
          task.fallback = cfg.fallback ?? []
          task.order = typeof cfg.order === 'number' ? cfg.order : null
        }
        task.parentTaskId = autoData.children?.[task.id] ?? autoData.optionals?.[task.id]?.parentTaskId ?? null
        if (autoData.optionals?.[task.id]) task.optional = true
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
      const taskId = String(field(row, 'taskId', 'task_id') ?? '')
      const rawResolution = field(row, 'resolution')
      return {
        id: String(field(row, 'id') ?? ''),
        taskId,
        taskTitle: tasks.find((t) => t.id === taskId)?.title ?? taskId,
        question: String(field(row, 'question') ?? ''),
        options: stringList(field(row, 'options')),
        status: String(field(row, 'status') ?? 'pending') === 'resolved' ? 'resolved' : 'pending',
        resolution: typeof rawResolution === 'string' && rawResolution !== '' ? rawResolution : null
      }
    })
    const workersRaw = asArray<Record<string, unknown>>(workerRows.workers ?? workerRows.dispatches)
    const workers: WfWorker[] = []
    const unresolved = new Set<string>()
    for (const row of workersRaw) {
      const dispatchId = String(field(row, 'dispatchId', 'id') ?? '')
      // verdict3 — третья редакция ключа: в первой вердикт без строки VERDICT молча
      // дефолтился в approve; во вторую чтение по dispatchId без taskId затирало
      // подтверждённое значение дефолтом. Смена ключа самовосстанавливает бейджи
      // живых ранов (фоновый проход перечитает отчёты); 'none' = вердикт не
      // определился — нейтральная точка, без повторных чтений.
      const stored = await storageGet<'approve' | 'request-changes' | 'none'>(`verdict3.${dispatchId}`)
      if (stored === 'none') unresolved.add(dispatchId)
      workers.push({
        dispatchId,
        taskId: String(field(row, 'taskId') ?? '') || null,
        taskTitle: tasks.find((t) => t.id === String(field(row, 'taskId') ?? ''))?.title ?? null,
        state: String(field(row, 'state', 'status') ?? '?'),
        verdict: stored && stored !== 'none' ? stored : null
      })
    }
    // Свежезавершённая попытка без вердикта: один фоновый проход — прочитать отчёт и
    // сохранить (write-through в readWorkerReport), затем панель увидит его в снимке.
    for (const w of workers) {
      if (w.state === 'succeeded' && w.verdict === null && !unresolved.has(w.dispatchId) && !verdictFilling.has(w.dispatchId)) {
        verdictFilling.add(w.dispatchId)
        void readWorkerReport(w.dispatchId, w.taskId)
          .catch(() => undefined)
          .finally(() => { verdictFilling.delete(w.dispatchId); wakeSoon() })
      }
    }
    // Попытки шага — в порядке создания. worker-list отдаёт диспетчеры свежими первыми,
    // а панель нумерует попытки по индексу: без сортировки реран становится «попыткой №1».
    // Времени в строках CLI нет — берём created_at из orchestration.db (один запрос на ран);
    // неизвестные id держат относительный порядок CLI (хвост сравнения).
    try {
      const db = `${homedir()}/Library/Application Support/orca/orchestration.db`
      const out = await bridge.run(
        `sqlite3 ${shellQuote(db)} "SELECT id, created_at FROM dispatch_contexts WHERE run_id = '${runId.replace(/'/g, '')}';"`
      )
      const createdAt = new Map<string, string>()
      for (const line of out.split('\n')) {
        const bar = line.indexOf('|')
        if (bar > 0) createdAt.set(line.slice(0, bar).trim(), line.slice(bar + 1).trim())
      }
      if (createdAt.size > 0) {
        const cliIndex = new Map(workers.map((w, i) => [w.dispatchId, i]))
        workers.sort(
          (a, b) =>
            (createdAt.get(a.dispatchId) ?? '9999').localeCompare(createdAt.get(b.dispatchId) ?? '9999') ||
            (cliIndex.get(a.dispatchId) ?? 0) - (cliIndex.get(b.dispatchId) ?? 0)
        )
      }
    } catch {
      // порядок останется как отдал CLI — попытки покажутся свежими первыми, но не сломается
    }
    const pilotState = await loadAuto(runId)
    // Шаги-ревью юниты должны вердиктить: их успешная попытка без VERDICT — нейтральная
    // точка, а не зелёная галочка. У остальных воркеров (планировщик, ресерчеры) успеха
    // самого по себе достаточно — им галочка положена.
    const reviewTasks = new Set(Object.keys(pilotState?.reviews ?? {}))
    for (const task of tasks) if (reviewTasks.has(task.id)) task.expectsVerdict = true
    const autoPilotOn = true // легаси-раны (driver=autopilot) ведутся всегда; новые — координатором
    const pilot = pilotState
      ? {
          on: pilotState.driver === 'coordinator' ? true : autoPilotOn && !pilotState.stopped,
          stopped: pilotState.stopped ?? null,
          actions: pilotState.actions,
          driver: pilotState.driver ?? 'autopilot',
          coordinatorTerminal: pilotState.coordinatorTerminal ?? null
        }
      : null
    return { at, run, tasks: orderTasks(tasks), gates, workers, error: null, pilot }
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
      const storedRun = (await orca.storage.get('html.runId')) ?? (await orca.storage.get('state.selectedRunId'))
      const runId = typeof storedRun === 'string' && storedRun !== '' ? storedRun : null
      let snap: WfSnapshot
      try {
        snap = await snapshot(runId)
      } catch (error) {
        snap = { at: Date.now(), run: null, tasks: [], gates: [], workers: [], error: message(error), pilot: null }
      }
      // `at` changes every snapshot; compare the payload so quiet runs stay quiet
      // (otherwise panel and worker ping-pong state.changed forever).
      const serialized = JSON.stringify({ ...snap, at: 0 })
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
    tasks: Record<string, { stepId: string; agent: string; model: string | null; effort: string | null; fallback: string[] }>
    /** Agents already tried per task, the failover chain's position. */
    triedAgents: Record<string, string[]>
    /** Sub-step tasks -> their owning block task, for nested display. */
    children: Record<string, string>
    /** 'coordinator' — a live agent session drives this run; the code autopilot stays off. */
    driver: 'coordinator' | 'autopilot' | null
    /** The coordinator agent's terminal, when driver is 'coordinator'. */
    coordinatorTerminal: string | null
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

  let piloting = false
  async function autopilot(runId: string, snap: WfSnapshot): Promise<void> {
    const autopilotOn = await orca.settings.get('autoPilot')
    if (autopilotOn === false || piloting) return
    const state = await loadAuto(runId)
    if (!state || state.stopped) return
    if (state.driver === 'coordinator') return // a live agent session leads this run
    piloting = true
    try {
      await driveAutopilot(runId, snap, state)
    } finally {
      piloting = false
    }
  }

  async function driveAutopilot(runId: string, snap: WfSnapshot, state: NonNullable<Awaited<ReturnType<typeof loadAuto>>>): Promise<void> {
    {
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    let acted = false
    const act = async (what: string, fn: () => Promise<unknown>): Promise<void> => {
      if (acted) return
      acted = true
      state.actions += 1
      orca.log(`autopilot[${runId}]: ${what}`)
      try {
        try {
          await fn()
        } catch (error) {
          // The bridge terminal was recreated since the run began: rebind it as the run's
          // coordinator and retry the mutation once.
          if (!message(error).includes('consumer_fenced')) throw error
          orca.log(`autopilot[${runId}]: перепривязка моста к рану (run-use)`)
          await bridge.run(`orca orchestration run-use --id ${shellQuote(runId)} --json`)
          await fn()
        }
      } catch (error) {
        const text = message(error)
        if (/task_not_startable/.test(text)) {
          // Another driver (a panel view, a parallel tick) already started it: success.
          await saveAuto(runId, state)
          return
        }
        if (/selector_not_found/.test(text)) {
          // The named worktree is missing (its creation was the attempt that failed earlier):
          // transient — recreate the worktree on the next tick instead of stopping the run.
          state.firstStarted = false
          await saveAuto(runId, state)
          return
        }
        state.stopped = `ошибка: ${text}`
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
      let worktree = `name:${state.worktreeName}`
      if (!state.firstStarted) {
        state.firstStarted = true
        const repoFlag = state.repoPath ? ` --repo path:${shellQuote(state.repoPath)}` : ''
        const baseFlag = state.baseBranch ? ` --base-branch ${shellQuote(state.baseBranch)}` : ''
        await act(`старт ${cfg.stepId} (new worktree ${state.worktreeName})`, async () =>
          bridge.run(
            `orca orchestration worker-start --task ${shellQuote(task.id)} --worktree new-top-level${repoFlag}${baseFlag} --name ${shellQuote(
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
          `orca orchestration worker-start --task ${shellQuote(task.id)} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(cfg.agent)}${cfg.model ? ` --model ${shellQuote(cfg.model)}` : ''}${
            cfg.model && cfg.effort ? ` --effort ${shellQuote(cfg.effort)}` : ''
          } --json`,
          90_000
        )
      )
    }
    if (acted) return

    // A finished task loses its dispatchId in the concise task list; the run's worker
    // list still remembers it — verdicts and RUN: probes need that dispatch.
    const dispatchOf = (taskId: string): string | null => {
      const task = byId.get(taskId)
      if (task?.dispatchId) return task.dispatchId
      const row = snap.workers.find((w) => w.taskId === taskId)
      return row?.dispatchId ?? null
    }

    // 2. Freshly succeeded review units: parse the verdict once, then act.
    for (const task of snap.tasks) {
      if (acted) break
      if (task.status !== 'succeeded') continue
      const review = state.reviews[task.id]
      if (!review || state.verdicts[task.id]) continue
      const reviewDispatch = dispatchOf(task.id)
      if (!reviewDispatch) continue
      const report = await readWorkerReport(reviewDispatch, task.id)
      let verdict = parseVerdict(report)
      if (!hasVerdictLine(report)) {
        const fromInbox = await verdictFromInbox(task.id)
        if (fromInbox) verdict = fromInbox
      }
      state.verdicts[task.id] = verdict
      if (verdict === 'request-changes') {
        const devTask = byId.get(review.devTaskId)
        if (devTask && devTask.status !== 'succeeded') {
          // Another rejecting check already sent the work back: fold into the same round —
          // forward the remarks to the live dev dispatch; the re-check pass re-runs this
          // check after the rework instead of burning a second round on it.
          const cfg = state.tasks[task.id]
          const devDispatch = dispatchOf(review.devTaskId)
          if (devDispatch) {
            await bridge
              .run(
                `orca orchestration send --to dispatch:${devDispatch} --subject "Замечания проверки ${cfg?.stepId ?? task.id}" --body ${shellQuote(
                  extractRemarks(report)
                )} --json`
              )
              .catch(() => undefined)
          }
          await saveAuto(runId, state)
          continue
        }
        const round = (state.rounds[review.devTaskId] ?? 0) + 1
        state.rounds[review.devTaskId] = round
        if (round > review.maxRounds) {
          state.stopped = `ревью отклонило работу ${review.maxRounds} раз — конвейер остановлен`
          await saveAuto(runId, state)
          return
        }
        const devCfg = state.tasks[review.devTaskId]
        await act(`перезапуск ${review.devStepId} (раунд ${round}/${review.maxRounds})`, async () => {
          delete state.verdicts[review.devTaskId]
          const devDispatch = dispatchOf(review.devTaskId)
          if (devDispatch) {
            await bridge.run(
              `orca orchestration send --to dispatch:${devDispatch} --subject "Замечания ревью (раунд ${round})" --body ${shellQuote(
                extractRemarks(report)
              )} --json`
            )
          }
          return bridge.run(
            `orca orchestration worker-start --task ${shellQuote(review.devTaskId)} --worktree ${shellQuote(
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

    // 3. After a reworked dev task completes, re-run the checks that rejected it — the
    //    reviewer of a parented step and the children of a check container alike (a stale
    //    green must not wave the block through; a failed check gets its re-run here too).
    //    One per tick; the mark clears once nothing is due.
    for (const mark of Object.keys(state.rounds)) {
      if (acted) break
      if (!mark.startsWith('__retry_review_')) continue
      const devTaskId = mark.slice('__retry_review_'.length)
      const devTask = byId.get(devTaskId)
      if (!devTask || devTask.status !== 'succeeded') continue
      const statuses: Record<string, string> = {}
      for (const [id, t] of byId) statuses[id] = t.status
      const due = rechecksDue(state.reviews, statuses, state.verdicts, devTaskId)
      if (due.length === 0) {
        delete state.rounds[mark]
        await saveAuto(runId, state)
        continue
      }
      const taskId = due[0]
      const cfg = state.tasks[taskId]
      await act(`перепроверка после правок (${cfg?.stepId ?? taskId})`, async () => {
        // The fresh report must re-enter loop 2 — drop the cached verdict of the old attempt.
        delete state.verdicts[taskId]
        return bridge.run(
          `orca orchestration worker-start --task ${shellQuote(taskId)} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(cfg?.agent ?? 'claude')} --json`,
          90_000
        )
      })
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
      await act(`подшаг упал — перезапуск ${review.devStepId} (${round}/${review.maxRounds})`, async () => {
        delete state.verdicts[review.devTaskId]
        return bridge.run(
          `orca orchestration worker-start --task ${shellQuote(review.devTaskId)} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(devCfg?.agent ?? 'claude')} --json`,
          90_000
        )
      })
      if (acted) return
      // The failed check re-runs after the rework (loop 3), not by failover alone.
      state.rounds[`__retry_review_${review.devTaskId}`] = 1
      await saveAuto(runId, state)
      return
    }
    if (acted) return

    // 5. A failed task with an unused fallback agent: restart it on the next one.
    for (const task of snap.tasks) {
      if (acted) break
      if (task.status !== 'failed') continue
      const cfg = state.tasks[task.id]
      if (!cfg) continue
      state.triedAgents ??= {}
      const tried = state.triedAgents[task.id] ?? [cfg.agent]
      const chain = [cfg.agent, ...(cfg.fallback ?? [])]
      const next = chain.find((a) => a && !tried.includes(a))
      if (!next) continue // chain exhausted — the failure stays for the person to see
      tried.push(next)
      state.triedAgents[task.id] = tried
      await act(`шаг ${cfg.stepId} упал на ${tried[tried.length - 2]} — фейловер на ${next}`, async () => {
        // The failover attempt gets a clean verdict slot: its fresh report must re-enter loop 2.
        delete state.verdicts[task.id]
        return bridge.run(
          `orca orchestration worker-start --task ${shellQuote(task.id)} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(next)}${cfg.model ? ` --model ${shellQuote(cfg.model)}` : ''}${
            cfg.model && cfg.effort ? ` --effort ${shellQuote(cfg.effort)}` : ''
          } --json`,
          90_000
        )
      })
    }
    if (acted) return

    // 6. RUN: <sub-step-id> requests in succeeded parent reports start optional sub-steps.
    for (const [optionalTaskId, link] of Object.entries(state.optionals)) {
      if (acted) break
      if (byId.get(optionalTaskId)?.status && byId.get(optionalTaskId)?.status !== 'pending') continue
      if (state.rounds[`__opt_started_${optionalTaskId}`]) continue
      const parent = byId.get(link.parentTaskId)
      if (!parent || parent.status !== 'succeeded') continue
      const parentDispatch = dispatchOf(link.parentTaskId)
      if (!parentDispatch) continue
      const report = await readWorkerReport(parentDispatch, link.parentTaskId)
      const wants = new RegExp(`RUN:\\s*${link.stepId}\\b`).test(report)
      if (!wants) continue
      state.rounds[`__opt_started_${optionalTaskId}`] = 1
      const cfg = state.tasks[optionalTaskId]
      await act(`опциональный подшаг ${link.stepId} по запросу из отчёта`, async () =>
        bridge.run(
          `orca orchestration worker-start --task ${shellQuote(optionalTaskId)} --worktree ${shellQuote(
            `name:${state.worktreeName}`
          )} --agent ${shellQuote(cfg?.agent ?? 'claude')} --json`,
          90_000
        )
      )
    }
    void runId
    }
  }

  /** Bounded worker report text: the assistant's spoken text from the dispatch transcript
   *  (worker-read answers {transcript:{messages:[{role,blocks:[{type,text}]}]}}); the old
   *  flat rows[] shape stays as a fallback. */
  async function readWorkerReport(dispatchId: string, taskId?: string | null): Promise<string> {
    try {
      const out = await bridge.run(
        `orca orchestration worker-read --dispatch ${shellQuote(dispatchId)} --limit 200 --json`,
        15_000
      )
      const parsed = JSON.parse(extractJson(out)) as {
        result?: {
          rows?: Array<{ text?: string }>
          transcript?: { messages?: Array<{ role?: string; blocks?: Array<{ type?: string; text?: string }> }> }
        }
      }
      const spoken = (parsed.result?.transcript?.messages ?? [])
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => (m.blocks ?? []).filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string))
        .join('\n\n')
      if (spoken.trim() !== '') {
        // Вердикт попытки парсится один раз и хранится; панель не перечитывает отчёт.
        // Пишем только УВЕРЕННОЕ значение: явная строка в теле, иначе сабджект done-сообщения
        // (ревьюеры иногда оставляют вердикт только там). Ничего не нашли — сентинел 'none':
        // бейдж покажет нейтральную точку, а не врущий зелёный; движок дефолтит approve сам.
        // taskId === undefined (чтение по одному dispatchId) — вообще не пишем: нечем
        // подтвердить вердикт, перезапись затёрла бы уже сохранённый.
        if (taskId !== undefined) {
          let verdict: 'approve' | 'request-changes' | 'none'
          if (hasVerdictLine(spoken)) verdict = parseVerdict(spoken)
          else if (taskId) {
            const fromInbox = await verdictFromInbox(taskId)
            verdict = fromInbox ?? 'none'
          } else verdict = 'none'
          void orca.storage.set(`verdict3.${dispatchId}`, verdict).catch(() => undefined)
        }
        return spoken.slice(-8000)
      }
      return (parsed.result?.rows ?? []).map((r) => r.text ?? '').join('\n')
    } catch {
      return ''
    }
  }

  /** The coordinator agent's brief: the objective, the whole flow and the ground rules. */
  function coordinatorBrief(
    runId: string,
    template: WfTemplate,
    objective: string,
    worktreeName: string,
    projectPath: string | null
  ): string {
    const flow = template.steps
      .map((step, i) => {
        const who = step.specialist
          ? `воркер ${step.specialist}`
          : step.agent
            ? `агент ${step.agent}`
            : (step.sub?.length ?? 0) > 0
              ? 'контейнер проверок (своего воркера нет)'
              : 'барьер'
        const extra = [
          step.agent ? `агент-алиас для worker-start: ${step.agent}` : null,
          step.model ? `модель ${step.model}` : null,
          step.model && step.effort ? `effort ${step.effort}` : null,
          step.parallel ? `ОДНОВРЕМЕННО не более ${step.parallel}` : null,
          (step.fallback ?? []).length > 0 ? `fallback: ${step.fallback.join(' → ')}` : null,
          step.gate ? `ГЕЙТ ПОСЛЕ этого шага (подтверждает его результат): ${step.gate.question} — стоп для человека, ответ двигает флоу дальше` : null,
          step.onReject ? `on_reject → ${step.onReject.goto} (≤${step.onReject.maxRounds})` : null
        ].filter(Boolean)
        const phaseText = (phase: string | undefined, optional: boolean, stepId: string, hasWorker: boolean): string => {
          const p = phase ?? (optional ? 'after_end' : 'before_end')
          if (!hasWorker) {
            // Контейнер проверок: фазы отсчитываются не от воркера, а от соседей по блоку.
            if (optional) return ' (optional: реши сам по сути диффа; не нужен — пропусти и не жди)'
            return p === 'after_end'
              ? ` (добивочная проверка блока «${stepId}»: стартуй после основных проверок, ход конвейера не держит)`
              : ` (проверка блока «${stepId}»: стартуй по готовности вместе с соседями; итог блока — отчёты всех запущенных проверок)`
          }
          if (optional) {
            return ` (optional, ${p === 'before_start' ? `ДО старта воркера шага «${stepId}»` : p === 'parallel' ? `ПАРАЛЛЕЛЬНО воркеру шага «${stepId}»` : p === 'before_end' ? `после РАБОТЫ воркера «${stepId}», до потребления его отчёта` : `ПОСЛЕ отчёта шага «${stepId}»`}: реши сам по сути задачи; не нужен — пропусти)`
          }
          return p === 'before_start' ? ` (готовит шаг «${stepId}»: проходит ДО старта его воркера, шаг ждёт его)`
            : p === 'parallel' ? ` (ПАРАЛЛЕЛЬНО воркеру шага «${stepId}», не с соседними: стартуй их одновременно, когда зависимости позволяют; итог шага — ОБА отчёта; request-changes в любом — цикл доработки)`
              : p === 'before_end' ? ` (ПОСЛЕ работы воркера «${stepId}», ДО потребления его отчёта: сначала воркер завершает работу, затем этот подшаг проверяет/дополняет, и только потом считай отчёт шага финальным и иди дальше)`
                : ` (после отчёта шага «${stepId}»: стартуй по RUN: из отчёта или сам)`
        }
        const subs = (step.sub ?? []).map((c) =>
          `      • ${c.id} — ${c.specialist ?? c.agent}${phaseText(c.phase, c.optional === true, step.id, Boolean(step.specialist || step.agent))}`
        )
        return `${i + 1}. ${step.id} (${who}${extra.length > 0 ? '; ' + extra.join('; ') : ''})` + (subs.length > 0 ? '\n' + subs.join('\n') : '')
      })
      .join('\n')
    const trimmed = objective.trim()
    const kickoff = [
      trimmed === ''
        ? 'Заголовок от человека: не задан.'
        : `Заголовок от человека (не постановка, только имя задачи): «${trimmed}».`,
      'ТВОЙ ПЕРВЫЙ ХОД — ВСЕГДА уточнение, даже при полном заголовке. Одним сообщением в этом чате:',
      '1) перескажи своё понимание (цель, описание);',
      '2) задай вопросы по пробелам: что именно делаем, зачем/для кого, границы (что НЕ делаем), критерии готовности;',
      '3) предложи план первого шага.',
      'Если всё очевидно из заголовка — всё равно перескажи понимание и спроси подтверждения одним сообщением; после «да»/уточнений веди флоу.'
    ].join('\n')
    return [
      `Ты координатор рана ${runId}.`,
      kickoff,
      'ПОЛНОЕ описание задачи (из затравки + интервью) пересылай планировщику при старте: сразу после worker-start отправь его в его диспетчер — orca orchestration send --to dispatch:<dispatch_id> --body <полное описание> --json. Воркеры получают затравку в своей задаче; полный текст идёт от тебя.',
      'Бриф сохранён в .orca/coordinator-brief.md ворктри рана — потерял контекст, перечитай его.',
      `Репозиторий: ${projectPath ?? 'см. воркспейс'}. Ворктри воркеров: name:${worktreeName}.`,
      '',
      'Флоу (веди строго по порядку):',
      flow,
      '',
      'Действия:',
      `1. Немедленно: orca orchestration run-use --id ${runId} --json`,
      `2. orca orchestration task-list --run ${runId} --json — стартуй готовые шаги (worker-start --task <id> --worktree name:${worktreeName} --agent <agent> --json). Подшаг (строка «•») принадлежит своему шагу — его фаза отсчитывается от ЭТОГО шага, не от соседних. Получил task_not_startable — значит рано: зависимости не закрыты, вернись позже. Не перетасовывай порядок сам.`,
      '3. Отчёты завершившихся — worker-read; строка VERDICT: approve | request-changes в отчёте ревью управляет циклами доработки. Цикл доработки = ПЕРЕЗАПУСК целевого шага: task-update --id <task> --status pending, затем worker-start заново (замечания ревью передай в --prompt-файле или сообщением в диспетчер). СВОИ задачи (task-create) НЕ создавай — раунды считает движок, всё нужное уже в задачах шаблона.',
      '3a. Контейнер проверок (шаг без воркера): итог блока — отчёты всех запущенных проверок. request-changes или падение ЛЮБОЙ запущенной проверки = блок реджектнут: перезапусти on_reject-цель блока, собрав замечания ВСЕХ отклонивших проверок в один раунд (не по одному на проверку); после доработки перезапусти только отклонившие/падавшие проверки — одобрившие не дублируй.',
      '3b. Повтор проверки ЛЮБОГО происхождения — цикл доработки, перепроверка после правок, прямая просьба человека в чате — это ВСЕГДА перезапуск существующей задачи проверки (task-update --id <task> --status pending, затем worker-start): попытка ляжет в историю шага. task-create для повторов ЗАПРЕЩЁН — новая задача выпадает из шаблона, уезжает в конец плана и теряет вердикт-историю. task-create — только для НОВОЙ работы, которой нет в шаблоне (дополнительный ресёрч, follow-up).',
      '4. Вопросы воркеров — orchestration check; отвечай reply, решай сам всё, что решаемо.',
      '4a. optional-подшаги — условные: если тип задачи явно не требует (например, нет бэкенда — не запускай бэкенд-проверку), пропускай их и не жди.',
      'Факты и контекст (главная твоя работа между шагами):',
      '• Отчёт каждого шага — источник фактов для следующих. Прочитал отчёт — вынь из него фактический блок (пути, версии, решения, замечания) и пересылай следующему воркеру при старте: разработчику — план + замечания ревью + факты ресёрча; ревьюеру — артефакт + факты, влияющие на проверку.',
      '• Запуская подшаг по RUN: из отчёта родителя — передай ему ТОЧНЫЙ список вопросов/фактов, которые родитель просил собрать (скопируй их из отчёта, не пересказывай).',
      '• Результат подшага верни родителю дословно в этом же ключе: воркер.wait — не жди; worker-read отчёт подшага и приложи его факты к следующему раунду родителя.',
      '• Ничего не додумывай за воркеров: пересылай факты как есть, свои выводы помечай отдельно.',
      '5. Не можешь решить — напиши человеку в этот чат (суть, варианты, рекомендация) и заверши ход.',
      '6. Гейты из флоу — стоп для человека: жди его ответа здесь.',
      '7. Итог: когда последний шаг завершён, собери сводку по флою и закончи.'
    ].join('\n')
  }

  /** `VERDICT: approve|request-changes` in the report tail; default approve on failure to say.
   *  The LAST match wins: reports sometimes echo the protocol text («…одна из: VERDICT: approve
   *  VERDICT: request-changes») before the real verdict line — the first match would green
   *  a rejected review. */
  function parseVerdict(report: string): 'approve' | 'request-changes' {
    const matches = [...report.slice(-4000).matchAll(/VERDICT:\s*(approve|request-changes)/gi)]
    const match = matches[matches.length - 1]
    return match && match[1].toLowerCase() === 'request-changes' ? 'request-changes' : 'approve'
  }

  /** True when the report says the verdict explicitly (not the approve default). */
  function hasVerdictLine(report: string): boolean {
    return /VERDICT:\s*(approve|request-changes)/i.test(report.slice(-4000))
  }

  function parseJsonSafe<T>(text: string): T | null {
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  /** Reviewers sometimes put the verdict only in their done-message subject; the run inbox
   *  keeps it. One extra bridge call, only when the report is silent. */
  async function verdictFromInbox(taskId: string): Promise<'approve' | 'request-changes' | null> {
    try {
      const raw = await bridge.run('orca orchestration inbox --json')
      const parsed = parseJsonSafe<{ result?: { messages?: Array<{ type?: string; subject?: string; payload?: { taskId?: string } }> } }>(raw)
      for (const m of parsed?.result?.messages ?? []) {
        if (m.type !== 'worker_done' || m.payload?.taskId !== taskId) continue
        if (/request-changes/i.test(m.subject ?? '')) return 'request-changes'
        if (/\bapprove\b/i.test(m.subject ?? '')) return 'approve'
      }
      return null
    } catch {
      return null
    }
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
  const verdictFilling = new Set<string>()
  const eventsSub = orca.events.on('agent.status.changed', wakeSoon)
  // The bridge is pinned to the project's own workspace, so focus changes do not touch it —
  // only the project cache goes stale.
  const workspaceSub = orca.events.on('workspace.changed', () => {
    projectCache = null // focus moved: re-detect the project on the next ask
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
    // A local path expansion, no bridge round-trip: reading the library must not depend
    // on any workspace's focus.
    const stored = await orca.settings.get('libraryDir')
    const raw = typeof stored === 'string' && stored.trim() !== '' ? stored.trim() : DEFAULT_LIBRARY
    return expandHome(raw)
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
    const parts = files.map((f) => `echo __FILE__${f}; base64 < ${shellQuote(`${dir}/${f}`)} || true`)
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
          error: null,
          missingWorkers: []
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
          error: message(error),
          missingWorkers: []
        })
      }
    }
    // Resolve worker cards into steps (agents, models, failover chains) for the preview,
    // and surface steps whose worker has no card.
    const specialists = await loadSpecialists(source === 'project' ? projectPath : null)
    for (const template of templates) {
      if (template.error) continue
      const resolved = resolveSteps(template, specialists, {})
      template.steps = resolved
      const known = new Set(specialists.map((sp) => sp.slug))
      const missing = [...resolved, ...resolved.flatMap((st) => st.sub ?? [])]
        .filter((st) => st.specialist && !known.has(st.specialist) && !st.agent)
        .map((st) => st.specialist as string)
      template.missingWorkers = [...new Set(missing)]
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
    const root = projectPath ? projectPath.replace(/\/+$/, '') : null
    const dirs: Array<string> = []
    if (root) dirs.push(`${root}/.orca/workers`)
    if (!onlyProject) {
      const lib = (await libraryDir()).replace(/\/workflows$/, '')
      dirs.push(`${lib}/workers`)
    }
    const out: WfSpecialist[] = []
    // Cross-directory dedup: seenSlugs lives OUTSIDE the dir loop — the project's cards win
    // over the library demos (dirs order), earlier sort order wins within one tree. A Map
    // built from the list keeps the LAST duplicate, so without this the library's demo card
    // silently overwrote the project card for every colliding slug (empty spec -> task-create
    // dies mid-instantiate).
    const seenSlugs = new Set<string>()
    for (const dir of dirs) {
      let listing = ''
      try {
        listing = await bridge.run(
          `cd ${shellPath(dir)} 2>/dev/null && find . -type f -name '*.yaml' | sort | while read -r f; do echo "__WF_LS__$f"; base64 < "$f"; echo __WF_LE__; done; true`
        )
      } catch (error) {
        // A missing directory answers empty (the `cd … 2>/dev/null &&` guard); anything
        // else is an infrastructure failure — propagate it instead of pretending the
        // project has no worker cards (which would fake missingWorkers on every step).
        if (error instanceof BridgeError) throw error
        continue
      }
      let current: string | null = null
      const chunks: string[] = []
      const flush = (): void => {
        if (current) {
              // Nested layout: `plan/code-researcher.yaml` answers both to `code-researcher`
              // (flat name) and `plan/code-researcher`.
              const rel = current.replace(/^\.\//, '').replace(/\.yaml$/, '')
              const slug = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
              if (seenSlugs.has(slug)) return // an earlier entry with the same name wins
              seenSlugs.add(slug)
              seenSlugs.add(rel)
              try {
                const raw = parseYaml(fromBase64(chunks.join(''))) as { [k: string]: unknown }
                out.push({
                  slug,
                  agent: String(raw.agent ?? 'claude'),
                  model: typeof raw.model === 'string' ? raw.model : null,
                  effort: typeof raw.effort === 'string' ? raw.effort : null,
                  parallel: typeof raw.parallel === 'number' && raw.parallel > 0 ? raw.parallel : null,
                  fallback: Array.isArray(raw.fallback) ? raw.fallback.map(String) : typeof raw.fallback === 'string' && raw.fallback !== '' ? [String(raw.fallback)] : [],
                  // `prompt:` is the card key; `spec:` is the legacy spelling still used by
                  // the shipped demo cards and older projects — read both.
                  spec: typeof raw.prompt === 'string' ? raw.prompt : typeof raw.spec === 'string' && raw.spec !== '' ? raw.spec : null,
                  error: null
                })
          } catch (error) {
            out.push({ slug, agent: 'claude', model: null, effort: null, parallel: null, fallback: [], spec: null, error: message(error) })
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
      fallback: string[],
      spec: string | null,
      specFile: string | null
    ): { agent: string | null; model: string | null; effort: string | null; fallback: string[]; spec: string | null } => {
      const specOverride = specFile ? (specs[specFile] ?? spec) : spec
      if (!specialist) return { agent, model, effort: model ? effort : null, fallback, parallel: null, spec: specOverride ?? spec }
      const sp = bySlug.get(specialist)
      if (!sp) return { agent, model, effort: model ? effort : null, fallback, parallel: null, spec: specOverride ?? spec }
      const finalModel = model ?? sp.model
      return {
        agent: agent ?? sp.agent,
        model: finalModel,
        effort: finalModel ? (effort ?? sp.effort) : null,
        fallback: fallback.length > 0 ? fallback : sp.fallback,
        parallel: sp.parallel,
        spec: specOverride ?? sp.spec
      }
    }
    return template.steps.map((step) => {
      const own = resolveUnit(step.specialist, step.agent, step.model, step.effort, step.fallback ?? [], step.spec, step.specFile)
      const sub = (step.sub ?? []).map((child) => ({
        ...child,
        ...resolveUnit(child.specialist, child.agent, child.model, child.effort, child.fallback ?? [], child.spec, child.specFile)
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
    if (input.source === 'project' && input.projectPath) bridge.pin(input.projectPath)
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
        const objectiveSeed = input.objective.trim()
        const vars: Record<string, string> = {
          objective: objectiveSeed === '' ? 'Заголовок не задан; полную постановку передаст координатор после уточнения.' : objectiveSeed,
          repo: input.projectPath ?? '',
          base_branch: input.baseBranch ?? '',
          worktree: input.worktreeName
        }
        const run = await cli<{ runId: string }>(
          `orca orchestration run-create --objective ${shellQuote(objectiveSeed === '' ? template.title : `${template.title} — ${objectiveSeed.split('\n')[0].slice(0, 80)}`)} --json`
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
        if (template.missingWorkers.length > 0) {
          throw new BridgeError(
            `нет карточек воркеров: ${template.missingWorkers.join(', ')} — создай их в .orca/workers или через кнопку «Воркеры» в редакторе`,
            'cli_error'
          )
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
            `orca orchestration task-create --run ${shellQuote(run.runId)} --task-title ${shellQuote(
              `${unit.id} ${title}`
            )} --spec-file ${specFile}${depsFlag} --json`
          )
          taskOf.set(unit.id, String(task.taskId ?? task.id ?? ''))
          job.step = `task ${unit.id}`
          await saveJob(job)
          if (unit.gate) {
            await bridge.run(
              `orca orchestration gate-create --task ${shellQuote(
                taskOf.get(unit.id) as string
              )} --question ${shellQuote(applyPlaceholders(unit.gate.question, vars))} --options ${shellQuote(
                JSON.stringify(unit.gate.options)
              )} --json`
            )
          }
        }
        job.step = 'materialized'
        await saveJob(job)
        // Auto-pilot bookkeeping: per-task step configs, review retry pairs, optional subs.
        const autoTasks: Record<string, { stepId: string; agent: string; model: string | null; effort: string | null; fallback: string[]; order: number }> = {}
        for (const unit of units) {
          const taskId = taskOf.get(unit.id)
          if (!taskId || !unit.agent) continue
          autoTasks[taskId] = {
            stepId: unit.id,
            agent: unit.agent,
            model: unit.model,
            effort: unit.model ? unit.effort : null,
            fallback: unit.fallback ?? [],
            // Flow position of the unit: the CLI reorders task-list freely (status flips,
            // retries), so the panel must sort by this stamp to keep the template's order.
            order: topoUnits(units).findIndex((u) => u.id === unit.id)
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
        // Every sub-step task knows its owning block task, so the panel can nest them.
        const autoChildren: Record<string, string> = {}
        for (const unit of units) {
          if (unit.role !== 'child') continue
          const parentTaskId = stepIdToTask.get(unit.stepId)
          const ownTaskId = taskOf.get(unit.id)
          if (!ownTaskId) continue
          // A pure block (no spec of its own) has no parent task: anchor by the step id,
          // the panel renders such groups under a block header.
          autoChildren[ownTaskId] = parentTaskId && parentTaskId !== ownTaskId ? parentTaskId : `step:${unit.stepId}`
          if (unit.optional && parentTaskId) autoOptionals[ownTaskId] = { parentTaskId, stepId: unit.id }
        }
        await orca.storage.set(`auto.${run.runId}`, {
          worktreeName: input.worktreeName,
          repoPath: input.projectPath,
          baseBranch: input.baseBranch,
          firstStarted: false,
          tasks: autoTasks,
          reviews: autoReviews,
          optionals: autoOptionals,
          children: autoChildren,
          verdicts: {},
          rounds: {},
          triedAgents: {},
          actions: 0,
          stopped: null,
          driver: 'coordinator',
          coordinatorTerminal: null
        })
        // The run is led by a live coordinator agent. First materialize the run's own
        // worktree workspace (what a person expects to appear when a run starts), then
        // launch the coordinator session THERE — the main checkout stays untouched.
        try {
          const baseFlag = input.baseBranch ? ` --base-branch ${shellQuote(input.baseBranch)}` : ''
          await bridge.run(
            `orca worktree create --repo path:${shellQuote(input.projectPath ?? '.')} --name ${shellQuote(input.worktreeName)}${baseFlag} --json || true`,
            90_000
          )
          const list = await orca.host.call<{ workspaces: Array<{ id: string; name: string; path: string }> }>('workspace.list', undefined)
          const runWorktree = list.workspaces.find((w) => w.name === input.worktreeName)
            ?? list.workspaces.find((w) => w.path.endsWith(`/${input.worktreeName}`))
          const home = runWorktree ?? list.workspaces.find((w) => w.path === input.projectPath) ?? list.workspaces[0]
          const coordinator = specialists.find((sp) => sp.slug === 'coordinator')
          const brief = coordinatorBrief(run.runId, template, objectiveSeed, input.worktreeName, input.projectPath)
          // The brief lives as a file too: any session in the run's worktree can pick up the
          // coordinator role (run-use + read the brief) — the role is portable, not nailed
          // to the one session the plugin launched.
          let runWorktreePath: string | null = null
          try {
            const wts = await bridge.json<{ result?: { worktrees?: Array<{ displayName?: string; path?: string }> } }>('orca worktree list --json')
            const wtPath = (wts.result?.worktrees ?? []).find(
              (w) => w.displayName === input.worktreeName || (w.path ?? '').endsWith(`/${input.worktreeName}`)
            )?.path
            runWorktreePath = wtPath ?? null
            if (wtPath) {
              await bridge.run(
                `mkdir -p ${shellPath(`${wtPath}/.orca`)} && echo ${shellQuote(toBase64(brief))} | base64 -d > ${shellPath(`${wtPath}/.orca/coordinator-brief.md`)}`
              )
            }
          } catch {
            // файл брифа — удобство, ран живёт и без него
          }
          // The HOST agent.launch types the prompt the instant the terminal exists — a
          // still-booting agent CLI means the brief lands in a bare shell and is lost. The
          // CLI `orca agent launch` waits for the agent properly, so the coordinator starts
          // through it, in the run's own worktree; one verification + retry as a belt.
          const launchVerified = async (): Promise<string> => {
            const selector = runWorktreePath ? `path:${runWorktreePath}` : `name:${input.worktreeName}`
            for (let attempt = 0; attempt < 2; attempt++) {
              const out = await bridge.run(
                `orca agent launch --agent ${shellQuote(coordinator?.agent ?? input.agent)} --worktree ${shellQuote(selector)} --prompt ${shellQuote(brief)} --focus --json`,
                60_000
              )
              let handle = ''
              try {
                const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { result?: { terminal?: { handle?: string }, terminalId?: string } }
                handle = parsed.result?.terminal?.handle ?? parsed.result?.terminalId ?? ''
              } catch {
                // без хендла — просто доверяем запуску
              }
              if (handle === '') return handle
              await sleep(coordLaunch.bootWaitMs)
              try {
                const listing = await bridge.json<{ result?: { terminals?: Array<{ handle?: string; title?: string }> } }>('orca terminal list --json')
                const term = (listing.result?.terminals ?? []).find((t) => t.handle === handle)
                if (!term || /claude|codex|agent|zcode|opencode/i.test(term.title ?? '')) return handle
                await bridge.run(`orca terminal close --terminal ${handle} || true`)
              } catch {
                return handle
              }
            }
            throw new BridgeError('агент координатора не поднялся через CLI (2 попытки)', 'cli_error')
          }
          const launchedTerminal = await launchVerified()
          void home
          const stored = await loadAuto(run.runId)
          if (stored) {
            stored.worktreePath = runWorktreePath
            stored.coordinatorTerminal = launchedTerminal
            await saveAuto(run.runId, stored)
          }
          job.step = 'coordinator'
          await saveJob(job, run.runId)
        } catch (error) {
          // The run exists and tasks are materialized; a failed launch leaves it to the panel.
          job.error = `координатор не поднялся: ${message(error)}. Ран готов, водитель поднимается вручную: открой claude в ворктри рана и дай ему две команды — (1) orca orchestration run-use --id ${run.runId} --json  (2) прочитай .orca/coordinator-brief.md и веди флоу по нему`
          await saveJob(job, run.runId)
        }
        job.step = 'done'
        job.status = 'done'
        await saveJob(job, run.runId)
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
    try {
      const snap = await snapshot(runId ?? null)
      if (runId) void autopilot(runId, snap)
      lastSnapshot = JSON.stringify({ ...snap, at: 0 })
      await orca.storage.set('state.snapshot', snap)
      return snap
    } catch (error) {
      const cached = await orca.storage.get('state.snapshot')
      if (cached && typeof cached === 'object') {
        // Honest staleness: the bridge failed, so say so instead of passing cache off as live.
        return { ...(cached as WfSnapshot), at: Date.now(), error: `мост недоступен (${message(error)}) — показан последний снимок` }
      }
      return { at: Date.now(), run: null, tasks: [], gates: [], workers: [], error: message(error), pilot: null }
    }
  })

  orca.panels.handle('gate.resolve', async ({ gateId, resolution }) => {
    everUsed = true
    await bridge.run(
      `orca orchestration gate-resolve --id ${shellQuote(gateId)} --resolution ${shellQuote(resolution)} --json`
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
      )}${modelFlags}${effortFlags} --json`,
      90_000
    )
    void refresh()
    return { dispatchId: result.dispatchId, state: result.state }
  })

  type WfProject = { repoId: string; name: string; path: string }
  let projectCache: { at: number; project: WfProject | null; isWorkflow: boolean } | null = null
  orca.panels.handle('project.current', async () => {
    everUsed = true
    if (projectCache && Date.now() - projectCache.at < 60_000) {
      return { project: projectCache.project, isWorkflow: projectCache.isWorkflow }
    }
    const detected = await detectProject().catch(() => null)
    const runs = await listRuns().catch(() => [] as WfRun[])
    let project = detected
    let isWorkflow = false
    if (detected) {
      isWorkflow = runs.some((r) => r.projectPath === detected.path) || (await workflowDirsExist(detected.path))
    }
    if (!isWorkflow) {
      // Focus sits in a workspace that is not a workflow project (the home folder, a scratch
      // pad): keep the panel on the project of the most recent run instead of blanking it.
      const last = runs.find((r) => r.projectPath)?.projectPath
      if (last) {
        project = { repoId: detected?.repoId ?? '', name: last.split('/').filter(Boolean).pop() ?? last, path: last }
        isWorkflow = true
      }
    }
    projectCache = { at: Date.now(), project, isWorkflow }
    bridge.pin(project?.path ?? null)
    return { project, isWorkflow }
  })

  async function workflowDirsExist(projectPath: string): Promise<boolean> {
    try {
      const out = await bridge.run(
        `if [ -d ${shellPath(`${projectPath}/.orca/workflows`)} ] || [ -d ${shellPath(`${projectPath}/.orca/workers`)} ] || [ -d ${shellPath(`${projectPath}/.orca/specialists`)} ]; then echo __WF_PROJ__; fi; true`
      )
      return out.includes('__WF_PROJ__')
    } catch {
      return false
    }
  }

  async function detectProject(): Promise<WfProject | null> {
    // The bridge terminal lives in the focused workspace, and `orca terminal list` (run through
    // the bridge) carries each terminal's worktreeId "repoId::repoPath" — that names the project
    // without workspace.readContext, which can hang forever in some window states. readContext,
    // when it answers fast, still wins: it names the focused workspace's own first terminal.
    const [context, combined] = await Promise.all([
      Promise.race([
        orca.host.call<{ terminals?: Array<{ id: string }> }>('workspace.readContext', undefined).catch(() => null),
        sleep(3_000).then(() => null)
      ]),
      bridge.run(`echo __WFC__; orca terminal list --json; echo __WFR__; orca repo list --json; echo __WFE__`)
    ])
    const lines = combined.split('\n')
    const between = (from: string, to: string): string => {
      const start = lines.indexOf(from)
      const end = lines.indexOf(to, start + 1)
      return start >= 0 && end > start ? lines.slice(start + 1, end).join('\n') : ''
    }
    const terminalJson = between('__WFC__', '__WFR__')
    const repoJson = between('__WFR__', '__WFE__')
    if (!terminalJson) return null
    const wanted = context?.terminals?.[0]?.id ?? ''
    try {
      const listing = JSON.parse(extractJson(terminalJson)) as { result?: { terminals?: Array<{ handle?: string; worktreeId?: string }> } }
      const terminals = listing.result?.terminals ?? []
      const entry = terminals.find((t) => t.handle === wanted)
      const worktreeId = entry?.worktreeId ?? ''
      const repoId = worktreeId.split('::')[0]
      if (!repoId) return null
      const repos = JSON.parse(extractJson(repoJson)) as { result?: { repos?: Array<{ id?: string; displayName?: string; path?: string }> } }
      const repo = (repos.result?.repos ?? []).find((r) => r.id === repoId)
      if (!repo) return null
      return { repoId, name: repo.displayName ?? '', path: repo.path ?? '' }
    } catch {
      return null
    }
  }

  orca.panels.handle('template.list', async ({ source, projectPath }) => {
    if (source === 'project' && projectPath) bridge.pin(projectPath)
    return { templates: await listTemplates(source, projectPath ?? null) }
  })

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
    // Проба: открыть таб в АКТИВНОМ окне — workspaceId фокусного воркспейса + абсолютный путь.
    // Если рантайм вешает таб на окно воркспейса из параметра, редактор откроется там, где
    // человек нажал карандаш; иначе фолбэк — окно воркспейса файла (со всплытием вперёд).
    let activeId: string | null = null
    try {
      const context = await orca.host.call<{ branch: string; displayName: string } | null>('workspace.readContext', undefined)
      if (context) {
        const list = await orca.host.call<{ workspaces: Array<{ id: string; name: string; branch: string | null }> }>('workspace.list', undefined)
        activeId = (list.workspaces.find((w) => w.name === context.displayName)
          ?? (context.branch ? list.workspaces.find((w) => w.branch === context.branch) : undefined))?.id ?? null
      }
    } catch {
      activeId = null
    }
    if (activeId && activeId !== home.id) {
      const direct = await orca.host.call('editor.open', { workspaceId: activeId, path: filePath }).catch(() => null)
      if (direct) return { opened: true as const }
    }
    await orca.host.call('workspace.open', { workspaceId: home.id }).catch(() => undefined)
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

  orca.panels.handle('templates.updated', async ({ projectPath, yaml }) => {
    everUsed = true
    // Local parse, no bridge: the editor already holds the document, the panel swaps it in.
    const sourcePath = `${projectPath.replace(/\/+$/, '')}/.orca/workflows`
    let template: WfTemplate
    try {
      const parsed = parseTemplate('editor', parseYaml(yaml))
      template = {
        id: parsed.id,
        title: parsed.title,
        source: 'project',
        sourcePath,
        file: `${parsed.id}.workflow.yaml`,
        steps: parsed.steps,
        error: null,
        missingWorkers: []
      }
    } catch (error) {
      template = {
        id: 'editor',
        title: 'Черновик редактора',
        source: 'project',
        sourcePath,
        file: 'editor.workflow.yaml',
        steps: [],
        error: message(error),
        missingWorkers: []
      }
    }
    orca.panels.post('templates.changed', { projectPath, template })
    return { template }
  })

  orca.panels.handle('run.meta.set', async ({ runId, projectPath }) => {
    everUsed = true
    await orca.storage.set(`runmeta.${runId}`, { projectPath, at: Date.now() })
    void refresh()
    return { ok: true as const }
  })

  /** The editor knows the template's worker slugs, not its project (focus lies): pick the
   *  project whose cards actually cover those slugs — focused project first, then the
   *  last-run project, then every repo with .orca/workers. */
  orca.panels.handle('workers.listSmart', async ({ slugs }) => {
    everUsed = true
    const wanted: string[] = Array.isArray(slugs) ? slugs.map(String).filter((x) => x !== '') : []
    const candidates: string[] = []
    let detectedPath: string | null = null
    try {
      const meta = await orca.storage.get('runmeta.' + String(await orca.storage.get('html.runId') ?? ''))
      if (meta && typeof meta === 'object') {
        const mp = (meta as { projectPath?: unknown }).projectPath
        if (typeof mp === 'string' && mp !== '') detectedPath = mp
      }
    } catch {
      detectedPath = null
    }
    if (detectedPath) candidates.push(detectedPath)
    try {
      const repos = await bridge.json<{ result?: { repos?: Array<{ path?: string }> } }>('orca repo list --json')
      for (const r of repos.result?.repos ?? []) if (r.path && !candidates.includes(r.path)) candidates.push(r.path)
    } catch {
      // репозитории недоступны — обойдёмся фокусным
    }
    let best: { path: string; workers: WfSpecialist[]; score: number } | null = null
    for (const path of candidates) {
      let workers: WfSpecialist[]
      try {
        workers = await loadSpecialists(path, true)
      } catch {
        continue
      }
      if (workers.length === 0) continue
      const score = wanted.length === 0 ? 0 : wanted.filter((slug) => workers.some((w) => w.slug === slug)).length
      if (!best || score > best.score) best = { path, workers, score }
      if (best.score === wanted.length) break
    }
    if (!best) return { workers: [], projectPath: null }
    return { workers: best.workers, projectPath: best.path }
  })

  orca.panels.handle('workers.list', async ({ projectPath }) => {
    everUsed = true
    return { workers: await loadSpecialists(projectPath, true) }
  })

  orca.panels.handle('workers.save', async ({ projectPath, slug, agent, model, effort, parallel, spec }) => {
    if (projectPath) bridge.pin(projectPath)
    everUsed = true
    const clean = slug.trim().replace(/[^a-z0-9-]/g, '-')
    if (clean === '') throw new BridgeError('slug воркера не может быть пустым', 'cli_error')
    const dir = `${projectPath.replace(/\/+$/, '')}/.orca/workers`
    const yaml = [
      `agent: ${agent.trim() || 'claude'}`,
      model && model.trim() !== '' ? `model: ${model.trim()}` : null,
      effort && effort.trim() !== '' ? `effort: ${effort.trim()}` : null,
      typeof parallel === 'number' && parallel > 0 ? `parallel: ${parallel}` : null,
      spec.trim() !== '' ? `prompt: |\n${spec.replace(/\n$/, '').split('\n').map((l) => '  ' + l).join('\n')}` : null
    ].filter((x): x is string => x !== null).join('\n') + '\n'
    await bridge.run(
      `mkdir -p ${shellPath(dir)} && echo ${shellQuote(toBase64(yaml))} | base64 -d > ${shellPath(`${dir}/${clean}.yaml`)}`
    )
    return { ok: true as const }
  })

  orca.panels.handle('workers.delete', async ({ projectPath, slug }) => {
    if (projectPath) bridge.pin(projectPath)
    everUsed = true
    // Refuse while any project template still references the worker.
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
        if (uses) throw new BridgeError(`специалиста «${slug}» используется шаблоном ${file} — сначала убери его из шаблона`, 'cli_error')
      } catch (error) {
        if (error instanceof BridgeError) throw error
      }
    }
    const rmRoot = projectPath.replace(/\/+$/, '')
    await bridge.run(`rm -f ${shellPath(`${rmRoot}/.orca/workers/${slug}.yaml`)} ${shellPath(`${rmRoot}/.orca/specialists/${slug}.yaml`)}`)
    return { ok: true as const }
  })

  orca.panels.handle('pilot.resume', async ({ runId }) => {
    everUsed = true
    const state = await loadAuto(runId)
    if (!state) throw new BridgeError(`ран ${runId} не ведётся автопилотом`, 'cli_error')
    state.stopped = null
    await saveAuto(runId, state)
    void refresh()
    return { ok: true as const }
  })

  orca.panels.handle('task.report', async (input) => {
    everUsed = true
    let dispatchId: string | undefined = input.dispatchId ?? undefined
    let taskId: string | null | undefined = input.taskId ?? undefined
    if (input.runId && (input.taskId || dispatchId)) {
      const snap = await snapshot(input.runId)
      if (!dispatchId && input.taskId) {
        const task = snap.tasks.find((t) => t.id === input.taskId)
        dispatchId = task?.dispatchId ?? snap.workers.find((w) => w.taskId === input.taskId)?.dispatchId ?? undefined
      }
      // dispatchId без taskId: поднимаем taskId из снимка — без него write-through не
      // сможет проверить сабджект done-сообщения и не должен писать вердикт вообще.
      if (dispatchId && taskId === undefined) {
        taskId = snap.workers.find((w) => w.dispatchId === dispatchId)?.taskId ?? null
      }
    }
    if (!dispatchId) throw new BridgeError('у шага ещё нет отчёта — воркер не запускался', 'cli_error')
    return { report: await readWorkerReport(dispatchId, taskId === undefined ? undefined : taskId) }
  })

  orca.panels.handle('task.attemptVerdicts', async ({ runId, taskId }) => {
    everUsed = true
    const snap = await snapshot(runId)
    const dispatches = snap.workers.filter((w) => w.taskId === taskId).map((w) => w.dispatchId)
    const verdicts: Record<string, 'approve' | 'request-changes' | null> = {}
    for (const dispatchId of dispatches) {
      const report = await readWorkerReport(dispatchId, taskId)
      verdicts[dispatchId] = report === '' ? null : parseVerdict(report)
    }
    return { verdicts }
  })

  orca.panels.handle('task.retry', async ({ runId, taskId }) => {
    everUsed = true
    const snap = await snapshot(runId)
    const byId = new Map(snap.tasks.map((t) => [t.id, t]))
    if (!byId.has(taskId)) throw new BridgeError(`задача ${taskId} не в ране ${runId}`, 'cli_error')
    // The step itself and everything downstream of it.
    const downstream = new Set<string>([taskId])
    let grew = true
    while (grew) {
      grew = false
      for (const t of snap.tasks) {
        if (downstream.has(t.id)) continue
        if (t.deps.some((d) => downstream.has(d))) {
          downstream.add(t.id)
          grew = true
        }
      }
    }
    for (const id of downstream) {
      await bridge.run(`orca orchestration task-update --id ${shellQuote(id)} --status pending --json`)
    }
    // Resume the autopilot and forget failover history for the reset tail.
    const state = await loadAuto(runId)
    if (state) {
      state.stopped = null
      for (const id of downstream) {
        delete state.triedAgents?.[id]
        delete state.verdicts[id]
      }
      await saveAuto(runId, state)
    }
    void refresh()
    return { ok: true as const, reset: [...downstream] }
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
    return { terminalId: bridge.current() }
  })

  orca.panels.handle('bridge.debug', async () => bridge.stats())

  /** The focused workspace's path — the session the panel lives in; runs bind to it. */
  orca.panels.handle('session.workspace', async () => {
    everUsed = true
    try {
      const context = await Promise.race([
        orca.host.call<{ branch: string; displayName: string } | null>('workspace.readContext', undefined),
        sleep(3_000).then(() => null)
      ])
      if (!context) return { path: null }
      const list = await bridge.json<{ result?: { workspaces?: Array<{ path: string; name: string; branch: string | null }> } }>('orca worktree list --json')
      const ws = (list.result?.workspaces ?? []).find((w) => w.name === context.displayName)
        ?? (list.result?.workspaces ?? []).find((w) => w.branch === context.branch)
      return { path: ws?.path ?? null }
    } catch {
      return { path: null }
    }
  })

  /** Available models from Orca's agent catalog (per agent, as discovered on this machine):
   *  what a proxy actually resolves — the ids a worker card's `model:` may use. */
  let modelsCache: { at: number; models: Array<{ id: string; label: string; agent: string }> } | null = null
  orca.panels.handle('models.list', async () => {
    everUsed = true
    if (modelsCache && Date.now() - modelsCache.at < 300_000) return { models: modelsCache.models }
    const out = await bridge.run(
      `sqlite3 ${shellQuote(`${homedir()}/Library/Application Support/orca/agent-model-catalog.db`)} "SELECT value FROM rows;"`,
      10_000
    )
    const models: Array<{ id: string; label: string; agent: string }> = []
    for (const chunk of out.split('\n')) {
      try {
        const doc = JSON.parse(chunk) as { agent?: string; discovered?: { models?: Array<{ id?: string; label?: string }> } }
        for (const m of doc.discovered?.models ?? []) {
          if (m.id) models.push({ id: m.id, label: m.label ?? m.id, agent: doc.agent ?? '' })
        }
      } catch {
        // не-json строка — пропускаем
      }
    }
    modelsCache = { at: Date.now(), models }
    return { models }
  })

  /** The engine has no run-delete command; the records live in the runtime's sqlite db
   *  (its schema carries DELETE triggers). One run at a time, never one with live workers. */
  orca.panels.handle('run.delete', async ({ runId }) => {
    everUsed = true
    const id = String(runId ?? '').trim()
    if (!id.startsWith('run_')) throw new BridgeError('это не id рана', 'cli_error')
    const db = `${homedir()}/Library/Application Support/orca/orchestration.db`
    const live = await bridge.run(
      `sqlite3 ${shellQuote(db)} "SELECT COUNT(*) FROM worker_dispatches wd JOIN dispatch_contexts dc ON wd.dispatch_id = dc.id WHERE dc.run_id = '${id.replace(/'/g, '')}' AND wd.state IN ('starting','ready');"`
    )
    if (Number(live.trim()) > 0) throw new BridgeError('у рана есть работающие воркеры — сначала останови их', 'cli_error')
    await bridge.run(
      [
        `sqlite3 ${shellQuote(db)} <<'SQL'`,
        'BEGIN;',
        `DELETE FROM messages WHERE run_id = '${id}';`,
        `DELETE FROM deliveries WHERE run_id = '${id}';`,
        `DELETE FROM worker_dispatches WHERE dispatch_id IN (SELECT dispatch_id FROM dispatch_contexts WHERE run_id = '${id}');`,
        `DELETE FROM dispatch_contexts WHERE run_id = '${id}';`,
        `DELETE FROM tasks WHERE run_id = '${id}';`,
        `DELETE FROM decision_gates WHERE run_id = '${id}';`,
        `DELETE FROM runs WHERE id = '${id}';`,
        'COMMIT;',
        'SQL'
      ].join('\n')
    )
    await orca.storage.delete(`runmeta.${id}`).catch(() => undefined)
    await orca.storage.delete(`auto.${id}`).catch(() => undefined)
    await orca.storage.delete(`agents.${id}`).catch(() => undefined)
    void refresh()
    return { ok: true }
  })




}

function message(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function deactivate(): void {
  stopTimer?.()
  stopTimer = null
  void activeBridge?.reset()
  activeBridge = null
}
