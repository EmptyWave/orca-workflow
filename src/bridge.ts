// The CLI bridge: a dedicated background terminal in which the worker runs `orca` commands
// and captures their output between unique markers. Direct orchestration plugin APIs do not
// exist, and "a trusted-worker can act as the orca CLI does" over exactly these terminal calls.
import type { OrcaWorkerApi } from 'orca/worker'

const READ_INTERVAL_MS = 120
// 12s keeps probe + one zombie-retry inside the 30s plugin.request budget.
const DEFAULT_TIMEOUT_MS = 12_000
const READ_LINES = 400

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
  private counter = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly orca: OrcaWorkerApi) {}

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
    const context = await this.orca.host.call('workspace.readContext', undefined)
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
        await this.closeStrayBridges(context.terminals, candidate.id)
        return candidate.id
      }
    }
    const workspaceId = await this.resolveFocusedWorkspace(context)
    const created = await this.orca.host.call('terminal.create', {
      workspaceId,
      title: 'workflow-view bridge'
    })
    this.terminal = created.terminalId
    await this.widen(created.terminalId)
    await this.closeStrayBridges(context.terminals, created.terminalId)
    return created.terminalId
  }

  /** readContext names the focused workspace but not its id; find it in the full list. */
  private async resolveFocusedWorkspace(context: { branch: string; displayName: string }): Promise<string> {
    const list = await this.orca.host.call('workspace.list', undefined)
    const byName = list.workspaces.find((w) => w.name === context.displayName)
    const ws = byName ?? (context.branch ? list.workspaces.find((w) => w.branch === context.branch) : undefined)
    if (!ws) {
      throw new BridgeError(`воркспейс «${context.displayName}» не найден в списке воркспейсов Orca`, 'no_terminal')
    }
    return ws.id
  }

  /** Dead bridge ptys would pile up with every undetected death; a live bridge closes its
   *  same-titled siblings. Only ever terminals titled exactly ours — never a person's. */
  private async closeStrayBridges(terminals: Array<{ id: string; title?: string }>, keep: string): Promise<void> {
    if (!this.terminal) return
    for (const stray of terminals) {
      if (stray.title !== 'workflow-view bridge' || stray.id === keep) continue
      await this.exec(`orca terminal close --terminal ${stray.id} || true`, this.terminal, 5_000).catch(() => undefined)
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
    await this.orca.host.call('terminal.sendText', {
      terminalId,
      text: `echo "${begin}"; ${command}; echo "${end}_$?__"`,
      enter: true
    })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      await sleep(READ_INTERVAL_MS)
      const read = await this.orca.host.call('terminal.read', { terminalId, maxLines: READ_LINES })
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
  }

  /** Forgets the bridge; the next command adopts or creates one in the then-focused workspace. */
  async reset(): Promise<void> {
    this.terminal = null
    this.widenedFor = null
    await this.orca.storage.delete('bridge.terminalId').catch(() => undefined)
  }

  /** A command that prints one JSON document; parsed and returned. */
  async json<T>(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    const output = await this.run(command, timeoutMs)
    return parseJson<T>(output)
  }
}

function sleep(ms: number): Promise<void> {
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
