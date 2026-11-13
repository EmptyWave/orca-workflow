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
  /** Model the step is configured to run on (from the template/instantiate), when known. */
  model: string | null
  /** Failover chain for the step: agents left to try when it fails. */
  fallback: string[]
  /** The owning block step for sub-step tasks (test-api inside tests); null for main steps. */
  parentTaskId: string | null
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
  /** The repo this Run belongs to, when known (set at instantiate time, or bound by hand). */
  projectPath: string | null
}

export type WfSnapshot = {
  at: number
  run: WfRun | null
  tasks: WfTask[]
  gates: WfGate[]
  workers: WfWorker[]
  error: string | null
  /** Auto-pilot state for this run; null when the run was not raised by it. */
  pilot: {
    on: boolean
    stopped: string | null
    actions: number
    /** 'coordinator' — a live agent session leads the run; 'autopilot' — the plugin's code. */
    driver: 'coordinator' | 'autopilot'
    coordinatorTerminal: string | null
  } | null
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
  /** aip-style: reference to a specialist file (`.orca/specialists/<slug>.yaml`). */
  specialist: string | null
  agent: string | null
  model: string | null
  effort: string | null
  /** Failover chain: agents to retry this step on, in order, when it fails. */
  fallback: string[]
  spec: string | null
  /** Path relative to the workflows dir; the editor keeps it, the worker resolves it. */
  specFile: string | null
  deps: string[]
  /** "This step does not start until a human answers." On a barrier step it gates the first
   *  materialized step after it (the explicit multi-target form). */
  gate: { question: string; options: string[] } | null
  onReject: { goto: string; maxRounds: number } | null
  /** Block children (`sub:`): parallel by default; optional ones start only on RUN: request. */
  sub: WfSubStepLike[]
}

export type WfSubStepLike = {
  id: string
  title: string | null
  specialist: string | null
  agent: string | null
  model: string | null
  effort: string | null
  fallback: string[]
  spec: string | null
  specFile: string | null
  deps: string[]
  optional: boolean
}

export type WfSpecialist = {
  slug: string
  agent: string
  model: string | null
  effort: string | null
  fallback: string[]
  spec: string | null
  error: string | null
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
    /** The project the focused workspace belongs to; null when it cannot be resolved. */
    'project.current': {
      output: { project: { repoId: string; name: string; path: string } | null }
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
    /** Open a project template in Orca — the graph editor for .workflow.yaml. */
    'template.edit': {
      input: { projectPath: string; templateId: string }
      output: { opened: true }
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
    /** Specialists of a project (.orca/specialists) — the editor's dropdowns and manager. */
    'workers.list': { input: { projectPath: string }; output: { workers: WfSpecialist[] } }
    /** Create or update one specialist file; slug names the file. */
    'workers.save': {
      input: { projectPath: string; slug: string; agent: string; model: string | null; effort: string | null; spec: string }
      output: { ok: true }
    }
    /** Delete a specialist file; refuses while any project template still references it. */
    'workers.delete': { input: { projectPath: string; slug: string }; output: { ok: true } }
    /** A worker's report for one step (bounded transcript tail). */
    'task.report': { input: { dispatchId?: string; runId?: string; taskId?: string }; output: { report: string } }
    /** Wake the auto-pilot of a stopped run (clears the stop reason). */
    'pilot.resume': { input: { runId: string }; output: { ok: true } }
    /** Retry a Run from a step: resets it and everything downstream; autopilot continues. */
    'task.retry': { input: { runId: string; taskId: string }; output: { ok: true; reset: string[] } }
    /** The graph editor pushes its current document: parsed locally, no bridge involved. */
    'templates.updated': { input: { projectPath: string; yaml: string }; output: { template: WfTemplate } }
    /** Bind a Run to a project (for runs raised before instantiate recorded it). */
    'run.meta.set': { input: { runId: string; projectPath: string }; output: { ok: true } }
    /** Write one panel-UI storage key (html.*), for scripts and shots. */
    'ui.set': { input: { key: string; value: string | number | boolean | null }; output: { ok: true } }
    /** Remember which agent ran each task of a legacy Run (raised before step configs
     *  existed), so the panel can show the agents' icons. */
    'run.agents.set': { input: { runId: string; agents: Record<string, string> }; output: { ok: true } }
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
    /** Posted when the graph editor changed a project template: the panel swaps it in
     *  without touching the bridge. */
    'templates.changed': { projectPath: string; template: WfTemplate }
  }
}
