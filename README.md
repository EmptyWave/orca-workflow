# Workflow View

Orca plugin: a sidebar panel for orchestration Runs (steps, decision gates, workers)
plus per-project workflow templates in YAML, portable between projects with one click.
Built in the spirit of [ai-pipeline](https://github.com/hoknie/ai-pipeline) on top of
Orca's own engine (Runs, task DAGs, gates, workers, worktrees).

## What it adds

- **Runs tab** — pick a Run: steps table with statuses, pending gates with
  `approve` / `request-changes` buttons, ready tasks with a `▶ Start` action
  (agent + optional model/effort + worktree selection), live worker list.
  Refresh: 10 s poll + `agent.status.changed`; the status bar shows pending gates.
- **Templates tab** — workflow templates from two sources:
  - **Library** — `workflows/` in this plugin folder (ships `feature-dev`):
    the portable, project-agnostic pipeline.
  - **Project** — `<repo>/.orca/workflows/*.yaml`, versioned with the project.
  - One-click copying in both directions, preview of steps (agents, models,
    checkpoints, deps) and `Raise a Run` — materializes a Run with the task DAG
    and gates from the template.

## Template format

```yaml
id: feature-dev
title: 'Feature: plan → review → dev → review → tests → commit'
steps:
  - { id: plan, agent: claude, specFile: specs/plan.md }
  - { id: plan-review, agent: claude, specFile: specs/plan-review.md, deps: [plan] }
  - id: dev-gate                      # barrier step: no agent, only a checkpoint
    deps: [plan-review]
    checkpoint: { question: 'Plan approved? Start dev?', options: [approve, request-changes] }
  - { id: dev, agent: claude, specFile: specs/dev.md, deps: [dev-gate] }
```

- `agent` + `spec`/`specFile` (+ optional `model`, `effort`) — a materialized task;
  `deps` — the DAG (barrier steps pass dependencies through transitively).
- `checkpoint` — a decision gate on that step; on a barrier step it gates the next
  materialized task.
- Placeholders `{{objective}}`, `{{repo}}`, `{{base_branch}}`, `{{worktree}}` are
  substituted on instantiation.
- `on_reject {goto, max_rounds}` — parsed and validated; automated loops are not
  wired yet (manual retry per round for now).

## How it talks to Orca

Orca has no plugin API for orchestration, so the worker (`src/bridge.ts`) owns one
background terminal ("workflow-view bridge") where it runs
`orca orchestration … --json` commands between unique markers and parses the JSON —
the documented "a trusted-worker can act as the `orca` CLI does" path. Every
interpolated value goes through POSIX single-quote escaping (`shellQuote`);
specs travel as base64. Capabilities: `terminal:send`, `terminal:read`,
`workspace:read`, `agent:read`, `storage:own`, `settings:own`. No network, no
filesystem outside `/tmp` spec files and the template directories.

## Sources

| File | Role |
| --- | --- |
| `src/panel.html` | the UI (HTML panel in a sandboxed frame: inline SVG agent/status icons, aip-style rows) |
| `src/worker.ts` | handlers: snapshot, gates, task start, templates, instantiation jobs |
| `src/bridge.ts` | the terminal CLI bridge (markers, queue, timeouts) |
| `src/yaml.ts` | dependency-free strict YAML subset parser for templates |
| `src/workflow.ts` | template schema validation + placeholder substitution |
| `src/protocol.ts` | panel ↔ worker request/event contract |
| `workflows/` | the portable library (`feature-dev` + `specs/`) |

## Develop

```sh
npx -y -p typescript@5.9 tsc -p .   # typecheck (typings live in .orca/types)
orca plugin test .                  # 26 tests: yaml, workflow, worker (mock bridge), editor
orca plugin check .                 # manifest + editor load; shoot the panel with `plugin shot`
orca plugin validate .
orca plugin dev watch .             # load into Orca and follow logs; Ctrl-C unloads
```

Loading into Orca needs a one-time approval (the plugin runs code):
`orca plugin dev load . --approve <fingerprint>` — Orca prints the exact list it
grants and the fingerprint when you run the same command without `--approve`.
