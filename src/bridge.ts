// The CLI bridge: a dedicated background terminal in which the worker runs `orca` commands
// and captures their output between unique markers. Direct orchestration plugin APIs do not
// exist, and "a trusted-worker can act as the orca CLI does" over exactly these terminal calls.
import type { OrcaWorkerApi } from 'orca/worker'

const READ_INTERVAL_MS = 120
// 12s keeps probe + one zombie-retry inside the 30s plugin.request budget.
const DEFAULT_TIMEOUT_MS = 12_000
const READ_LINES = 400
// A host call can hang forever (e.g. workspace.readContext with no focusable workspace);
// every call is raced against a deadline so the bridge queue can never get stuck on one.
const HOST_CALL_MS = 5_000

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'bridge_timeout' | 'cli_error' | 'bad_json' | 'no_terminal'
  ) {
    super(message)
  }
}

export class Bridge {
  private terminal: string | null = null
  private widenedFor: string | null = null
  /** Markers must never repeat across worker restarts: a fresh worker that re-uses a terminal
   *  would otherwise "capture" the previous worker's stale markers from its buffer and adopt
   *  a dead terminal as live. A random seed makes collision practically impossible. */
  private counter = Math.floor(Math.random() * 900_000) + 100_000
  private queue: Promise<unknown> = Promise.resolve()
  private inflight: { command: string; terminal: string; since: number } | null = null
  private sent = 0
  private finished = 0

  constructor(private readonly orca: OrcaWorkerApi) {}

  /** What the bridge is doing right now — the debugging window into a stuck queue. */
  stats(): { terminal: string | null; counter: number; sent: number; finished: number; inflight: typeof this.inflight } {
    return { terminal: this.terminal, counter: this.counter, sent: this.sent, finished: this.finished, inflight: this.inflight }
  }

  /** A host call that must answer: hangs surface as bridge timeouts, never as a stuck queue. */
  private async call<T>(method: string, params: unknown, timeoutMs = HOST_CALL_MS): Promise<T> {
    return Promise.race([
      this.orca.host.call<T>(method, params),
      sleep(timeoutMs).then(() => {
        throw new BridgeError(`host-вызов ${method} не ответил за ${timeoutMs} мс`, 'bridge_timeout')
      })
    ])
  }

  /** A default-width pty wraps long lines (JSON rows, YAML questions), corrupting captured
   *  output; widen the terminal once — whether just adopted or freshly created. */
  private async widen(terminalId: string): Promise<void> {
    if (this.widenedFor === terminalId) return
    this.widenedFor = terminalId
    await this.exec('stty cols 4096 2>/dev/null || true', terminalId, 3_000).catch(() => undefined)
  }

  /** The terminal handle. Orca scopes plugin terminal input to the FOCUSED workspace's
   *  terminals, so the bridge must live there and follow focus: adopt a live bridge titled
   *  ours among the focused workspace's terminals, else create one in that workspace. */
  async ensure(): Promise<string> {
    if (this.terminal) return this.terminal
    const context = await this.call<{ terminals?: Array<{ id: string; title?: string }> }>('workspace.readContext', undefined)
    if (!context) {
      throw new BridgeError('нет фокусного воркспейса — открой workspace проекта в Orca', 'no_terminal')
    }
    // A dead pty still answers terminal.read with stale output, so probe with a real command;
    // cap the attempts so a pile-up of corpses cannot eat the whole request budget.
    const candidates = context.terminals.filter((t) => t.title === 'workflow-view bridge')
    for (const candidate of candidates.slice(0, 3)) {
      const probe = await this.exec('echo __WF_ALIVE__', candidate.id, 2_500).catch(() => null)
      if (probe !== null) {
        this.terminal = candidate.id
        await this.widen(candidate.id)
        return candidate.id
      }
    }
    const workspaceId = await this.resolveFocusedWorkspace(context)
    const created = await this.call<{ terminalId: string }>('terminal.create', {
      workspaceId,
      title: 'workflow-view bridge'
    }, 10_000)
    this.terminal = created.terminalId
    await this.widen(created.terminalId)
    await this.reapStrayBridges()
    return created.terminalId
  }

  /** readContext names the focused workspace but not its id; find it in the full list. */
  private async resolveFocusedWorkspace(context: { branch: string; displayName: string }): Promise<string> {
    const list = await this.call<{ workspaces: Array<{ id: string; name: string; branch?: string }> }>('workspace.list', undefined)
    const byName = list.workspaces.find((w) => w.name === context.displayName)
    const ws = byName ?? (context.branch ? list.workspaces.find((w) => w.branch === context.branch) : undefined)
    if (!ws) {
      throw new BridgeError(`воркспейс «${context.displayName}» не найден в списке воркспейсов Orca`, 'no_terminal')
    }
    return ws.id
  }

  /** Adopt-or-create leaves older bridges behind — in other workspaces, other focus eras. A
   *  live bridge reaps its same-titled siblings everywhere, so they cannot pile up. Only ever
   *  terminals titled exactly ours — never a person's. */
  private async reapStrayBridges(): Promise<void> {
    if (!this.terminal) return
    try {
      const out = await this.exec('orca terminal list --json', this.terminal, 5_000)
      const listing = parseJson<{ result?: { terminals?: Array<{ handle?: string; title?: string }> } }>(out)
      for (const t of listing.result?.terminals ?? []) {
        if (t.title !== 'workflow-view bridge' || !t.handle || t.handle === this.terminal) continue
        await this.exec(`orca terminal close --terminal ${t.handle} || true`, this.terminal, 5_000).catch(() => undefined)
      }
    } catch {
      // reaping is best-effort; a stray bridge is harmless compared to a dead one
    }
  }

  /** The live bridge handle, or null while none has been ensured. */
  current(): string | null {
    return this.terminal
  }

  /** Runs one shell command; resolves with everything it printed between the markers.
   *  A timeout means the terminal went zombie: reset it and retry once on a fresh one. */
  async run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    try {
      return await this.enqueue(command, timeoutMs)
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'bridge_timeout') {
        await this.reset()
        return await this.enqueue(command, timeoutMs)
      }
      throw error
    }
  }

  private enqueue(command: string, timeoutMs: number): Promise<string> {
    const runOnce = async (): Promise<string> => this.exec(command, await this.ensure(), timeoutMs)
    const next = this.queue.then(runOnce, runOnce)
    this.queue = next.catch(() => undefined)
    return next
  }

  private async exec(command: string, terminalId: string, timeoutMs: number): Promise<string> {
    const n = ++this.counter
    const begin = `__WF${n}B__`
    const end = `__WF${n}E`
    this.inflight = { command: command.slice(0, 160), terminal: terminalId, since: Date.now() }
    this.sent += 1
    try {
      await this.call('terminal.sendText', {
        terminalId,
        text: `echo "${begin}"; ${command}; echo "${end}_$?__"`,
        enter: true
      })
      const deadline = Date.now() + timeoutMs
      // A send the terminal never echoed means Orca dropped the input (focus scoping) — no
      // point waiting the full timeout. The begin echo appears within a second of a real
      // delivery; a fresh pty gets more slack for its first shell start.
      const deliveryDeadline = Date.now() + (this.widenedFor === terminalId ? 4_500 : 9_000)
      let delivered = false
      for (;;) {
        await sleep(READ_INTERVAL_MS)
        const read = await this.call<{ lines: string[] }>('terminal.read', { terminalId, maxLines: READ_LINES })
        if (!delivered && read.lines.some((line) => line.trim() === begin)) delivered = true
        if (!delivered && Date.now() > deliveryDeadline) {
          throw new BridgeError(`мост: ввод не дошёл до терминала (смена фокуса?): ${tail(command, 120)}`, 'bridge_timeout')
        }
        const found = capture(read.lines, n)
        if (found) {
          if (found.exit !== 0) {
            throw new BridgeError(tail(found.output, 600) || `команда завершилась с кодом ${found.exit}`, 'cli_error')
          }
          return found.output
        }
        if (Date.now() > deadline) {
          throw new BridgeError(`мост: таймаут ${timeoutMs} мс для команды: ${tail(command, 120)}`, 'bridge_timeout')
        }
      }
    } finally {
      this.finished += 1
      this.inflight = null
    }
  }

  /** Forgets the bridge; the next command adopts or creates one in the then-focused workspace.
   *  Purely in-memory on purpose: a storage call here could hang and, from inside the retry
   *  path of run(), deadlock the whole command queue. */
  async reset(): Promise<void> {
    this.terminal = null
    this.widenedFor = null
  }

  /** A command that prints one JSON document; parsed and returned. */
  async json<T>(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const output = await this.run(command, timeoutMs)
    return parseJson<T>(output)
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Marker lines must stand alone: the echoed command line also contains the marker text. */
function capture(lines: readonly string[], n: number): { output: string; exit: number } | null {
  const begin = `__WF${n}B__`
  const end = `__WF${n}E`
  let started = false
  const body: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!started) {
      if (line === begin) started = true
      continue
    }
    if (line.startsWith(end)) {
      const code = line.slice(end.length)
      const exit = code.startsWith('_') && code.endsWith('__') ? Number(code.slice(1, -2)) : 0
      return { output: body.join('\n'), exit: Number.isFinite(exit) ? exit : 0 }
    }
    body.push(raw)
  }
  return null
}

/** Finds the JSON document in captured text (the CLI may print warnings around it). */
function parseJson<T>(output: string): T {
  const trimmed = output.trim()
  const attempts = [trimmed]
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1))
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T
    } catch {
      // try the next candidate
    }
  }
  throw new BridgeError(`мост: не JSON в ответе: ${tail(output, 300)}`, 'bad_json')
}

function tail(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : '…' + flat.slice(flat.length - max)
}

/** Single-quoted for the bridge shell; `~` at the start stays outside the quotes to expand. */
export function shellPath(path: string): string {
  if (path.startsWith('~/')) return `~/'${path.slice(2).replace(/'/g, "'\\''")}'`
  return `'${path.replace(/'/g, "'\\''")}'`
}

/** Expands a leading ~ against the bridge shell's $HOME (used for settings like libraryDir). */
export async function expandHome(bridge: Bridge, path: string): Promise<string> {
  if (!path.startsWith('~/')) return path
  const home = (await bridge.run('echo $HOME')).trim()
  return `${home}/${path.slice(2)}`
}
