// Workflow panel: Runs (steps, gates, workers, start) and Templates (library + per-project,
// one-click copy, instantiate into a Run). No DOM and no hooks: state lives in atoms.
import {
  atom,
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  Field,
  Heading,
  IconButton,
  Input,
  KeyValue,
  List,
  ListItem,
  on,
  OrcaNode,
  plugin,
  read,
  read as rd,
  Row,
  Select,
  set,
  Skeleton,
  Spinner,
  Stack,
  Tab,
  Tabs,
  Text,
  type PanelContext
} from 'orca'
import type { WfGate, WfJob, WfRun, WfSnapshot, WfTask, WfTemplate } from './protocol'

// ---- state -----------------------------------------------------------------------------------

/** Mirrors the worker's storage snapshot, so the panel renders instantly from the last refresh. */
const snapshot = atom<WfSnapshot | null>('state.snapshot', null, { persist: 'storage' })
const selectedRun = atom<string | null>('state.selectedRunId', null, { persist: 'storage' })
const runs = atom<WfRun[] | null>(null)
// New key (was 'ui.tab') so the tab choice resets once; Запуски is the landing tab.
const tab = atom<'runs' | 'templates' | 'settings'>('ui.tab2', 'runs', { persist: 'plugin' })
const busy = atom<string | null>(null)
const notice = atom<string | null>(null)

const agent = atom('ui.agent', 'claude', { persist: 'plugin' })
const model = atom('ui.model', '', { persist: 'plugin' })
const effort = atom('ui.effort', '', { persist: 'plugin' })
const worktree = atom('ui.worktree', '', { persist: 'plugin' })

const tplSource = atom<'library' | 'project'>('ui.tplSource', 'project', { persist: 'plugin' })
const tplProjectPath = atom('ui.tplProjectPath', '', { persist: 'plugin' })
const projects = atom<{ repoId: string; name: string; path: string }[]>([])
const currentProject = atom<{ repoId: string; name: string; path: string } | null>(null)
const templates = atom<WfTemplate[] | null>(null)
const selectedTemplate = atom('ui.selectedTemplate', '', { persist: 'plugin' })
const objective = atom('ui.objective', '', { persist: 'plugin' })
const baseBranch = atom('ui.baseBranch', '', { persist: 'plugin' })
const worktreeName = atom('ui.worktreeName', '', { persist: 'plugin' })
const job = atom<WfJob | null>(null)
const workspaces = atom<{ id: string; kind: string; name: string; path: string; branch: string | null }[]>([])

// Settings tab state
const cfgLibrary = atom('cfg.library', '', { persist: 'plugin' })
const cfgRefresh = atom('cfg.refresh', '', { persist: 'plugin' })
const cfgAgent = atom('cfg.agent', '', { persist: 'plugin' })
const bridgeTerminal = atom<string | null>(null)
const cfgSaved = atom<string | null>(null)
const agentSeeded = atom('ui.agentSeeded', false, { persist: 'plugin' })

// ---- actions -----------------------------------------------------------------------------------

async function loadRuns(): Promise<void> {
  const answer = await plugin.request('runs.list', undefined, { timeoutMs: 30_000 })
  set(runs, answer.runs)
  if (!rd(selectedRun) && answer.runs.length > 0) set(selectedRun, answer.runs[0].runId)
}

async function loadState(): Promise<void> {
  const snap = await plugin.request('state.get', { runId: rd(selectedRun) }, { timeoutMs: 60_000 })
  set(snapshot, snap)
}

async function loadWorkspaces(): Promise<void> {
  const answer = await plugin.request('workspaces.list', undefined, { timeoutMs: 15_000 })
  set(workspaces, answer.workspaces)
  if (!rd(worktree)) {
    const wt = answer.workspaces.find((w) => w.kind === 'worktree' && w.name.includes('ycl-104'))
    if (wt) set(worktree, `name:${wt.name}`)
  }
}

async function loadProjects(): Promise<void> {
  try {
    const answer = await plugin.request('projects.list', undefined, { timeoutMs: 30_000 })
    set(projects, answer.projects)
    const current = rd(tplProjectPath)
    if (!current && answer.projects.length > 0) set(tplProjectPath, answer.projects[0].path)
  } catch {
    // The Runs tab works without projects; the Templates tab will show the error.
  }
}

/** The project comes from where the panel is opened: the focused workspace's repo. */
async function loadCurrentProject(): Promise<void> {
  try {
    const answer = await plugin.request('project.current', undefined, { timeoutMs: 30_000 })
    set(currentProject, answer.project)
    if (answer.project) set(tplProjectPath, answer.project.path)
  } catch {
    // Keep the last known project; the panel still works with the cached path.
  }
}

async function loadTemplates(): Promise<void> {
  const answer = await plugin.request(
    'template.list',
    { source: rd(tplSource), projectPath: rd(tplSource) === 'project' ? rd(tplProjectPath) || null : null },
    { timeoutMs: 60_000 }
  )
  set(templates, answer.templates)
  if (answer.templates.length > 0 && !answer.templates.some((t) => t.id === rd(selectedTemplate))) {
    set(selectedTemplate, answer.templates[0].id)
  }
}

async function run<T>(label: string, action: () => Promise<T>): Promise<T | null> {
  if (rd(busy)) return null
  set(busy, label)
  try {
    return await action()
  } catch (error) {
    set(notice, error instanceof Error ? error.message : String(error))
    return null
  } finally {
    set(busy, null)
  }
}

async function resolveGate(gate: WfGate, resolution: string): Promise<void> {
  await run(`гейт ${gate.id.slice(0, 12)}…`, async () => {
    await plugin.request('gate.resolve', { gateId: gate.id, resolution }, { timeoutMs: 30_000 })
    await loadState()
  })
}

async function startTask(task: WfTask): Promise<void> {
  await run(`старт ${task.title}`, async () => {
    if (!rd(worktree)) throw new Error('выбери ворктри для запуска воркера')
    await plugin.request(
      'task.start',
      {
        taskId: task.id,
        agent: rd(agent),
        model: rd(model).trim() === '' ? null : rd(model).trim(),
        effort: rd(effort).trim() === '' ? null : rd(effort).trim(),
        worktree: rd(worktree)
      },
      { timeoutMs: 120_000 }
    )
    await loadState()
  })
}

async function instantiate(): Promise<void> {
  const templatesNow = rd(templates) ?? []
  const template = templatesNow.find((t) => t.id === rd(selectedTemplate))
  if (!template) return
  await run(`поднятие ${template.title}`, async () => {
    if (rd(objective).trim() === '') throw new Error('заполни цель (objective)')
    if (rd(worktreeName).trim() === '') throw new Error('заполни имя ворктри')
    const answer = await plugin.request(
      'template.instantiate',
      {
        source: rd(tplSource),
        projectPath: rd(tplSource) === 'project' ? rd(tplProjectPath) || null : null,
        templateId: template.id,
        objective: rd(objective).trim(),
        baseBranch: rd(baseBranch).trim() === '' ? null : rd(baseBranch).trim(),
        worktreeName: rd(worktreeName).trim(),
        agent: rd(agent)
      },
      { timeoutMs: 30_000 }
    )
    const first = await plugin.request('job.get', { jobId: answer.jobId }, { timeoutMs: 10_000 })
    set(job, first.job)
    for (let i = 0; i < 40; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      const poll = await plugin.request('job.get', { jobId: answer.jobId }, { timeoutMs: 10_000 })
      set(job, poll.job)
      if (!poll.job || poll.job.status !== 'running') break
    }
    const done = rd(job)
    if (done && done.status === 'done' && done.runId) {
      set(selectedRun, done.runId)
      set(tab, 'runs')
      await loadState()
    }
  })
}

async function loadSettings(): Promise<void> {
  try {
    const cfg = await plugin.request('settings.get', undefined, { timeoutMs: 10_000 })
    set(cfgLibrary, cfg.libraryDir)
    set(cfgRefresh, String(cfg.refreshMs))
    set(cfgAgent, cfg.defaultAgent)
    if (!rd(agentSeeded)) {
      set(agent, cfg.defaultAgent)
      set(agentSeeded, true)
    }
    const bridgeInfo = await plugin.request('bridge.info', undefined, { timeoutMs: 10_000 })
    set(bridgeTerminal, bridgeInfo.terminalId)
  } catch {
    // Settings are an extra, not a requirement: the panel works without them.
  }
}

async function saveSettings(): Promise<void> {
  await run('сохранение настроек', async () => {
    const saved = await plugin.request(
      'settings.save',
      {
        libraryDir: rd(cfgLibrary),
        refreshMs: Number(rd(cfgRefresh).trim() || '10000'),
        defaultAgent: rd(cfgAgent)
      },
      { timeoutMs: 10_000 }
    )
    set(cfgLibrary, saved.libraryDir)
    set(cfgRefresh, String(saved.refreshMs))
    set(cfgAgent, saved.defaultAgent)
    set(cfgSaved, new Date().toLocaleTimeString())
  })
}

async function resetBridge(): Promise<void> {
  await run('пересоздание моста', async () => {
    await plugin.request('bridge.reset', undefined, { timeoutMs: 10_000 })
    const bridgeInfo = await plugin.request('bridge.info', undefined, { timeoutMs: 10_000 })
    set(bridgeTerminal, bridgeInfo.terminalId)
  })
}

async function editTemplate(templateId?: string): Promise<void> {
  const id = templateId ?? rd(selectedTemplate)
  await run('открытие редактора', async () => {
    if (rd(tplSource) !== 'project' || !rd(tplProjectPath)) {
      throw new Error('граф-редактор открывает шаблоны проекта — перенеси шаблон в проект кнопкой ниже')
    }
    await plugin.request(
      'template.edit',
      { projectPath: rd(tplProjectPath), templateId: id },
      { timeoutMs: 30_000 }
    )
  })
}

async function copyTemplate(to: 'library' | 'project'): Promise<void> {
  await run('копирование шаблона', async () => {
    await plugin.request(
      'template.copy',
      {
        from: rd(tplSource),
        to,
        templateId: rd(selectedTemplate),
        fromProjectPath: rd(tplSource) === 'project' ? rd(tplProjectPath) || null : null,
        toProjectPath: to === 'project' ? rd(tplProjectPath) || null : null
      },
      { timeoutMs: 30_000 }
    )
    set(notice, `шаблон скопирован (${to === 'library' ? 'в библиотеку' : 'в проект'})`)
  })
}

// ---- helpers -----------------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  pending: 'ожидает',
  ready: 'готов к запуску',
  dispatched: 'работает',
  blocked: 'ждёт гейт',
  queued: 'в очереди',
  succeeded: 'готово',
  failed: 'провал',
  unknown: 'неизвестно'
}

/** Status as the person reads it: a step whose chain runs into a pending gate waits for that
 *  gate, even when the engine says plain "pending" (no gate directly on it). */
type EffectiveStatus = { status: string; gate?: WfGate; via?: string }

function effectiveStatuses(tasks: WfTask[], gates: WfGate[]): Record<string, EffectiveStatus> {
  const pendingGates = gates.filter((g) => g.status === 'pending')
  const gateOnTask = new Map(pendingGates.map((g) => [g.taskId, g]))
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const memo = new Map<string, EffectiveStatus>()
  const calc = (id: string): EffectiveStatus => {
    const hit = memo.get(id)
    if (hit) return hit
    memo.set(id, { status: 'queued' }) // cycle guard
    const t = byId.get(id)
    let out: EffectiveStatus = { status: 'queued' }
    if (!t) out = { status: 'unknown' }
    else if (t.status === 'succeeded' || t.status === 'failed' || t.status === 'dispatched') out = { status: t.status }
    else if (gateOnTask.has(id)) out = { status: 'blocked', gate: gateOnTask.get(id) }
    else {
      const blockers = t.deps.map((dep) => ({ dep, eff: calc(dep) })).filter((d) => d.eff.status === 'blocked')
      if (blockers.length > 0) {
        out = { status: 'blocked', gate: blockers[0].eff.gate, via: byId.get(blockers[0].dep)?.title ?? blockers[0].dep }
      } else if (t.status === 'ready') out = { status: 'ready' }
    }
    memo.set(id, out)
    return out
  }
  for (const t of tasks) calc(t.id)
  return Object.fromEntries(memo)
}

/** A live spinner while a worker runs; every other state shows the row glyph. */
function statusMark(status: string): OrcaNode {
  if (status === 'dispatched') return <Spinner label="работает" labelHidden />
  return null
}

/** Native glyph for the row icon slot: small, theme-tinted, no background tile. */
function statusGlyph(status: string): 'check' | 'play' | 'flag' | 'error' | 'pause' | 'more' {
  if (status === 'succeeded') return 'check'
  if (status === 'ready') return 'play'
  if (status === 'blocked') return 'flag'
  if (status === 'failed') return 'error'
  if (status === 'queued') return 'pause'
  return 'more'
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', () => void loadState()))
  ctx.subscriptions.push(plugin.on('job.progress', (payload) => set(job, payload.job)))
  void loadWorkspaces()
  const projectsReady = loadProjects().then(() => loadCurrentProject())
  void loadRuns().then(() => loadState())
  void loadSettings()
  ctx.subscriptions.push(
    on('workspace.changed', () => {
      void loadCurrentProject().then(() => {
        if (rd(tab) === 'templates') void run('шаблоны', loadTemplates)
      })
    })
  )
  if (rd(tab) === 'templates') void projectsReady.then(() => run('шаблоны', loadTemplates))
}

// ---- renders -----------------------------------------------------------------------------------

function RunsTab() {
  const snap = rd(snapshot)
  const runsNow = rd(runs)
  const runOptions =
    runsNow?.map((r) => ({
      value: r.runId,
      label: `${r.objective.trim().slice(0, 60) || r.runId}`
    })) ?? []
  const gates = (snap?.gates ?? []).filter((g) => g.status === 'pending')
  const effective = effectiveStatuses(snap?.tasks ?? [], snap?.gates ?? [])
  const ready = (snap?.tasks ?? []).filter((t) => t.status === 'ready')
  const workers = snap?.workers ?? []
  return (
    <Stack gap="md">
      {runOptions.length > 0 ? (
        <Select
          label="Run"
          value={rd(selectedRun) ?? undefined}
          options={runOptions}
          onChange={(value) => {
            set(selectedRun, value)
            void run('обновление', loadState)
          }}
        />
      ) : (
        <Skeleton shape="text" lines={1} />
      )}
      {snap?.error ? <Callout tone="danger" title="Ошибка">{snap.error}</Callout> : null}
      {snap?.run ? (
        <>
          {/* No truncate: in a narrow column it collapses the text to one glyph per line. */}
          <Text muted size="xs">
            {snap.run.objective || snap.run.runId}
          </Text>
          <Card title="Шаги">
            <List label="Шаги">
              {(snap.tasks ?? []).map((t) => {
                const eff = effective[t.id] ?? { status: t.status }
                const gateHint =
                  eff.status === 'blocked'
                    ? [
                        eff.gate ? `гейт: «${eff.gate.question.slice(0, 48)}${eff.gate.question.length > 48 ? '…' : ''}»` : null,
                        eff.via ? `(через ${eff.via})` : null
                      ]
                        .filter(Boolean)
                        .join(' ')
                    : null
                return (
                  <ListItem
                    key={t.id}
                    icon={statusGlyph(eff.status)}
                    description={[
                      t.agent,
                      STATUS_TEXT[eff.status] ?? eff.status,
                      gateHint,
                      t.deps.length > 0 ? `после: ${t.deps.map((d) => d.replace('task_', '')).join(', ')}` : null,
                      t.dispatchId ? `воркер ${t.dispatchId.replace('ctx_', '')}` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    <Row gap="xs" align="center">
                      {statusMark(eff.status)}
                      <Text weight="semibold">{t.title || t.id}</Text>
                    </Row>
                  </ListItem>
                )
              })}
            </List>
          </Card>
          {gates.length > 0 ? (
            <Card title={`Гейты (${gates.length})`}>
              <List>
                {gates.map((gate) => (
                  <ListItem key={gate.id} title={gate.taskTitle || gate.taskId} description={gate.question}>
                    <Row gap="xs">
                      {gate.options.map((option) => (
                        <Button
                          key={option}
                          size="sm"
                          tone={option === 'approve' ? 'success' : option.includes('request') ? 'warning' : 'neutral'}
                          onPress={() => void resolveGate(gate, option)}
                        >
                          {option}
                        </Button>
                      ))}
                    </Row>
                  </ListItem>
                ))}
              </List>
            </Card>
          ) : null}
          {ready.length > 0 ? (
            <Card title={`Готовы к запуску (${ready.length})`}>
              <Stack gap="sm">
                <Row gap="xs">
                  <Select
                    label="Агент"
                    labelHidden
                    value={rd(agent)}
                    options={[
                      { value: 'claude', label: 'claude' },
                      { value: 'codex', label: 'codex' },
                      { value: 'zcode', label: 'zcode' }
                    ]}
                    onChange={(value) => set(agent, value)}
                  />
                  <Input
                    label="Модель (опц.)"
                    labelHidden
                    placeholder="модель (опц.)"
                    value={rd(model)}
                    onChange={(value) => set(model, value)}
                  />
                  <Input
                    label="Effort (опц.)"
                    labelHidden
                    placeholder="effort"
                    value={rd(effort)}
                    onChange={(value) => set(effort, value)}
                  />
                </Row>
                <Select
                  label="Ворктри"
                  value={rd(worktree) || undefined}
                  options={rd(workspaces).map((w) => ({ value: `name:${w.name}`, label: w.name }))}
                  onChange={(value) => set(worktree, value)}
                />
                <List>
                  {ready.map((task) => (
                    <ListItem
                      key={task.id}
                      title={task.title || task.id}
                      description={`${task.id} · агент ${rd(agent)}${rd(model) ? ` · ${rd(model)}` : ''} · ${rd(worktree) || 'ворктри?'}`}
                    >
                      <Button size="sm" tone="accent" icon="play" onPress={() => void startTask(task)}>
                        Стартовать
                      </Button>
                    </ListItem>
                  ))}
                </List>
              </Stack>
            </Card>
          ) : null}
          {workers.length > 0 ? (
            <Card title="Воркеры">
              <List>
                {workers.map((w) => (
                  <ListItem
                    key={w.dispatchId}
                    title={`${w.taskTitle ?? w.taskId ?? '?'} · ${w.dispatchId.replace('ctx_', '')}`}
                    description={w.state}
                  />
                ))}
              </List>
            </Card>
          ) : null}
        </>
      ) : (
        <EmptyState
          title="Нет данных"
          description="Выбери Run или подними новый из шаблона на вкладке Templates."
          icon="activity"
        />
      )}
    </Stack>
  )
}

function TemplatesTab() {
  const templatesNow = rd(templates)
  const selected = templatesNow?.find((t) => t.id === rd(selectedTemplate)) ?? null
  const jobNow = rd(job)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Row justify="between" align="center">
          <Select
            label="Источник"
            value={rd(tplSource)}
            options={[
              { value: 'project', label: 'Проект (.orca/workflows)' },
              { value: 'library', label: 'Библиотека' }
            ]}
            onChange={(value) => {
              set(tplSource, value as 'library' | 'project')
              set(templates, null)
              void run('шаблоны', loadTemplates)
            }}
          />
          <IconButton icon="refresh" label="Обновить шаблоны" onPress={() => void run('шаблоны', loadTemplates)} />
        </Row>
        {rd(tplSource) === 'project' ? (
          rd(currentProject) ? (
            <Badge tone="accent">Проект: {rd(currentProject)?.name}</Badge>
          ) : (
            <Text muted size="xs">
              проект по фокусу воркспейса…
            </Text>
          )
        ) : null}
      </Stack>
      {templatesNow === null ? (
        <Skeleton shape="text" lines={3} />
      ) : templatesNow.length === 0 ? (
        <EmptyState
          title="Шаблонов нет"
          description={
            rd(tplSource) === 'library'
              ? 'Библиотека пуста: положи YAML в её каталог или скопируй из проекта.'
              : 'В проекте нет .orca/workflows/*.yaml — скопируй шаблон из библиотеки.'
          }
          icon="folder"
        />
      ) : (
        // A select with the pencil beside it: an interactive control cannot sit inside a
        // pressable list item (Orca refuses that layout), and one template needs no list.
        <Row gap="xs" align="center">
          <Select
            label="Шаблон"
            value={rd(selectedTemplate) || undefined}
            options={templatesNow.map((t) => ({ value: t.id, label: t.error ? `${t.id} (ошибка)` : t.id }))}
            onChange={(value) => set(selectedTemplate, value)}
          />
          <IconButton
            icon="edit"
            label="Редактировать шаблон"
            tooltip="Открыть в граф-редакторе"
            variant="ghost"
            disabled={rd(busy) !== null || (selected?.error ?? null) !== null}
            onPress={() => void editTemplate()}
          />
        </Row>
      )}
      {selected ? (
        <Card>
          <Stack gap="sm">
            <Text weight="semibold">{selected.title}</Text>
            <Text muted size="xs">
              {selected.id} · {selected.file}
            </Text>
            {selected.error ? <Callout tone="danger" title="Шаблон не читается">{selected.error}</Callout> : (
              <List label="Шаги">
                {selected.steps.flatMap((step) => [
                  <ListItem
                    key={step.id}
                    description={[
                      step.specialist ? `специалист ${step.specialist}` : null,
                      step.deps.length > 0 ? `deps: ${step.deps.join(', ')}` : null,
                      step.gate ? `гейт: ${step.gate.question}` : null,
                      step.onReject ? `on_reject → ${step.onReject.goto} (≤${step.onReject.maxRounds})` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    <Row gap="xs" align="center">
                      <Text weight="semibold">{step.id}{step.title ? ` · ${step.title}` : ''}</Text>
                    </Row>
                  </ListItem>,
                  ...(step.sub ?? []).map((child) => (
                    <ListItem
                      key={`${step.id}:${child.id}`}
                      description={child.optional ? 'опциональный: стартует по RUN из отчёта' : undefined}
                    >
                      <Row gap="xs" align="center">
                        <Text muted>↳ {child.id}{child.title ? ` · ${child.title}` : ''}</Text>
                      </Row>
                    </ListItem>
                  ))
                ])}
              </List>
            )}
            <Row gap="xs">
              <Input
                label="Цель (objective)"
                labelHidden
                placeholder="цель — что делаем"
                value={rd(objective)}
                onChange={(value) => set(objective, value)}
              />
            </Row>
            <Row gap="xs">
              <Input
                label="base branch"
                labelHidden
                placeholder="base branch (опц.)"
                value={rd(baseBranch)}
                onChange={(value) => set(baseBranch, value)}
              />
              <Input
                label="имя ворктри"
                labelHidden
                placeholder="имя ворктри"
                value={rd(worktreeName)}
                onChange={(value) => set(worktreeName, value)}
              />
            </Row>
            <Row gap="xs">
              <Button tone="accent" icon="play" disabled={rd(busy) !== null} onPress={() => void instantiate()}>
                Поднять Run
              </Button>
              <Button
                variant="outline"
                icon="copy"
                disabled={rd(busy) !== null}
                onPress={() => void copyTemplate(rd(tplSource) === 'library' ? 'project' : 'library')}
              >
                {rd(tplSource) === 'library' ? 'Скопировать в проект' : 'Сохранить в библиотеку'}
              </Button>
            </Row>
            {jobNow ? (
              <Callout
                tone={jobNow.status === 'failed' ? 'danger' : jobNow.status === 'done' ? 'success' : 'accent'}
                title={`Job ${jobNow.status}: ${jobNow.step}`}
              >
                {jobNow.error ?? jobNow.label}
              </Callout>
            ) : null}
          </Stack>
        </Card>
      ) : null}
    </Stack>
  )
}

function SettingsTab() {
  return (
    <Stack gap="md">
      <Card title="Настройки воркфлоу" description="Каталоги, обновление, агент по умолчанию">
        <Stack gap="sm">
          <Field label="Каталог библиотеки шаблонов" description="YAML-шаблоны переносимых воркфлоу (~ допустим)">
            <Input
              label="Каталог библиотеки"
              labelHidden
              placeholder="~/orca-plugins/workflow-view/workflows"
              value={rd(cfgLibrary)}
              onChange={(value) => set(cfgLibrary, value)}
            />
          </Field>
          <Field label="Интервал обновления, мс" description="Как часто панель перечитывает оркестрацию (2000–120000)">
            <Input
              label="Интервал, мс"
              labelHidden
              placeholder="10000"
              value={rd(cfgRefresh)}
              onChange={(value) => set(cfgRefresh, value)}
            />
          </Field>
          <Field label="Агент по умолчанию" description="Подставляется в форму «Стартовать» (claude, codex, zcode…)">
            <Input
              label="Агент по умолчанию"
              labelHidden
              placeholder="claude"
              value={rd(cfgAgent)}
              onChange={(value) => set(cfgAgent, value)}
            />
          </Field>
          <Row gap="xs">
            <Button tone="accent" icon="check" disabled={rd(busy) !== null} onPress={() => void saveSettings()}>
              Сохранить
            </Button>
            {rd(cfgSaved) ? <Text muted size="xs">сохранено в {rd(cfgSaved)}</Text> : null}
          </Row>
        </Stack>
      </Card>
      <Card title="Мост" description="Служебный терминал в фокусном воркспейсе, через который панель гоняет команды orca CLI">
        <Stack gap="sm">
          <KeyValue
            label="Терминал моста"
            items={[
              {
                label: rd(bridgeTerminal) ?? '—',
                value: rd(bridgeTerminal) ? 'жив, следует за фокусным воркспейсом' : 'не создан',
                code: true
              }
            ]}
          />
          <Button
            variant="outline"
            icon="refresh"
            disabled={rd(busy) !== null}
            onPress={() => void resetBridge()}
          >
            Пересоздать мост
          </Button>
          <Text muted size="xs">
            Orca пускает ввод только в терминалы фокусного воркспейса, поэтому мост живёт в нём и пересоздаётся сам при смене фокуса. Кнопка нужна, если терминал «workflow-view bridge» случайно закрыли.
          </Text>
        </Stack>
      </Card>
    </Stack>
  )
}

export default function Panel() {
  const busyNow = rd(busy)
  const noticeNow = rd(notice)
  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading>Workflow</Heading>
        <Row gap="xs">
          {busyNow ? <Spinner label={busyNow} /> : null}
          <IconButton icon="refresh" label="Обновить" onPress={() => void run('обновление', loadState)} />
        </Row>
      </Row>
      {noticeNow ? (
        <Callout tone="warning" title="Сообщение">
          {noticeNow}
        </Callout>
      ) : null}
      <Tabs
        label="Раздел"
        value={rd(tab)}
        onChange={(value) => {
          set(tab, value as 'runs' | 'templates' | 'settings')
          if (value === 'templates') void run('шаблоны', loadTemplates)
          if (value === 'settings') void run('настройки', loadSettings)
        }}
      >
        <Tab value="runs" label="Запуски" icon="activity" />
        <Tab value="templates" label="Шаблоны" icon="blocks" />
        <Tab value="settings" label="Настройки" icon="settings" />
      </Tabs>
      {rd(tab) === 'runs' ? <RunsTab /> : rd(tab) === 'templates' ? <TemplatesTab /> : <SettingsTab />}
    </Stack>
  )
}
