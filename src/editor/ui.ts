// The graph editor's DOM/SVG glue: canvas with draggable nodes, ports to connect deps,
// an inspector (including the gate section), toolbar and YAML preview. Vanilla, no libraries.
import type { EditorSession } from 'orca/frame'
import type { WfStep } from '../protocol'
import { autoLayout, emit, NODE_H, NODE_W, SUB_GAP_X, validate, type WfGraph } from './core'

const STYLE = `
.wfv{display:flex;flex-direction:column;height:100vh;color:var(--orca-foreground);background:var(--orca-background);font:13px -apple-system,system-ui,sans-serif}
.wfv-toolbar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--orca-border);background:var(--orca-card)}
.wfv-toolbar button{font:600 12px inherit;padding:4px 11px;border:1px solid var(--orca-border);border-radius:6px;background:var(--orca-muted);color:var(--orca-foreground);cursor:pointer}
.wfv-toolbar button:hover{background:var(--orca-border)}
.wfv-toolbar button.primary{background:var(--orca-accent);border-color:var(--orca-accent);color:var(--orca-accent-foreground,#fff)}
.wfv-status{margin-left:auto;font-size:12px}
.wfv-status.bad{color:var(--orca-destructive)}
.wfv-status.good{color:var(--orca-foreground);opacity:.7}
.wfv-body{flex:1;display:flex;min-height:0;position:relative}
.wfv-canvas{flex:1;cursor:grab;overflow:hidden}
.wfv-canvas.connecting{cursor:crosshair}
.wfv-canvas svg{display:block;width:100%;height:100%}
.wfv-node rect{fill:var(--orca-card);stroke:var(--orca-border);stroke-width:1.5;rx:8}
.wfv-node.barrier rect{stroke-dasharray:5 4;fill:var(--orca-muted)}
.wfv-node.selected rect{stroke:var(--orca-accent);stroke-width:2}
.wfv-node text{fill:var(--orca-foreground);user-select:none;pointer-events:none}
.wfv-node.subblock rect{stroke-dasharray:4 3;fill:var(--orca-card)}
.wfv-edge.sub-edge{stroke-dasharray:4 3}
.wfv-edge.reject-edge{stroke:var(--orca-warning, #d29922);stroke-dasharray:2 4}
.wfv-edge.reject-edge.selected{stroke-width:2.4}
.wfv-node .sub{fill:var(--orca-muted-foreground);font-size:11px}
.wfv-port{fill:var(--orca-muted);stroke:var(--orca-border);cursor:crosshair}
.wfv-port:hover{fill:var(--orca-accent)}
.wfv-edge{fill:none;stroke:var(--orca-muted-foreground);stroke-width:1.6;cursor:pointer}
.wfv-edge:hover,.wfv-edge.selected{stroke:var(--orca-accent);stroke-width:2.4}
.wfv-tmp{fill:none;stroke:var(--orca-accent);stroke-width:1.6;stroke-dasharray:4 3}
.wfv-badge{fill:var(--orca-warning)}
.wfv-inspector{width:270px;border-left:1px solid var(--orca-border);background:var(--orca-card);padding:10px;overflow:auto;box-sizing:border-box}
.wfv-inspector label{display:block;margin:8px 0 2px;font-size:11px;color:var(--orca-muted-foreground)}
.wfv-inspector input[type=text],.wfv-inspector textarea{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);font:12px ui-monospace,monospace}
.wfv-inspector textarea{min-height:70px;resize:vertical}
.wfv-inspector .row{display:flex;gap:6px;align-items:center}
.wfv-inspector .del{margin-top:14px;border-color:var(--orca-destructive);color:var(--orca-destructive);background:none;padding:4px 10px;border-radius:var(--orca-radius);cursor:pointer;font:12px inherit}
.wfv-spmgr{position:fixed;top:42px;right:0;bottom:0;width:330px;background:var(--orca-card);border-left:1px solid var(--orca-border);box-shadow:-6px 0 18px rgba(0,0,0,.25);z-index:40;padding:12px;overflow:auto;box-sizing:border-box;color:var(--orca-foreground);font:12.5px -apple-system,system-ui,sans-serif}
.wfv-spmgr h3{margin:0 0 8px;font-size:13px}
.wfv-spmgr .sp-row{display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--orca-border);font-size:12px;color:var(--orca-foreground)}
.wfv-spmgr .sp-row:hover{background:var(--orca-muted)}
.wfv-spmgr .sp-form{margin:2px 0 10px;padding:8px 8px 10px 10px;border-left:2px solid var(--orca-accent);background:var(--orca-background);border-radius:4px}
.wfv-spmgr .swarm-row{display:flex;align-items:center;gap:14px;margin:2px 0 8px;flex-wrap:wrap}
.wfv-spmgr .swarm-row label{display:inline-flex;align-items:center;gap:5px;margin:0;font-size:11.5px;color:var(--orca-foreground);white-space:nowrap}
.wfv-spmgr .swarm-row input[type='checkbox']{width:auto;margin:0}
.wfv-spmgr .swarm-row input[type='number']{width:72px;flex:0 0 72px}
.wfv-spmgr .sp-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfv-spmgr button{font:11.5px inherit;padding:2px 8px;border:1px solid var(--orca-border);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);cursor:pointer}
.wfv-spmgr button.icon{padding:3px 5px;line-height:0;display:inline-flex;align-items:center;justify-content:center;color:var(--orca-muted-foreground)}
.wfv-spmgr button.icon:hover{color:var(--orca-foreground)}
.wfv-spmgr button.icon.armed{color:var(--orca-destructive,#f85149);border-color:var(--orca-destructive,#f85149)}
.wfv-spmgr textarea{width:100%;min-height:120px;box-sizing:border-box;padding:4px 6px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);font:11.5px ui-monospace,monospace;resize:vertical}
.wfv-spmgr label{display:block;margin:8px 0 2px;font-size:11px;color:var(--orca-muted-foreground)}
.wfv-spmgr input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);font:12px ui-monospace,monospace}
.wfv-spmgr .err{margin-top:8px;color:var(--orca-destructive);font-size:11.5px;white-space:pre-wrap}
.wfv-combo{position:relative}
.wfv-combo-list{position:absolute;left:0;right:0;top:100%;z-index:30;max-height:170px;overflow:auto;background:var(--orca-card);border:1px solid var(--orca-border);border-radius:var(--orca-radius);box-shadow:0 6px 16px rgba(0,0,0,.35);display:none;margin-top:2px}
.wfv-combo.open .wfv-combo-list{display:block}
.wfv-combo-list .opt{padding:4px 8px;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wfv-combo-list .opt:hover,.wfv-combo-list .opt.active{background:var(--orca-muted)}
.wfv-yaml{position:absolute;inset:0;margin:0;padding:12px;overflow:auto;background:var(--orca-background);font:12px ui-monospace,monospace;white-space:pre;border:0}
.wfv-error{padding:8px 12px;background:var(--orca-destructive);color:var(--orca-destructive-foreground);font-size:12px}
.wfv-hint{padding:4px 12px;font-size:11px;color:var(--orca-muted-foreground)}
.wfv-head{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--orca-border);background:var(--orca-card)}
.wfv-head input{font:13px inherit;padding:3px 8px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground)}
.wfv-head .title{flex:1;font-weight:600}
.wfv-head .ident{width:150px;font-family:ui-monospace,monospace;font-size:12px}
.wfv-head .cap{font-size:11px;color:var(--orca-muted-foreground)}
`

type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'sub'; parentId: string; id: string }
  | { kind: 'edge'; from: string; to: string }
  | { kind: 'reject'; from: string }
  | null

export function createEditor(doc: EditorSession<WfGraph>): void {
  const style = document.createElement('style')
  style.textContent = STYLE
  document.head.append(style)
  document.body.style.margin = '0'

  const root = document.createElement('div')
  root.className = 'wfv'
  root.innerHTML =
    '<div class="wfv-toolbar"></div>' +
    '<div class="wfv-head"></div>' +
    '<div class="wfv-error" hidden></div>' +
    '<div class="wfv-body"><div class="wfv-canvas"><svg><defs>' +
    '<marker id="wfv-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="var(--orca-muted-foreground)"/></marker>' +
    '<marker id="wfv-arrow-reject" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
    '<path d="M0,0 L10,5 L0,10 z" fill="var(--orca-warning, #d29922)"/></marker></defs>' +
    '<g class="wfv-viewport"></g></svg></div>' +
    '<aside class="wfv-inspector"></aside></div>'
  document.body.append(root)

  const toolbar = root.querySelector<HTMLElement>('.wfv-toolbar') as HTMLElement
  const errorBar = root.querySelector<HTMLElement>('.wfv-error') as HTMLElement
  const canvas = root.querySelector<HTMLElement>('.wfv-canvas') as HTMLElement
  const svg = root.querySelector('svg') as SVGSVGElement
  const viewport = root.querySelector('g.wfv-viewport') as SVGGElement
  const inspector = root.querySelector<HTMLElement>('.wfv-inspector') as HTMLElement

  let graph: WfGraph = doc.value
  let selection: Selection = null
  let connectFrom: string | null = null
  let tmpEdge: { x1: number; y1: number; x2: number; y2: number } | null = null
  const view = { x: 20, y: 20, k: 1 }

  // ---- toolbar -------------------------------------------------------------------------
  // Reasoning-effort levels per agent (Orca's own pickers: Claude adds xhigh/max, Codex minimal).
  const EFFORTS: Record<string, string[]> = {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['minimal', 'low', 'medium', 'high']
  }
  const effortsFor = (agent: string | null | undefined): string[] => {
    const a = (agent ?? '').toLowerCase()
    if (a.startsWith('claude')) return EFFORTS.claude
    if (a.startsWith('codex')) return EFFORTS.codex
    return ['low', 'medium', 'high']
  }

  // ---- project workers: dropdown data + the manager panel -------------------------
  type Sp = { slug: string; agent: string; model: string | null; effort: string | null; swarm: { enabled: boolean; limit: number | null } | null; spec: string | null; error: string | null }
  let specialists: Sp[] = []
  /** Модели из каталога Орки (что реально резолвит прокси) — подсказки выпадашек model. */
  let catalogModels: string[] = []
  const modelOptions = (): string[] => [...new Set([...catalogModels, ...specialists.map((sp) => sp.model).filter((m): m is string => Boolean(m))])]
  async function loadCatalogModels(): Promise<void> {
    try {
      const answer = await request('models.list', undefined, 15000) as { models?: Array<{ id?: string }> }
      catalogModels = (answer.models ?? []).map((m) => m.id ?? '').filter((x) => x !== '')
    } catch {
      catalogModels = []
    }
  }
  let projectPath: string | null = null
  /** Ошибка последней загрузки карточек — показываем её в менеджере, а не пустоту. */
  let spError: string | null = null
  const request = <T>(name: string, input: unknown, timeoutMs = 30000): Promise<T> =>
    orca.plugin.request(name, input as never, { timeoutMs }) as Promise<T>
  async function loadSpecialists(): Promise<void> {
    spError = null
    try {
      const current = await request<{ project: { path: string } | null }>('project.current', undefined)
      projectPath = current?.project?.path ?? null
    } catch {
      projectPath = null
    }
    try {
      const slugs = graph.steps.flatMap((st) => [st.specialist ?? '', ...(st.sub ?? []).map((c) => c.specialist ?? '')]).filter(Boolean)
      const answer = await request<{ workers: Sp[]; projectPath: string | null }>('workers.listSmart', { slugs }, 60000)
      specialists = answer.workers ?? []
      if (answer.projectPath) projectPath = answer.projectPath
      if (specialists.length === 0) spError = `карточки не нашлись по слагам шаблона (${slugs.join(', ') || 'шаблон без воркеров'})`
    } catch (e) {
      specialists = []
      spError = 'воркеры не загрузились: ' + (e instanceof Error ? e.message : String(e)) +
        ' — если редактор был открыт до обновления плагина, закрой вкладку и открой файл заново'
    }
    renderInspector()
  }
  void loadSpecialists()

  const buttons: Array<[string, () => void, 'primary' | 'tool']> = [
    ['+ Шаг', () => addStep(true), 'primary'],
    ['+ Барьер', () => addStep(false), 'primary'],
    ['Автораскладка', () => { graph.layout = autoLayout(graph); push() }, 'tool'],
    ['YAML', () => toggleYaml(), 'tool'],
    ['Воркеры', () => toggleSpecialists(), 'tool']
  ]
  for (const [label, onClick, kind] of buttons) {
    const b = document.createElement('button')
    b.className = kind
    b.textContent = label
    b.addEventListener('click', onClick)
    toolbar.append(b)
  }
  const status = document.createElement('span')
  status.className = 'wfv-status'
  toolbar.append(status)

  // The workflow header: title and id live with the graph, edited in place.
  const head = root.querySelector<HTMLElement>('.wfv-head') as HTMLElement
  const titleCap = document.createElement('span')
  titleCap.className = 'cap'
  titleCap.textContent = 'название'
  const titleInput = document.createElement('input')
  titleInput.className = 'title'
  titleInput.placeholder = 'Название воркфлоу'
  titleInput.addEventListener('input', () => {
    graph.title = titleInput.value
    push()
  })
  const idCap = document.createElement('span')
  idCap.className = 'cap'
  idCap.textContent = 'id'
  const idInput = document.createElement('input')
  idInput.className = 'ident'
  idInput.addEventListener('input', () => {
    const clean = idInput.value.trim().replace(/[^a-z0-9-]/g, '-')
    if (clean === graph.id) return
    graph.id = clean
    push()
  })
  head.append(titleCap, titleInput, idCap, idInput)
  function syncHead(): void {
    if (document.activeElement !== titleInput) titleInput.value = graph.title
    if (document.activeElement !== idInput) idInput.value = graph.id
  }
  let yamlPre: HTMLPreElement | null = null
  function toggleYaml(): void {
    if (yamlPre) {
      yamlPre.remove()
      yamlPre = null
      return
    }
    yamlPre = document.createElement('pre')
    yamlPre.className = 'wfv-yaml'
    yamlPre.textContent = emit(graph)
    ;(root.querySelector('.wfv-body') as HTMLElement).append(yamlPre)
  }

  // ---- specialists manager --------------------------------------------------------------
  let spPanel: HTMLElement | null = null
  function toggleSpecialists(): void {
    if (spPanel) {
      spPanel.remove()
      spPanel = null
      return
    }
    spPanel = document.createElement('div')
    spPanel.className = 'wfv-spmgr'
    ;(root.parentElement ?? root).append(spPanel)
    void renderSpManager()
  }
  async function renderSpManager(): Promise<void> {
    const panel = spPanel
    if (!panel) return
    // Перезагружаем карточки не только без проекта, но и когда прошлый заход не удался:
    // редактор, открытый до обновления плагина, живёт с мёртвым каналом и пустым списком.
    if (!projectPath || specialists.length === 0) await loadSpecialists()
    panel.innerHTML = ''
    // Шапка flex'ом: заголовок и крестик закрытия каждый в своей ячейке — флоат
    // наезжал на первую строку списка.
    const head = document.createElement('div')
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin:0 0 10px'
    const h = document.createElement('h3')
    h.style.cssText = 'margin:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
    h.textContent = `Воркеры — ${projectPath ? projectPath.split('/').pop() : 'проект не определён'}`
    head.append(h)
    const close = document.createElement('button')
    close.className = 'icon'
    close.title = 'закрыть панель'
    close.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    close.addEventListener('click', () => { if (spPanel) { spPanel.remove(); spPanel = null } })
    head.append(close)
    panel.append(head)
    if (spError) {
      const err = document.createElement('div')
      err.className = 'err'
      err.textContent = spError
      panel.append(err)
      const retry = document.createElement('button')
      retry.textContent = 'повторить загрузку'
      retry.style.margin = '6px 0'
      retry.addEventListener('click', () => { void loadSpecialists().then(() => void renderSpManager()) })
      panel.append(retry)
    }
    if (!projectPath) {
      const note = document.createElement('div')
      note.className = 'err'
      note.textContent = 'Проект не определён: открой workspace репозитория в Orca и попробуй снова.'
      panel.append(note)
      return
    }
    for (const sp of specialists) {
      const row = document.createElement('div')
      row.className = 'sp-row'
      const info = document.createElement('span')
      info.className = 'grow'
      info.textContent = `${sp.slug} — ${sp.agent}${sp.model ? ' · ' + sp.model : ''}`
      info.title = sp.spec ?? ''
      // Клик по пункту разворачивает/сворачивает его форму (карандаш — то же самое)
      const toggleRowForm = (): void => {
        if (inlineForm && row.nextElementSibling === inlineForm) {
          closeInlineForm()
          return
        }
        closeInlineForm()
        const f = buildWorkerForm(sp)
        f.classList.add('sp-form')
        row.after(f)
        inlineForm = f
      }
      row.style.cursor = 'pointer'
      row.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).closest('button')) return // кнопки строки — свои дела
        toggleRowForm()
      })
      const edit = document.createElement('button')
      edit.className = 'icon'
      edit.title = 'изменить'
      edit.innerHTML = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M11.3 2.1l2.6 2.6-8.3 8.3-3.1.5.5-3.1zM10 3.4l2.6 2.6" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>'
      edit.addEventListener('click', (e) => { e.stopPropagation(); toggleRowForm() })
      const rm = document.createElement('button')
      rm.className = 'icon danger'
      rm.title = 'удалить'
      rm.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      let armed = false
      rm.addEventListener('click', async () => {
        if (!armed) {
          armed = true
          rm.classList.add('armed')
          rm.title = 'точно? нажми ещё раз'
          setTimeout(() => { armed = false; rm.classList.remove('armed'); rm.title = 'удалить' }, 2500)
          return
        }
        panel.setAttribute('data-busy', '1')
        try {
          await request('workers.delete', { projectPath, slug: sp.slug }, 60000)
          await loadSpecialists()
          await renderSpManager()
        } catch (error) {
          await renderSpManager()
          const err = document.createElement('div')
          err.className = 'err'
          err.textContent = String((error as Error)?.message ?? error)
          spPanel?.append(err)
        }
      })
      row.append(info, edit, rm)
      panel.append(row)
    }
    const add = document.createElement('button')
    add.textContent = '+ Новый воркер'
    add.style.marginTop = '8px'
    add.addEventListener('click', () => {
      closeInlineForm()
      const f = buildWorkerForm('new')
      f.classList.add('sp-form')
      add.after(f)
      inlineForm = f
    })
    panel.append(add)
  }

  /** Подсказка формы для карточек координатора; обычному воркеру нечего подсказывать. */
  function coordinatorNote(slug: string): string | null {
    if (slug === 'coordinator') {
      return 'Общая карточка координатора — для флоу без своей карточки coordinator-<id>. Агент, модель и effort уходят в запуск; текст агенту не отправляется: правила координатора зашиты в бриф. Специфику флоу пиши в карточку coordinator-<id шаблона>.'
    }
    if (slug.startsWith('coordinator-')) {
      return `Координатор флоу «${slug.slice('coordinator-'.length)}»: берётся для шаблона с этим id и заменяет общую карточку целиком (агент, модель, effort — свои). Текст карточки вкладывается в бриф как роль и специфика флоу.`
    }
    return null
  }

  /** Открытая инлайн-форма — одна одновременно; новая закрывает предыдущую. */
  let inlineForm: HTMLElement | null = null
  function closeInlineForm(): void {
    inlineForm?.remove()
    inlineForm = null
  }

  /** Форма карточки воркера: открывается под строкой списка, сохранение/отмена её убирают. */
  function buildWorkerForm(editing: Sp | 'new'): HTMLElement {
    // the create/edit form
    const form = document.createElement('div')
    const input = (label: string, value: string): HTMLInputElement => {
      const l = document.createElement('label')
      l.textContent = label
      const el = document.createElement('input')
      el.value = value
      form.append(l, el)
      return el
    }
    const slugEl = input('slug (имя файла)', editing === 'new' ? '' : editing.slug)
    slugEl.disabled = editing !== 'new' // the slug names the file; renaming would orphan references
    const agentEl = input('агент (claude, codex, zcode…)', editing === 'new' ? 'claude' : editing.agent)
    // Карточки координатора живут по соглашению имени — говорим об этом там, где имя вводят.
    const coordNote = document.createElement('div')
    coordNote.className = 'wfv-hint'
    coordNote.style.lineHeight = '1.5'
    const syncCoordNote = (): void => {
      coordNote.textContent = coordinatorNote(slugEl.value.trim()) ?? ''
    }
    slugEl.addEventListener('input', syncCoordNote)
    syncCoordNote()
    form.append(coordNote)
    void loadCatalogModels()
    const modelWrap = comboField('модель (опц.) — из каталога Орки', editing === 'new' || !editing ? '' : editing.model ?? '', modelOptions, () => undefined)
    const modelEl = modelWrap.querySelector('input') as HTMLInputElement
    form.append(modelWrap)
    const effortWrap = comboField('effort (опц.)', editing === 'new' || !editing ? '' : editing.effort ?? '', () => effortsFor(agentEl.value), () => undefined)
    const effortEl = effortWrap.querySelector('input') as HTMLInputElement
    form.append(effortWrap)
    const swarmL = document.createElement('label')
    swarmL.textContent = 'рой — параллельные инстансы этого воркера'
    form.append(swarmL)
    const swarmRow = document.createElement('div')
    swarmRow.className = 'swarm-row'
    const swarmEnableL = document.createElement('label')
    const swarmEnable = document.createElement('input')
    swarmEnable.type = 'checkbox'
    swarmEnable.checked = Boolean(editing && editing !== 'new' && editing.swarm?.enabled)
    swarmEnableL.append(swarmEnable, document.createTextNode(' enable'))
    const swarmMaxL = document.createElement('label')
    swarmMaxL.append(document.createTextNode('limit '))
    const swarmMax = document.createElement('input')
    swarmMax.type = 'number'
    swarmMax.min = '1'
    swarmMax.title = 'пусто = без лимита'
    swarmMax.value = editing && editing !== 'new' && editing.swarm?.limit ? String(editing.swarm.limit) : ''
    swarmMaxL.append(swarmMax)
    swarmRow.append(swarmEnableL, swarmMaxL)
    form.append(swarmRow)
    const specL = document.createElement('label')
    specL.textContent = 'prompt — промпт воркера'
    form.append(specL)
    const specEl = document.createElement('textarea')
    specEl.value = editing === 'new' || !editing ? '' : editing.spec ?? ''
    form.append(specEl)
    const errBox = document.createElement('div')
    errBox.className = 'err'
    const save = document.createElement('button')
    save.textContent = 'Сохранить'
    save.style.marginRight = '6px'
    save.addEventListener('click', async () => {
      errBox.textContent = ''
      save.setAttribute('disabled', '1')
      try {
        await request(
          'workers.save',
          {
            projectPath,
            slug: slugEl.value,
            agent: agentEl.value,
            model: modelEl.value.trim() === '' ? null : modelEl.value.trim(),
            effort: effortEl.value.trim() === '' ? null : effortEl.value.trim(),
            swarm: { enable: swarmEnable.checked, limit: swarmMax.value.trim() === '' ? null : Number(swarmMax.value) },
            spec: specEl.value
          },
          60000
        )
        await loadSpecialists()
        await renderSpManager()
      } catch (error) {
        save.removeAttribute('disabled')
        errBox.textContent = String((error as Error)?.message ?? error)
      }
    })
    const cancel = document.createElement('button')
    cancel.textContent = 'Отмена'
    cancel.addEventListener('click', () => closeInlineForm())
    const rowBtns = document.createElement('div')
    rowBtns.style.marginTop = '10px'
    rowBtns.append(save, cancel)
    form.append(rowBtns, errBox)
    return form
  }

  // ---- helpers -------------------------------------------------------------------------
  function ensureLayout(): void {
    const auto = autoLayout(graph)
    for (const st of graph.steps) {
      if (!graph.layout[st.id]) graph.layout[st.id] = auto[st.id] ?? { x: 40, y: 40 }
      // A sub block lands relative to its parent's REAL position (which may come from the
      // layout comment), not relative to the auto-layout's guess.
      const base = graph.layout[st.id]
      const autoBase = auto[st.id]
      st.sub.forEach((c, i) => {
        if (graph.layout[c.id]) return
        const autoChild = auto[c.id]
        const dx = autoChild && autoBase ? autoChild.x - autoBase.x : NODE_W + SUB_GAP_X
        const dy = autoChild && autoBase ? autoChild.y - autoBase.y : (i - (st.sub.length - 1) / 2) * (NODE_H + 20)
        graph.layout[c.id] = { x: base.x + dx, y: base.y + dy }
      })
    }
  }

  function stepById(id: string): WfStep | undefined {
    return graph.steps.find((s) => s.id === id)
  }

  function push(): void {
    ensureLayout()
    graph = { ...graph, steps: [...graph.steps] }
    if (yamlPre) yamlPre.textContent = emit(graph)
    syncHead()
    if (softEdit) {
      // Typing in a field: redraw the canvas and the document, keep the inspector's DOM
      // (and the input's focus) intact.
      renderCanvas()
    } else {
      render()
    }
    doc.change(graph)
    pushTemplateToPanel()
  }

  /** The panel's Templates tab mirrors the editor live: no re-reading files, the graph
   *  itself is the source. Debounced, local — nothing touches the bridge. */
  let tplPushTimer: ReturnType<typeof setTimeout> | null = null
  function pushTemplateToPanel(): void {
    if (!projectPath) return
    if (tplPushTimer) clearTimeout(tplPushTimer)
    tplPushTimer = setTimeout(() => {
      orca.plugin
        .request('templates.updated', { projectPath, yaml: emit(graph) } as never, { timeoutMs: 10000 })
        .catch(() => undefined)
    }, 800)
  }

  function addStep(withAgent: boolean): void {
    const base = withAgent ? 'step' : 'gate'
    let n = 1
    while (stepById(`${base}${n}`)) n += 1
    const id = `${base}${n}`
    const step: WfStep = {
      id,
      title: withAgent ? `Шаг ${n}` : `Гейт ${n}`,
      agent: withAgent ? 'claude' : null,
      model: null,
      effort: null,
      spec: withAgent ? 'Новая задача: {{objective}}.' : null,
      specFile: null,
      deps: selection?.kind === 'node' && selection.id !== id ? [selection.id] : [],
      gate: null,
      onReject: null,
      specialist: null,
      fallback: [],
      sub: []
    }
    // New nodes land right below the selection, or under the bottom-most node.
    const anchor = selection?.kind === 'node' ? graph.layout[selection.id] : null
    const maxY = Math.max(40, ...Object.values(graph.layout).map((p) => p.y))
    graph.steps.push(step)
    graph.layout[id] = anchor ? { x: anchor.x, y: anchor.y + NODE_H + 90 } : { x: 40, y: maxY + NODE_H + 90 }
    selection = { kind: 'node', id }
    push()
  }

  function removeSelected(): void {
    if (!selection) return
    if (selection.kind === 'node') {
      const id = selection.id
      graph.steps = graph.steps.filter((s) => s.id !== id)
      for (const s of graph.steps) {
        s.deps = s.deps.filter((d) => d !== id)
        if (s.onReject && s.onReject.goto === id) s.onReject = null
      }
      delete graph.layout[id]
    } else if (selection.kind === 'reject') {
      const step = stepById(selection.from)
      if (step) step.onReject = null
    } else if (selection.kind === 'sub') {
      const sel = selection
      const parent = stepById(sel.parentId)
      if (parent) parent.sub = parent.sub.filter((c) => c.id !== sel.id)
      delete graph.layout[sel.id]
    } else {
      const step = stepById(selection.to)
      if (step) step.deps = step.deps.filter((d) => d !== (selection as { from: string }).from)
    }
    selection = null
    push()
  }

  // ---- rendering -----------------------------------------------------------------------
  function nodeCenter(id: string, side: 'in' | 'out'): { x: number; y: number } {
    const p = graph.layout[id] ?? { x: 0, y: 0 }
    // Vertical flow: deps enter from the top, leave from the bottom.
    return side === 'in' ? { x: p.x + NODE_W / 2, y: p.y } : { x: p.x + NODE_W / 2, y: p.y + NODE_H }
  }

  function render(): void {
    renderCanvas()
    renderInspector()
  }

  /** Everything except the inspector, so field typing can redraw without losing focus. */
  function renderCanvas(): void {
    viewport.innerHTML = ''
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`)
    for (const step of graph.steps) {
      for (const dep of step.deps) {
        const a = nodeCenter(dep, 'out')
        const b = nodeCenter(step.id, 'in')
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const mid = (a.y + b.y) / 2
        path.setAttribute('d', `M ${a.x} ${a.y} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`)
        path.setAttribute('class', 'wfv-edge')
        path.setAttribute('marker-end', 'url(#wfv-arrow)')
        if (selection?.kind === 'edge' && selection.from === dep && selection.to === step.id) {
          path.classList.add('selected')
        }
        path.addEventListener('click', (e) => {
          e.stopPropagation()
          selection = { kind: 'edge', from: dep, to: step.id }
          render()
        })
        viewport.append(path)
      }
    }
    // on_reject returns: an arc on the LEFT from the review step back to its goto target.
    for (const step of graph.steps) {
      if (!step.onReject) continue
      const target = stepById(step.onReject.goto)
      const fromP = graph.layout[step.id]
      const toP = graph.layout[step.onReject.goto]
      if (!fromP || !toP || !target) continue
      const fy = fromP.y + NODE_H / 2
      const ty = toP.y + NODE_H / 2
      const bend = Math.min(fromP.x, toP.x) - 70
      const rej = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      rej.setAttribute('d', `M ${fromP.x} ${fy} C ${bend} ${fy}, ${bend} ${ty}, ${toP.x - 6} ${ty}`)
      rej.setAttribute('class', 'wfv-edge reject-edge' + (selection?.kind === 'reject' && selection.from === step.id ? ' selected' : ''))
      rej.setAttribute('marker-end', 'url(#wfv-arrow-reject)')
      const rejTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      rejTitle.textContent = `on_reject → ${step.onReject.goto} (≤${step.onReject.maxRounds} кругов) — клик + Del уберёт`
      rej.append(rejTitle)
      rej.addEventListener('click', (e) => {
        e.stopPropagation()
        selection = { kind: 'reject', from: step.id }
        render()
      })
      viewport.append(rej)
    }
    for (const step of graph.steps) {
      const p = graph.layout[step.id] ?? { x: 0, y: 0 }
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
      g.setAttribute('class', 'wfv-node' + (step.agent ? '' : ' barrier') + (selection?.kind === 'node' && selection.id === step.id ? ' selected' : ''))
      g.setAttribute('transform', `translate(${p.x} ${p.y})`)
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('width', String(NODE_W))
      rect.setAttribute('height', String(NODE_H))
      rect.setAttribute('rx', '8')
      g.append(rect)
      if (step.gate) {
        const badge = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        badge.setAttribute('class', 'wfv-badge')
        badge.setAttribute('cx', String(NODE_W - 14))
        badge.setAttribute('cy', '14')
        badge.setAttribute('r', '6')
        const badgeTitle = document.createElementNS('http://www.w3.org/2000/svg', 'title')
        badgeTitle.textContent = `Гейт: ${step.gate.question}`
        badge.append(badgeTitle)
        g.append(badge)
      }
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      title.setAttribute('x', '10')
      title.setAttribute('y', '20')
      title.textContent = `${step.id}${step.title ? ' · ' + step.title : ''}`
      title.setAttribute('style', 'font-size:12px;font-weight:600')
      const sub = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      sub.setAttribute('class', 'sub')
      sub.setAttribute('x', '10')
      sub.setAttribute('y', '38')
      const card = step.specialist ? specialists.find((sp) => sp.slug === step.specialist) : undefined
      sub.textContent = step.specialist
        ? (card ? `${step.specialist} · ${card.agent}${card.model ? ' · ' + card.model : ''}` : `${step.specialist} · нет карточки`)
        : step.agent
          ? `${step.agent}${step.model ? ' · ' + step.model : ''}${step.specFile ? ' · ' + step.specFile : ''}`
          : 'барьер / гейт'
      const sub2 = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      sub2.setAttribute('class', 'sub')
      sub2.setAttribute('x', '10')
      sub2.setAttribute('y', '54')
      sub2.textContent = step.gate ? '⏿ ' + step.gate.question.slice(0, 26) : step.onReject ? `on_reject → ${step.onReject.goto}` : ''
      g.append(title, sub, sub2)
      for (const side of ['in', 'out'] as const) {
        const port = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
        port.setAttribute('class', 'wfv-port')
        port.setAttribute('cx', String(NODE_W / 2))
        port.setAttribute('cy', String(side === 'in' ? 0 : NODE_H))
        port.setAttribute('r', '6')
        port.dataset.step = step.id
        port.dataset.side = side
        g.append(port)
      }
      g.addEventListener('pointerdown', (e) => {
        const target = e.target as SVGCircleElement
        if (target.classList.contains('wfv-port')) {
          e.stopPropagation()
          if (target.dataset.side === 'out') {
            connectFrom = step.id
            canvas.classList.add('connecting')
            const c = nodeCenter(step.id, 'out')
            tmpEdge = { x1: c.x, y1: c.y, x2: c.x, y2: c.y }
          } else if (connectFrom && connectFrom !== step.id) {
            const target2 = stepById(step.id)
            if (target2 && !target2.deps.includes(connectFrom)) target2.deps.push(connectFrom)
            connectFrom = null
            tmpEdge = null
            canvas.classList.remove('connecting')
            selection = null
            push()
          }
          return
        }
        e.stopPropagation()
        selection = { kind: 'node', id: step.id }
        render()
        beginNodeDrag(e, step.id)
      })
      viewport.append(g)

      // Sub-steps: real blocks to the right, joined by a right-pointing arrow.
      const parentP = graph.layout[step.id] ?? { x: 0, y: 0 }
      for (const child of step.sub) {
        const cp = graph.layout[child.id] ?? { x: 0, y: 0 }
        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
        const ax = parentP.x + NODE_W
        const ay = parentP.y + NODE_H / 2
        const bx = cp.x
        const by = cp.y + NODE_H / 2
        const mid = (ax + bx) / 2
        arrow.setAttribute('d', `M ${ax} ${ay} C ${mid} ${ay}, ${mid} ${by}, ${bx} ${by}`)
        arrow.setAttribute('class', 'wfv-edge sub-edge')
        arrow.setAttribute('marker-end', 'url(#wfv-arrow)')
        viewport.append(arrow)

        const sg = document.createElementNS('http://www.w3.org/2000/svg', 'g')
        sg.setAttribute(
          'class',
          'wfv-node subblock' + (selection?.kind === 'sub' && selection.id === child.id ? ' selected' : '')
        )
        sg.setAttribute('transform', `translate(${cp.x} ${cp.y})`)
        const srect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
        srect.setAttribute('width', String(NODE_W - 30))
        srect.setAttribute('height', String(NODE_H - 14))
        srect.setAttribute('rx', '8')
        sg.append(srect)
        const t1 = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t1.setAttribute('x', '10')
        t1.setAttribute('y', '18')
        t1.setAttribute('style', 'font-size:11.5px;font-weight:600')
        t1.textContent = `${child.id}${child.title ? ' · ' + child.title : ''}`
        const t2 = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        t2.setAttribute('class', 'sub')
        t2.setAttribute('x', '10')
        t2.setAttribute('y', '34')
        const childCard = child.specialist ? specialists.find((sp) => sp.slug === child.specialist) : undefined
      t2.textContent = child.specialist
        ? (childCard ? `${child.specialist} · ${childCard.agent}${childCard.model ? ' · ' + childCard.model : ''}` : `${child.specialist} · нет карточки`)
        : child.agent ?? '?'
        if (child.optional) {
          const t3 = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          t3.setAttribute('class', 'sub')
          t3.setAttribute('x', '10')
          t3.setAttribute('y', '46')
          t3.textContent = 'опциональный'
          sg.append(t3)
        }
        sg.append(t1, t2)
        sg.addEventListener('pointerdown', (e) => {
          e.stopPropagation()
          selection = { kind: 'sub', parentId: step.id, id: child.id }
          render()
          beginNodeDrag(e, child.id)
        })
        viewport.append(sg)
      }
    }
    if (tmpEdge) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', 'wfv-tmp')
      path.setAttribute('d', `M ${tmpEdge.x1} ${tmpEdge.y1} L ${tmpEdge.x2} ${tmpEdge.y2}`)
      viewport.append(path)
    }
    renderStatus()
  }

  function renderStatus(): void {
    if (graph.parseError) {
      status.textContent = ''
      return
    }
    const errors = validate(graph)
    if (errors.length === 0) {
      status.className = 'wfv-status good'
      status.textContent = `✓ ${graph.steps.length} шагов · сохранение через Cmd+S`
    } else {
      status.className = 'wfv-status bad'
      status.textContent = `⚠ ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1})` : ''}`
    }
  }

  // ---- inspector -----------------------------------------------------------------------
  /** True while a field's own input handler runs: push() keeps the inspector (and focus). */
  let softEdit = false

  function field(label: string, value: string, onInput: (v: string) => void, placeholder = ''): HTMLElement {
    const wrap = document.createElement('div')
    const l = document.createElement('label')
    l.textContent = label
    const input = document.createElement('input')
    input.type = 'text'
    input.value = value
    if (placeholder !== '') input.placeholder = placeholder
    input.addEventListener('input', () => {
      softEdit = true
      try {
        onInput(input.value)
      } finally {
        softEdit = false
      }
    })
    wrap.append(l, input)
    return wrap
  }

  /** A text input whose suggestions drop straight under it (native datalists misplace
   *  their popup in narrow frames). Keyboard: ↓/↑ moves, Enter picks, Esc closes. */
  function comboField(label: string, value: string, options: () => string[], onInput: (v: string) => void, placeholder = ''): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'wfv-combo'
    const l = document.createElement('label')
    l.textContent = label
    const input = document.createElement('input')
    input.type = 'text'
    input.value = value
    if (placeholder !== '') input.placeholder = placeholder
    const list = document.createElement('div')
    list.className = 'wfv-combo-list'
    let active = -1
    const close = (): void => {
      wrap.classList.remove('open')
      list.innerHTML = ''
      active = -1
    }
    const open = (): void => {
      const typed = input.value.trim().toLowerCase()
      const all = options().filter((o, i, arr) => arr.indexOf(o) === i)
      const filtered = all.filter((o) => o.toLowerCase().includes(typed))
      list.innerHTML = ''
      if (all.length === 0) {
        const empty = document.createElement('div')
        empty.className = 'opt'
        empty.style.cssText = 'opacity:.6;cursor:default'
        empty.textContent = '— нет вариантов —'
        list.append(empty)
      }
      all.forEach((opt) => {
        if (!filtered.includes(opt)) return
        const row = document.createElement('div')
        row.className = 'opt'
        row.textContent = opt
        row.addEventListener('mousedown', (e) => {
          e.preventDefault() // keep the input's focus; no blur flicker
          input.value = opt
          softEdit = true
          try {
            onInput(opt)
          } finally {
            softEdit = false
          }
          close()
        })
        list.append(row)
      })
      active = -1
      wrap.classList.add('open')
    }
    input.addEventListener('focus', open)
    input.addEventListener('click', open)
    input.addEventListener('input', () => {
      softEdit = true
      try {
        onInput(input.value)
      } finally {
        softEdit = false
      }
      open()
    })
    input.addEventListener('blur', () => setTimeout(close, 120))
    input.addEventListener('keydown', (e) => {
      const rows = Array.from(list.querySelectorAll<HTMLElement>('.opt'))
      if (e.key === 'Escape') {
        close()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (rows.length === 0) return
        active = e.key === 'ArrowDown' ? (active + 1) % rows.length : (active - 1 + rows.length) % rows.length
        rows.forEach((r, i) => r.classList.toggle('active', i === active))
        rows[active].scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' && active >= 0 && rows[active]) {
        e.preventDefault()
        input.value = rows[active].textContent ?? input.value
        softEdit = true
        try {
          onInput(input.value)
        } finally {
          softEdit = false
        }
        close()
      }
    })
    wrap.append(l, input, list)
    return wrap
  }

  function renderInspector(): void {
    inspector.innerHTML = ''
    if (graph.parseError || !selection) {
      const hint = document.createElement('div')
      hint.style.cssText = 'font-size:12px;color:var(--orca-muted-foreground);line-height:1.5'
      hint.textContent = graph.parseError
        ? 'Файл не парсится как шаблон — правь его во вкладке Source.'
        : 'Клик по блоку — свойства. Потяни от правого порта к левому — зависимость. Клик по стрелке + Del — удалить.'
      inspector.append(hint)
      return
    }
    if (selection.kind === 'sub') {
      const sel = selection
      const parent = stepById(sel.parentId)
      const child = parent?.sub.find((c) => c.id === sel.id)
      if (!parent || !child) return
      const head = document.createElement('div')
      head.style.cssText = 'font-size:11px;color:var(--orca-muted-foreground);margin-bottom:6px'
      head.textContent = `Подшаг блока «${parent.id}» — идёт параллельно с соседями, справа от родителя`
      inspector.append(head)
      inspector.append(field('id', child.id, (v) => {
        const clean = v.trim().replace(/[^a-z0-9-]/g, '-') || child.id
        if (clean === child.id) return
        const pos = graph.layout[child.id]
        delete graph.layout[child.id]
        if (pos) graph.layout[clean] = pos
        child.id = clean
        selection = { kind: 'sub', parentId: parent.id, id: clean }
        push()
      }))
      inspector.append(field('Заголовок', child.title ?? '', (v) => { child.title = v === '' ? null : v; push() }))
      inspector.append(field('worker — имя воркера', child.specialist ?? '', (v) => {
        child.specialist = v.trim() === '' ? null : v.trim()
        if (child.specialist) child.agent = null
        push()
      }))
      const childCard = child.specialist ? specialists.find((sp) => sp.slug === child.specialist) : undefined
      inspector.append(comboField('Агент (если без воркера)', child.agent ?? '', () => ['claude', 'codex', 'zcode', 'opencode'], (v) => {
        child.agent = v.trim() === '' ? null : v.trim()
        if (child.agent) child.specialist = null
        push()
      }, childCard && !child.agent ? childCard.agent : ''))
      void loadCatalogModels()
      inspector.append(comboField('Модель (опц.) — каталог', child.model ?? '', modelOptions, (v) => { child.model = v.trim() === '' ? null : v.trim(); push() }, childCard && !child.model && childCard.model ? childCard.model : ''))
      inspector.append(comboField('Fallback — агенты при провале', child.fallback.join(', '), () => ['claude', 'codex', 'zcode', 'kimi', 'gemini'], (v) => {
        child.fallback = v.split(',').map((a) => a.trim()).filter(Boolean)
        push()
      }))
      const optLabel = document.createElement('label')
      optLabel.textContent = 'Опциональный (стартует только по RUN: из отчёта родителя)'
      const optRow = document.createElement('div')
      optRow.className = 'row'
      const optCheck = document.createElement('input')
      const phaseWrap = comboField('Фаза — когда относительно воркера родителя', child.phase ?? (child.optional ? 'after_end' : 'before_end'), () => ['before_start — до старта воркера', 'parallel — параллельно с воркером', 'before_end — после работы, до отчёта', 'after_end — после отчёта'], (v) => {
        const bit = v.split(' ')[0]
        if (bit === 'before_start' || bit === 'parallel' || bit === 'before_end' || bit === 'after_end') child.phase = bit
        push()
      })
      inspector.append(phaseWrap)
      optCheck.type = 'checkbox'
      optCheck.checked = child.optional
      optCheck.addEventListener('change', () => { child.optional = optCheck.checked; push() })
      optRow.append(optCheck, optLabel)
      inspector.append(optRow)
      const del = document.createElement('button')
      del.className = 'del'
      del.textContent = 'Удалить подшаг'
      del.addEventListener('click', () => {
        parent.sub = parent.sub.filter((c) => c.id !== child.id)
        delete graph.layout[child.id]
        selection = { kind: 'node', id: parent.id }
        push()
      })
      inspector.append(del)
      return
    }
    if (selection.kind !== 'node') return
    const step = stepById(selection.id)
    if (!step) return
    inspector.append(field('id', step.id, (v) => {
      const clean = v.trim().replace(/[^a-z0-9-]/g, '-') || step.id
      if (clean === step.id) return
      for (const s of graph.steps) s.deps = s.deps.map((d) => (d === step.id ? clean : d))
      const pos = graph.layout[step.id]
      delete graph.layout[step.id]
      if (pos) graph.layout[clean] = pos
      step.id = clean
      selection = { kind: 'node', id: clean }
      push()
    }))
    inspector.append(field('Заголовок', step.title ?? '', (v) => { step.title = v === '' ? null : v; push() }))
    inspector.append(field('worker — имя воркера (называется один раз)', step.specialist ?? '', (v) => {
      step.specialist = v.trim() === '' ? null : v.trim()
      if (step.specialist) step.agent = null // либо specialist, либо agent
      push()
    }))
    const sc = step.specialist ? specialists.find((sp) => sp.slug === step.specialist) : undefined
    const scHint = document.createElement('div')
    scHint.style.cssText = 'font-size:10.5px;color:var(--orca-muted-foreground);margin:-4px 0 4px'
    scHint.textContent = sc ? `карточка: ${sc.agent}${sc.model ? ' · ' + sc.model : ''}${sc.effort ? ' · effort ' + sc.effort : ''}` : (step.specialist ? 'карточка воркера не найдена' : '')
    inspector.append(scHint)
    inspector.append(field('Агент (пусто = из карточки/барьер)', step.agent ?? '', (v) => {
      step.agent = v.trim() === '' ? null : v.trim()
      if (step.agent) step.specialist = null
      push()
    }, sc && !step.agent ? sc.agent : ''))
    if (step.sub.length > 0) {
      const subHead = document.createElement('label')
      subHead.textContent = `Подшаги (${step.sub.length}) — параллельный блок`
      inspector.append(subHead)
      for (const child of step.sub) {
        const line = document.createElement('div')
        line.style.cssText = 'font-size:11.5px;color:var(--orca-muted-foreground);margin:2px 0'
        line.textContent = `↳ ${child.id}${child.title ? ' · ' + child.title : ''} — ${child.specialist ?? child.agent ?? '?'}${child.optional ? ' · опциональный' : ''}`
        inspector.append(line)
      }
      const subHint = document.createElement('div')
      subHint.style.cssText = 'font-size:11px;color:var(--orca-muted-foreground);margin:4px 0 0'
      subHint.textContent = 'Подшаги задаются в YAML (sub:) — редактор сохраняет их как есть.'
      inspector.append(subHint)
    }
    void loadCatalogModels()
    inspector.append(comboField('Модель (опц.) — каталог', step.model ?? '', modelOptions, (v) => { step.model = v.trim() === '' ? null : v.trim(); push() }, sc && !step.model && sc.model ? sc.model : ''))
    const stepSpecialistForEffort = specialists.find((sp) => sp.slug === step.specialist)
    inspector.append(comboField('Effort (только с моделью)', step.effort ?? '', () => effortsFor(step.agent ?? stepSpecialistForEffort?.agent), (v) => { step.effort = v.trim() === '' ? null : v.trim(); push() }, sc && !step.effort && sc.effort ? sc.effort : ''))
    inspector.append(comboField('Fallback — агенты при провале (через запятую вводится вручную)', step.fallback.join(', '), () => ['claude', 'codex', 'zcode', 'kimi', 'gemini'], (v) => {
      step.fallback = v.split(',').map((a) => a.trim()).filter(Boolean)
      push()
    }))
    inspector.append(field('specFile (путь в каталоге шаблонов)', step.specFile ?? '', (v) => { step.specFile = v.trim() === '' ? null : v.trim(); step.spec = null; push() }))
    const specLabel = document.createElement('label')
    specLabel.textContent = 'промпт (инлайн; шаг без карточки воркера)'
    inspector.append(specLabel)
    const specArea = document.createElement('textarea')
    specArea.value = step.spec ?? ''
    specArea.addEventListener('input', () => { step.spec = specArea.value === '' ? null : specArea.value; step.specFile = null; push() })
    inspector.append(specArea)
    inspector.append(field('deps (через запятую)', step.deps.join(', '), (v) => {
      step.deps = v.split(',').map((s) => s.trim()).filter(Boolean)
      push()
    }))

    const gateLabel = document.createElement('label')
    gateLabel.textContent = 'Необходимо подтверждение (шаг не начнётся без ответа)'
    inspector.append(gateLabel)
    const gateRow = document.createElement('div')
    gateRow.className = 'row'
    const gateCheck = document.createElement('input')
    gateCheck.type = 'checkbox'
    gateCheck.checked = step.gate !== null
    gateCheck.addEventListener('change', () => {
      step.gate = gateCheck.checked ? { question: 'Аппрувнут?', options: ['approve', 'request-changes'] } : null
      push()
    })
    const gateText = document.createElement('span')
    gateText.textContent = 'включить'
    gateRow.append(gateCheck, gateText)
    inspector.append(gateRow)
    if (step.gate) {
      inspector.append(field('Вопрос гейта', step.gate.question, (v) => { if (step.gate) step.gate.question = v; push() }))
      inspector.append(field('Варианты (через запятую)', step.gate.options.join(', '), (v) => {
        if (step.gate) step.gate.options = v.split(',').map((s) => s.trim()).filter(Boolean)
        push()
      }))
      // skip — явное разрешение в шаблоне: не всякий шаг можно осмысленно пропустить.
      const skipAllowed = step.gate.options.includes('skip')
      const skipRow = document.createElement('div')
      skipRow.className = 'row'
      const skipCheck = document.createElement('input')
      skipCheck.type = 'checkbox'
      skipCheck.checked = skipAllowed
      skipCheck.title = 'Добавляет skip в варианты ответа: человек сможет пропустить шаг, который держит этот гейт'
      skipCheck.addEventListener('change', () => {
        if (!step.gate) return
        step.gate.options = skipCheck.checked ? [...step.gate.options, 'skip'] : step.gate.options.filter((o) => o !== 'skip')
        if (!skipCheck.checked) step.onSkip = null
        push()
      })
      const skipText = document.createElement('span')
      skipText.textContent = 'разрешить skip — человек может пропустить следующий шаг'
      skipRow.append(skipCheck, skipText)
      inspector.append(skipRow)
    }
    inspector.append(comboField('on_reject: goto', step.onReject?.goto ?? '', () => graph.steps.filter((st) => st.id !== step.id).map((st) => st.id), (v) => {
      step.onReject = v.trim() === '' ? null : { goto: v.trim(), maxRounds: step.onReject?.maxRounds ?? 2 }
      push()
    }))
    inspector.append(field('on_reject: max_rounds', step.onReject ? String(step.onReject.maxRounds) : '', (v) => {
      const n = Number(v)
      if (step.onReject && Number.isInteger(n) && n >= 1) step.onReject.maxRounds = n
      push()
    }))
    // on_skip — куда флоу продолжится после пропуска (опция skip в вариантах гейта); только вперёд
    const stepsAfter = (): string[] => graph.steps.slice(graph.steps.findIndex((st) => st.id === step.id) + 1).map((st) => st.id)
    const onSkipField = comboField('on_skip: goto', step.onSkip?.goto ?? '', stepsAfter, (v) => {
      step.onSkip = v.trim() === '' ? null : { goto: v.trim() }
      push()
    }, 'пусто — следующий шаг')
    onSkipField.title = 'С каким шагом флоу продолжится после skip; шаги между пропускаются. Нужно разрешить skip в гейте'
    inspector.append(onSkipField)
    const addSub = document.createElement('button')
    addSub.textContent = '+ Подшаг (параллельный блок справа)'
    addSub.style.cssText = 'margin-top:12px;font:12px inherit;padding:4px 10px;border:1px solid var(--orca-border);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);cursor:pointer'
    addSub.addEventListener('click', () => {
      const n = step.sub.length + 1
      let id = `sub-${n}`
      while (graph.steps.some((st) => st.sub.some((c) => c.id === id))) id = `sub-${Number(id.slice(4)) + 1}`
      step.sub.push({ id, title: null, specialist: null, agent: null, model: null, effort: null, fallback: [], spec: null, specFile: null, deps: [], optional: false })
      push()
      selection = { kind: 'sub', parentId: step.id, id }
      render()
    })
    inspector.append(addSub)
    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = 'Удалить шаг'
    del.addEventListener('click', removeSelected)
    inspector.append(del)
  }

  // ---- pointer interactions --------------------------------------------------------------
  let dragNode: { id: string; dx: number; dy: number } | null = null
  let pan: { x: number; y: number; vx: number; vy: number } | null = null

  function svgPoint(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const rect = svg.getBoundingClientRect()
    return { x: (e.clientX - rect.left - view.x) / view.k, y: (e.clientY - rect.top - view.y) / view.k }
  }

  /** Scales the initial view so the whole graph fits: vertical layouts can get tall. */
  function fitView(): void {
    const points = Object.values(graph.layout)
    if (points.length === 0) return
    const maxX = Math.max(...points.map((p) => p.x)) + NODE_W
    const maxY = Math.max(...points.map((p) => p.y)) + NODE_H
    const rect = svg.getBoundingClientRect()
    const w = Math.max(200, rect.width - 30)
    const h = Math.max(200, rect.height - 30)
    view.k = Math.min(1, w / maxX, h / maxY)
    view.x = 15
    view.y = 15
  }

  function beginNodeDrag(e: PointerEvent, id: string): void {
    const p = svgPoint(e)
    const at = graph.layout[id] ?? { x: 0, y: 0 }
    dragNode = { id, dx: p.x - at.x, dy: p.y - at.y }
  }

  svg.addEventListener('pointerdown', (e) => {
    if ((e.target as Element).closest('.wfv-node')) return
    selection = null
    connectFrom = null
    tmpEdge = null
    canvas.classList.remove('connecting')
    render()
    pan = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
    canvas.setPointerCapture(e.pointerId)
  })

  window.addEventListener('pointermove', (e) => {
    if (dragNode) {
      const p = svgPoint(e)
      graph.layout[dragNode.id] = { x: p.x - dragNode.dx, y: p.y - dragNode.dy }
      render()
    } else if (pan) {
      view.x = pan.vx + (e.clientX - pan.x)
      view.y = pan.vy + (e.clientY - pan.y)
      render()
    } else if (connectFrom && tmpEdge) {
      const p = svgPoint(e)
      tmpEdge = { ...tmpEdge, x2: p.x, y2: p.y }
      render()
    }
  })

  window.addEventListener('pointerup', () => {
    if (dragNode) {
      dragNode = null
      push()
    }
    pan = null
  })

  svg.addEventListener('dblclick', (e) => {
    const p = svgPoint(e as unknown as PointerEvent)
    let n = 1
    while (stepById(`step${n}`)) n += 1
    const id = `step${n}`
    graph.steps.push({
      id, title: `Шаг ${n}`, specialist: null, agent: 'claude', model: null, effort: null, fallback: [],
      spec: 'Новая задача: {{objective}}.', specFile: null, deps: [], gate: null, onReject: null, onSkip: null, sub: []
    })
    graph.layout[id] = p
    selection = { kind: 'node', id }
    push()
  })

  svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    const k = Math.min(2, Math.max(0.3, view.k * Math.exp(-e.deltaY * 0.0012)))
    const rect = svg.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    view.x = mx - ((mx - view.x) / view.k) * k
    view.y = my - ((my - view.y) / view.k) * k
    view.k = k
    render()
  }, { passive: false })

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      connectFrom = null
      tmpEdge = null
      canvas.classList.remove('connecting')
      selection = null
      render()
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selection) {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      e.preventDefault()
      removeSelected()
    }
  })

  // ---- boot ------------------------------------------------------------------------------
  if (graph.parseError) {
    errorBar.hidden = false
    errorBar.textContent = `Файл не парсится: ${graph.parseError}`
    const pre = document.createElement('pre')
    pre.className = 'wfv-yaml'
    pre.textContent = graph.raw
    ;(root.querySelector('.wfv-body') as HTMLElement).append(pre)
    canvas.remove()
    inspector.remove()
    return
  }
  ensureLayout()
  fitView()
  render()
  doc.onReplace((next) => {
    graph = next
    selection = null
    ensureLayout()
    render()
  })
  window.addEventListener('resize', () => render())
}
