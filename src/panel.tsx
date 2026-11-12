// Workflow panel: Runs (steps, gates, workers, start) and Templates (library + per-project,
// one-click copy, instantiate into a Run). No DOM and no hooks: state lives in atoms.
import {
  atom,
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
  plugin,
  read,
  read as rd,
  Row,
  Select,
  set,
  Skeleton,
  Spinner,
  Stack,
  Table,
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
const tab = atom<'runs' | 'templates' | 'settings'>('ui.tab', 'runs', { persist: 'plugin' })
const busy = atom<string | null>(null)
const notice = atom<string | null>(null)

const agent = atom('ui.agent', 'claude', { persist: 'plugin' })
const model = atom('ui.model', '', { persist: 'plugin' })
const effort = atom('ui.effort', '', { persist: 'plugin' })
const worktree = atom('ui.worktree', '', { persist: 'plugin' })

const tplSource = atom<'library' | 'project'>('ui.tplSource', 'library', { persist: 'plugin' })
const tplWorkspacePath = atom('ui.tplWorkspacePath', '', { persist: 'plugin' })
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
  if (rd(tplSource) === 'project' && !rd(tplWorkspacePath)) {
    const wt = answer.workspaces.find((w) => w.kind === 'worktree' && w.path.includes('biz.erp'))
    if (wt) set(tplWorkspacePath, wt.path)
  }
}

async function loadTemplates(): Promise<void> {
  const answer = await plugin.request(
    'template.list',
    { source: rd(tplSource), workspacePath: rd(tplSource) === 'project' ? rd(tplWorkspacePath) || null : null },
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
        workspacePath: rd(tplSource) === 'project' ? rd(tplWorkspacePath) || null : null,
        templateId: template.id,
        objective: rd(objective).trim(),
        repoPath: rd(tplSource) === 'project' ? rd(tplWorkspacePath) || null : null,
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

async function copyTemplate(to: 'library' | 'project'): Promise<void> {
  await run('копирование шаблона', async () => {
    await plugin.request(
      'template.copy',
      {
        from: rd(tplSource),
        to,
        templateId: rd(selectedTemplate),
        fromWorkspacePath: rd(tplSource) === 'project' ? rd(tplWorkspacePath) || null : null,
        toWorkspacePath: to === 'project' ? rd(tplWorkspacePath) || null : null
      },
      { timeoutMs: 30_000 }
    )
    set(notice, `шаблон скопирован (${to === 'library' ? 'в библиотеку' : 'в проект'})`)
  })
}

// ---- helpers -----------------------------------------------------------------------------------

const STATUS_MARK: Record<string, string> = {
  pending: '· pending',
  ready: '▶ ready',
  dispatched: '● работает',
  blocked: '⏳ гейт',
  succeeded: '✓ готово',
  failed: '✗ провал',
  unknown: '? неизвестно'
}

function statusTone(status: string): 'neutral' | 'accent' | 'warning' | 'success' | 'danger' {
  if (status === 'blocked') return 'warning'
  if (status === 'dispatched' || status === 'ready') return 'accent'
  if (status === 'succeeded') return 'success'
  if (status === 'failed') return 'danger'
  return 'neutral'
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('state.changed', () => void loadState()))
  ctx.subscriptions.push(plugin.on('job.progress', (payload) => set(job, payload.job)))
  void loadWorkspaces()
  void loadRuns().then(() => loadState())
  void loadSettings()
  if (rd(tab) === 'templates') void loadTemplates()
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
          <Text muted size="xs" truncate>
            {snap.run.objective || snap.run.runId}
          </Text>
          <Card title="Шаги">
            <Table
              label="Шаги"
              columns={[
                { key: 'title', label: 'Шаг', width: 'md' },
                { key: 'status', label: 'Статус' },
                { key: 'deps', label: 'Зависимости', hideBelow: 'sm' },
                { key: 'worker', label: 'Воркер', hideBelow: 'md' }
              ]}
              rows={(snap.tasks ?? []).map((t) => ({
                key: t.id,
                cells: {
                  title: t.title || t.id,
                  status: STATUS_MARK[t.status] ?? t.status,
                  deps: t.deps.length === 0 ? '—' : t.deps.map((d) => d.replace('task_', '')).join(', '),
                  worker: t.dispatchId ? t.dispatchId.replace('ctx_', '') : '—'
                }
              }))}
              emptyText="задач нет"
            />
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
      <Row gap="xs">
        <Select
          label="Источник"
          value={rd(tplSource)}
          options={[
            { value: 'library', label: 'Библиотека' },
            { value: 'project', label: 'Проект (.orca/workflows)' }
          ]}
          onChange={(value) => {
            set(tplSource, value as 'library' | 'project')
            set(templates, null)
            void run('шаблоны', loadTemplates)
          }}
        />
        {rd(tplSource) === 'project' ? (
          <Select
            label="Workspace"
            value={rd(tplWorkspacePath) || undefined}
            options={rd(workspaces)
              .filter((w) => w.kind === 'worktree')
              .map((w) => ({ value: w.path, label: w.name }))}
            onChange={(value) => {
              set(tplWorkspacePath, value)
              void run('шаблоны', loadTemplates)
            }}
          />
        ) : null}
        <IconButton icon="refresh" label="Обновить шаблоны" onPress={() => void run('шаблоны', loadTemplates)} />
      </Row>
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
        <List label="Шаблоны">
          {templatesNow.map((t) => (
            <ListItem
              key={t.id}
              title={t.title}
              description={t.error ? t.error : `${t.id} · ${t.steps.length} шагов`}
              current={t.id === rd(selectedTemplate)}
              onPress={() => set(selectedTemplate, t.id)}
            />
          ))}
        </List>
      )}
      {selected ? (
        <Card title={selected.title} description={`${selected.id} · ${selected.file}`}>
          <Stack gap="sm">
            {selected.error ? <Callout tone="danger" title="Шаблон не читается">{selected.error}</Callout> : (
              <List label="Шаги">
                {selected.steps.map((step) => (
                  <ListItem
                    key={step.id}
                    title={`${step.id}${step.title ? ` · ${step.title}` : ''}`}
                    description={[
                      step.agent ? `агент ${step.agent}` : 'барьер',
                      step.model ? `модель ${step.model}${step.effort ? ` · ${step.effort}` : ''}` : null,
                      step.deps.length > 0 ? `deps: ${step.deps.join(', ')}` : null,
                      step.checkpoint ? `гейт: ${step.checkpoint.question}` : null,
                      step.onReject ? `on_reject → ${step.onReject.goto} (≤${step.onReject.maxRounds})` : null
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                ))}
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
      <Card title="Мост" description="Служебный терминал, через который панель гоняет команды orca CLI">
        <Stack gap="sm">
          <KeyValue
            label="Терминал моста"
            items={[
              {
                label: rd(bridgeTerminal) ?? '—',
                value: rd(bridgeTerminal) ? 'сохранён в storage' : 'ещё не создан',
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
            Нужен, если терминал «workflow-view bridge» случайно закрыли: сброс забывает сохранённый handle, а следующий запрос создаст терминал заново.
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
          if (value === 'templates' && rd(templates) === null) void run('шаблоны', loadTemplates)
          if (value === 'settings') void run('настройки', loadSettings)
        }}
      >
        <Tab value="runs" label="Runs" icon="activity" />
        <Tab value="templates" label="Templates" icon="blocks" />
        <Tab value="settings" label="Настройки" icon="settings" />
      </Tabs>
      {rd(tab) === 'runs' ? <RunsTab /> : rd(tab) === 'templates' ? <TemplatesTab /> : <SettingsTab />}
    </Stack>
  )
}
