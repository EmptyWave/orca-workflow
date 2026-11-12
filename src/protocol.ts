// The panel <-> worker contract, declared once: src/panel.tsx and src/worker.ts both read it.
export {}

export type WfStatus = 'pending' | 'ready' | 'dispatched' | 'blocked' | 'succeeded' | 'failed' | 'unknown'

export type WfTask = {
  id: string
  title: string
  status: WfStatus
  deps: string[]
  dispatchId: string | null
  agent: string | null
}

export type WfGate = {
  id: string
  taskId: string
  taskTitle: string
  question: string
  options: string[]
  status: 'pending' | 'resolved'
}

export type WfWorker = {
  dispatchId: string
  taskId: string | null
  taskTitle: string | null
  state: string
}

export type WfRun = {
  runId: string
  objective: string
}

export type WfSnapshot = {
  at: number
  run: WfRun | null
  tasks: WfTask[]
  gates: WfGate[]
  workers: WfWorker[]
  error: string | null
}

export type WfJob = {
  id: string
  kind: 'instantiate'
  label: string
  status: 'running' | 'done' | 'failed'
  step: string
  runId: string | null
  error: string | null
}

export type WfStep = {
  id: string
  title: string | null
  agent: string | null
  model: string | null
  effort: string | null
  spec: string | null
  /** Path relative to the workflows dir; the editor keeps it, the worker resolves it. */
  specFile: string | null
  deps: string[]
  /** "This step does not start until a human answers." On a barrier step it gates the first
   *  materialized step after it (the explicit multi-target form). */
  gate: { question: string; options: string[] } | null
  onReject: { goto: string; maxRounds: number } | null
}

export type WfTemplate = {
  id: string
  title: string
  source: 'library' | 'project'
  sourcePath: string | null
  file: string
  steps: WfStep[]
  error: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** Runs known to Orca (newest first). */
    'runs.list': { output: { runs: WfRun[]; error: string | null } }
    /** Workspaces for worker placement (task start). */
    'workspaces.list': {
      output: { workspaces: { id: string; kind: string; name: string; path: string; branch: string | null }[] }
    }
    /** Projects (repositories) known to Orca; templates bind to these, not to workspaces. */
    'projects.list': {
      output: { projects: { repoId: string; name: string; path: string }[] }
    }
    /** Fresh orchestration snapshot for a Run (runId null = latest runs summary only). */
    'state.get': { input: { runId: string | null }; output: WfSnapshot }
    /** Resolve a pending decision gate. */
    'gate.resolve': { input: { gateId: string; resolution: string }; output: { ok: true } }
    /** Start a ready task's worker; model/effort/worktree optional overrides. */
    'task.start': {
      input: { taskId: string; agent: string; model: string | null; effort: string | null; worktree: string }
      output: { dispatchId: string; state: string }
    }
    /** Workflow templates from the library or a project's .orca/workflows/. */
    'template.list': { input: { source: 'library' | 'project'; projectPath: string | null }; output: { templates: WfTemplate[] } }
    /** Materialize a template into a Run + task DAG + gates; answers a job id at once. */
    'template.instantiate': {
      input: {
        source: 'library' | 'project'
        projectPath: string | null
        templateId: string
        objective: string
        baseBranch: string | null
        worktreeName: string
        agent: string
      }
      output: { jobId: string }
    }
    /** Copy a template file between library and a project's .orca/workflows/. */
    'template.copy': {
      input: { from: 'library' | 'project'; to: 'library' | 'project'; templateId: string; fromProjectPath: string | null; toProjectPath: string | null }
      output: { ok: true }
    }
    /** Jobs (long operations) keyed by id. */
    'job.get': { input: { jobId: string }; output: { job: WfJob | null } }
    /** Plugin settings the Settings tab shows and saves. */
    'settings.get': {
      output: { libraryDir: string; refreshMs: number; defaultAgent: string }
    }
    'settings.save': {
      input: { libraryDir: string; refreshMs: number; defaultAgent: string }
      output: { libraryDir: string; refreshMs: number; defaultAgent: string }
    }
    /** Drops the stored bridge terminal; the next command recreates it. */
    'bridge.reset': { output: { ok: true } }
    /** Bridge state for the Settings tab. */
    'bridge.info': { output: { terminalId: string | null } }
  }
  interface PluginPanelEvents {
    /** Posted after a snapshot refresh changed something the panel shows. */
    'state.changed': { at: number; pendingGates: number; readyTasks: number }
    /** Posted on instantiate job progress. */
    'job.progress': { job: WfJob }
  }
}
