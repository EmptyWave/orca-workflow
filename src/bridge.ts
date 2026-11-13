// The CLI runner: Orca has no plugin API for orchestration, but a trusted worker may run
// the `orca` CLI itself — commands spawn in the worker's own process, with no terminals
// and no focus scoping. Orchestration MUTATIONS additionally need a stable sender identity
// (`--from <terminal handle>`): a helper terminal is created on demand through the CLI
// (terminal creation is not focus-scoped) and reused; it is closed on deactivate.
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import type { OrcaWorkerApi } from 'orca/worker'

const DEFAULT_TIMEOUT_MS = 15_000
const SPAWN_BUFFER = 16 * 1024 * 1024

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: 'bridge_timeout' | 'cli_error' | 'bad_json' | 'no_terminal'
  ) {
    super(message)
  }
}

/** Test seam: the harness swaps this for canned answers; null means real spawning. */
export const spawnHooks: { exec: ((command: string, timeoutMs: number) => Promise<string>) | null } = { exec: null }

async function spawn(command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('bash', ['-c', command], { timeout: timeoutMs, maxBuffer: SPAWN_BUFFER }, (error, stdout, stderr) => {
      if (error) {
        // The human-readable message is truncated, but the FULL stderr rides on the error:
        // retry matchers (no_active_sender_terminal & co) must survive long commands whose
        // text pushes the CLI's error code out of any fixed-size slice.
        const wrapped = new BridgeError(`${String(error.message).slice(0, 260)}${stderr ? ' | ' + tail(stderr, 200) : ''}`, 'cli_error')
        ;(wrapped as BridgeError & { stderr?: string }).stderr = stderr
        reject(wrapped)
      } else {
        resolve(stdout)
      }
    })
  })
}

export class Bridge {
  /** The project whose worktree hosts the helper --from terminal. */
  private pinPath: string | null = null
  private fromHandle: string | null = null
  private inflight: { command: string; terminal: string; since: number } | null = null
  private sent = 0
  private finished = 0

  constructor(private readonly orca: OrcaWorkerApi) {}

  /** A host call that must answer: hangs surface as bridge errors, never a stuck worker. */
  private async host<T>(method: string, params: unknown, timeoutMs = 5_000): Promise<T> {
    return Promise.race([
      this.orca.host.call<T>(method, params),
      sleep(timeoutMs).then(() => {
        throw new BridgeError(`host-вызов ${method} не ответил за ${timeoutMs} мс`, 'no_terminal')
      })
    ])
  }

  stats(): { terminal: string | null; counter: number; sent: number; finished: number; inflight: typeof this.inflight } {
    return { terminal: this.fromHandle, counter: 0, sent: this.sent, finished: this.finished, inflight: this.inflight }
  }

  /** Helpers are cached per project path: re-pinning back and forth reuses the live
   *  terminal instead of rotating identities — a run's consumer binding stays valid. */
  private fromByPath: Record<string, string> = {}
  pin(projectPath: string | null): void {
    if (projectPath === this.pinPath) return
    this.pinPath = projectPath
    this.fromHandle = projectPath ? this.fromByPath[projectPath] ?? null : null
  }

  /** The last helper --from terminal (informational). */
  current(): string | null {
    return this.fromHandle
  }

  /** Runs one shell command and resolves with its stdout. A mutation that arrives without
   *  a sender identity (no_active_sender_terminal) or through a dead helper terminal
   *  (stable_pane_required) is retried once with a fresh --from handle. */
  async run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const impl = spawnHooks.exec ?? spawn
    this.inflight = { command: command.slice(0, 160), terminal: this.fromHandle ?? 'spawn', since: Date.now() }
    this.sent += 1
    try {
      try {
        return await impl(command, timeoutMs)
      } catch (error) {
        const text = [error instanceof Error ? error.message : String(error), (error as { stderr?: string }).stderr ?? '']
          .join(' ')
          .toLowerCase()
        if (text.includes('no_active_sender_terminal')) {
          return await impl(`${command} --from ${await this.fromTerminal()}`, timeoutMs)
        }
        if (text.includes('stable_pane_required')) {
          this.fromHandle = null
          return await impl(`${command} --from ${await this.fromTerminal()}`, timeoutMs)
        }
        throw error
      }
    } finally {
      this.finished += 1
      this.inflight = null
    }
  }

  /** A long-sleeping terminal whose handle serves as the mutation sender identity.
   *  Created through the HOST api so it stays a background terminal — no visible tab pops
   *  open in the user's workspace (a CLI `orca terminal create` would show one); the CLI
   *  path remains the fallback when the host cannot resolve the project's workspace. */
  private async fromTerminal(): Promise<string> {
    if (this.fromHandle) return this.fromHandle
    try {
      const ws = await this.helperWorkspace()
      if (ws) {
        const created = await this.host<{ terminalId: string }>('terminal.create', {
          workspaceId: ws,
          title: 'workflow-view-runner',
          command: 'sleep 86400'
        }, 10_000)
        if (created.terminalId) {
          this.fromHandle = created.terminalId
          return created.terminalId
        }
      }
    } catch {
      // fall through to the CLI path
    }
    const impl = spawnHooks.exec ?? spawn
    const worktree = this.pinPath ? ` --worktree path:${this.pinPath}` : ''
    const out = await impl(
      `orca terminal create${worktree} --title workflow-view-runner --command 'sleep 86400' --json`,
      15_000
    )
    const parsed = parseJson<{ result?: { terminal?: { handle?: string }, terminalId?: string } }>(out)
    const handle = parsed.result?.terminal?.handle ?? parsed.result?.terminalId ?? ''
    if (!handle) {
      throw new BridgeError(`не удалось создать терминал-помощник для --from: ${tail(out, 200)}`, 'no_terminal')
    }
    this.fromHandle = handle
    if (this.pinPath) this.fromByPath[this.pinPath] = handle
    return handle
  }

  /** The pinned project's workspace id from the host's workspace list, if resolvable. */
  private async helperWorkspace(): Promise<string | null> {
    if (!this.pinPath) return null
    const list = await this.host<{ workspaces: Array<{ id: string; path: string }> }>('workspace.list', undefined)
    const ws = list.workspaces.find((w) => w.path === this.pinPath)
      ?? list.workspaces.find((w) => w.path.startsWith(`${this.pinPath}/`))
    return ws?.id ?? null
  }

  /** Closes the helper terminal and forgets it (deactivate, manual reset). */
  async reset(): Promise<void> {
    const handle = this.fromHandle
    this.fromHandle = null
    if (handle) await spawn(`orca terminal close --terminal ${handle} || true`, 5_000).catch(() => undefined)
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

/** Expands a leading ~ against the local home directory — no subprocess needed. */
export function expandHome(path: string): string {
  if (!path.startsWith('~/')) return path
  return `${homedir()}/${path.slice(2)}`
}
