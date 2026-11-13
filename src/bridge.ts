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
        reject(new BridgeError(`${String(error.message).slice(0, 260)}${stderr ? ' | ' + tail(stderr, 200) : ''}`, 'cli_error'))
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

  constructor(_orca: OrcaWorkerApi) {}

  stats(): { terminal: string | null; counter: number; sent: number; finished: number; inflight: typeof this.inflight } {
    return { terminal: this.fromHandle, counter: 0, sent: this.sent, finished: this.finished, inflight: this.inflight }
  }

  /** The helper terminal lives in the project's own workspace when one is known. */
  pin(projectPath: string | null): void {
    if (projectPath !== this.pinPath) this.fromHandle = null
    this.pinPath = projectPath
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
        const text = error instanceof Error ? error.message : String(error)
        if (/no_active_sender_terminal/.test(text)) {
          return await impl(`${command} --from ${await this.fromTerminal()}`, timeoutMs)
        }
        if (/stable_pane_required/.test(text)) {
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

  /** A long-sleeping terminal in the project's workspace whose handle serves as the
   *  mutation sender identity; created through the CLI, so no focus is involved. */
  private async fromTerminal(): Promise<string> {
    if (this.fromHandle) return this.fromHandle
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
    return handle
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
