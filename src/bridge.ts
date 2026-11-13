// The CLI bridge: Orca has no plugin API for orchestration, so the worker runs `orca`
// commands and captures output between unique markers. Each command runs in its own
// short-lived terminal created straight in the pinned project's workspace — creation is not
// focus-scoped (unlike terminal input, which Orca limits to the active worktree), the
// terminal exits when the command is done, and nothing persistent is left behind.
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'

const DEFAULT_TIMEOUT_MS = 12_000
const READ_INTERVAL_MS = 120
const READ_LINES = 400
// A host call can hang forever (e.g. workspace.readContext with no focusable workspace);
// every call is raced against a deadline so the bridge can never get stuck on one.
const HOST_CALL_MS = 5_000

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'bridge_timeout' | 'cli_error' | 'bad_json' | 'no_terminal' | 'not_focused'
  ) {
    super(message)
  }
}

export class Bridge {
  /** The project the bridge runs commands in. Terminals belong to the project's own
   *  workspace — never to whatever workspace happens to be focused. */
  private pinPath: string | null = null
  private wsCache: Record<string, string> = {}
  /** Markers must never repeat across worker restarts, or a reused pty's stale buffer
   *  could be mistaken for a fresh answer. */
  private counter = Math.floor(Math.random() * 900_000) + 100_000
  private lastTerminal: string | null = null
  private inflight: { command: string; terminal: string; since: number } | null = null
  private sent = 0
  private finished = 0

  constructor(private readonly orca: OrcaWorkerApi) {}

  /** What the bridge is doing right now — the debugging window into a stuck queue. */
  stats(): { terminal: string | null; counter: number; sent: number; finished: number; inflight: typeof this.inflight } {
    return { terminal: this.lastTerminal, counter: this.counter, sent: this.sent, finished: this.finished, inflight: this.inflight }
  }

  /** A host call that must answer: hangs surface as bridge errors, never a stuck worker. */
  private async call<T>(method: string, params: unknown, timeoutMs = HOST_CALL_MS): Promise<T> {
    return Promise.race([
      this.orca.host.call<T>(method, params),
      sleep(timeoutMs).then(() => {
        throw new BridgeError(`host-вызов ${method} не ответил за ${timeoutMs} мс`, 'no_terminal')
      })
    ])
  }

  /** The bridge belongs to one project at a time: the worker re-pins as the panel's scope
   *  moves (project detection, run selection, template source). */
  pin(projectPath: string | null): void {
    this.pinPath = projectPath
  }

  /** The last one-shot terminal (informational, for the settings panel). */
  current(): string | null {
    return this.lastTerminal
  }

  /** Runs one shell command; resolves with everything it printed between the markers.
   *  A timeout costs one retry — a fresh terminal is created either way. `unpinned` runs
   *  it in whatever workspace is focused: machine-global commands (the template library)
   *  must not depend on the project being focused. */
  async run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, opts?: { unpinned?: boolean }): Promise<string> {
    try {
      return await this.exec(command, timeoutMs, opts?.unpinned === true)
    } catch (error) {
      if (error instanceof BridgeError && error.code === 'bridge_timeout') {
        return await this.exec(command, timeoutMs, opts?.unpinned === true)
      }
      throw error
    }
  }

  private async exec(command: string, timeoutMs: number, unpinned = false): Promise<string> {
    const n = ++this.counter
    const begin = `__WF${n}B__`
    const end = `__WF${n}E`
    this.inflight = { command: command.slice(0, 160), terminal: '?', since: Date.now() }
    this.sent += 1
    try {
      const workspaceId = await this.resolveWorkspace(unpinned)
      const created = await this.call<{ terminalId: string }>('terminal.create', {
        workspaceId,
        title: 'workflow-view bridge',
        // `exit` ends the pty with the command — the terminal cleans itself up.
        command: `stty cols 4096 2>/dev/null; echo "${begin}"; ${command}; echo "${end}_$?__"; exit`
      }, 10_000)
      this.lastTerminal = created.terminalId
      this.inflight = { command: command.slice(0, 160), terminal: created.terminalId, since: Date.now() }
      // Orca defers a background terminal's command until its workspace becomes active: an
      // empty pty means the project is not focused right now — fail fast instead of burning
      // the whole timeout, and say so in terms a human can act on.
      const deliveryDeadline = Date.now() + 4_500
      let delivered = false
      let emptyReads = 0
      const deadline = Date.now() + timeoutMs
      for (;;) {
        await sleep(READ_INTERVAL_MS)
        const read = await this.call<{ lines: string[] }>('terminal.read', { terminalId: created.terminalId, maxLines: READ_LINES })
        if (!delivered && read.lines.some((line) => line.trim() === begin)) delivered = true
        if (!delivered && Date.now() > deliveryDeadline) {
          throw new BridgeError(`воркспейс проекта не в фокусе — вернись в него (или обнови позже): ${tail(command, 100)}`, 'not_focused')
        }
        // A terminal that delivered its begin marker and then reads back empty is dead
        // (focus flipped, Orca reaped the background pty): reading it returns nothing
        // forever, so fail now and let run() retry on a fresh one instead of burning
        // the whole timeout.
        if (delivered && read.lines.filter((line) => line.trim() !== '').length === 0) {
          emptyReads += 1
          if (emptyReads >= 2) {
            throw new BridgeError(`терминал моста исчез посреди команды (смена фокуса?) — повтор: ${tail(command, 100)}`, 'bridge_timeout')
          }
        } else {
          emptyReads = 0
        }
        const found = capture(read.lines, n)
        if (found) {
          if (found.exit !== 0) {
            throw new BridgeError(tail(found.output, 600) || `команда завершилась с кодом ${found.exit}`, 'cli_error')
          }
          return found.output
        }
        if (Date.now() > deadline) {
          const seen = read.lines.filter((l) => l.trim() !== '').length
          throw new BridgeError(`мост: таймаут ${timeoutMs} мс (строк в буфере: ${seen}; begin ${delivered ? 'виден' : 'НЕ виден'}): ${tail(command, 100)}`, 'bridge_timeout')
        }
      }
    } finally {
      this.finished += 1
      this.inflight = null
    }
  }

  private wsListAt = 0
  private wsList: { workspaces: Array<{ id: string; kind: string; name: string; path: string; branch?: string | null; project?: string | null }> } | null = null

  private async workspaces(): Promise<NonNullable<typeof this.wsList>> {
    if (this.wsList && Date.now() - this.wsListAt < 30_000) return this.wsList
    this.wsList = await this.call('workspace.list', undefined)
    this.wsListAt = Date.now()
    return this.wsList
  }

  /** Where one-shots live: the pinned project's workspace when pinned (its main checkout,
   *  else any worktree of it), else the focused workspace. A pinned project whose REPO is
   *  not the focused one refuses up front — Orca defers a background terminal's command
   *  until its workspace becomes active, so creating one would only leave junk behind.
   *  Repo-level comparison: a worktree of the same project counts as in-focus. */
  private async resolveWorkspace(unpinned: boolean): Promise<string> {
    const list = await this.workspaces()
    if (this.pinPath && !unpinned) {
      const ws = list.workspaces.find((w) => w.path === this.pinPath)
        ?? list.workspaces.find((w) => w.path.startsWith(`${this.pinPath}/`))
      if (!ws) {
        throw new BridgeError(`воркспейс проекта ${this.pinPath} не открыт в Orca — открой его, чтобы мост работал`, 'no_terminal')
      }
      const focused = await this.call<{ branch: string; displayName: string } | null>('workspace.readContext', undefined, 3_000).catch(() => null)
      if (focused) {
        const active = list.workspaces.find((w) => w.name === focused.displayName)
          ?? (focused.branch ? list.workspaces.find((w) => w.branch === focused.branch) : undefined)
        const otherRepo = active && active.project && ws.project && active.project !== ws.project
        if (otherRepo) {
          throw new BridgeError(`проект не в фокусе (сейчас активен «${focused.displayName}») — вернись в его воркспейс или обнови позже`, 'not_focused')
        }
      }
      this.wsCache[this.pinPath] = ws.id
      return ws.id
    }
    const context = await this.call<{ branch: string; displayName: string } | null>('workspace.readContext', undefined).catch(() => null)
    const ws = context
      ? list.workspaces.find((w) => w.name === context.displayName) ?? (context.branch ? list.workspaces.find((w) => w.branch === context.branch) : undefined)
      : undefined
    if (!ws) {
      throw new BridgeError('нет фокусного воркспейса — открой workspace проекта в Orca', 'no_terminal')
    }
    return ws.id
  }

  /** Forgets the workspace resolution (a manual reset through the settings panel). */
  async reset(): Promise<void> {
    this.wsCache = {}
  }

  /** A command that prints one JSON document; parsed and returned. */
  async json<T>(command: string, timeoutMs = DEFAULT_TIMEOUT_MS, opts?: { unpinned?: boolean }): Promise<T> {
    const output = await this.run(command, timeoutMs, opts)
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

/** Expands a leading ~ against the local home directory — no bridge round-trip needed. */
export function expandHome(path: string): string {
  if (!path.startsWith('~/')) return path
  return `${homedir()}/${path.slice(2)}`
}
