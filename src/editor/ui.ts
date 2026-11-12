// The graph editor's DOM/SVG glue: canvas with draggable nodes, ports to connect deps,
// an inspector (including the gate section), toolbar and YAML preview. Vanilla, no libraries.
import type { EditorSession } from 'orca/frame'
import type { WfStep } from '../protocol'
import { autoLayout, emit, NODE_H, NODE_W, validate, type WfGraph } from './core'

const STYLE = `
.wfv{display:flex;flex-direction:column;height:100vh;color:var(--orca-foreground);background:var(--orca-background);font:13px -apple-system,system-ui,sans-serif}
.wfv-toolbar{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--orca-border);background:var(--orca-card)}
.wfv-toolbar button{font:12px inherit;padding:3px 10px;border:1px solid var(--orca-border);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);cursor:pointer}
.wfv-toolbar button:hover{background:var(--orca-muted)}
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
.wfv-spmgr{position:fixed;top:42px;right:0;bottom:0;width:330px;background:var(--orca-card);border-left:1px solid var(--orca-border);box-shadow:-6px 0 18px rgba(0,0,0,.25);z-index:40;padding:12px;overflow:auto;box-sizing:border-box}
.wfv-spmgr h3{margin:0 0 8px;font-size:13px}
.wfv-spmgr .sp-row{display:flex;align-items:center;gap:6px;padding:6px 4px;border-bottom:1px solid var(--orca-border);font-size:12px}
.wfv-spmgr .sp-row .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wfv-spmgr button{font:11.5px inherit;padding:2px 8px;border:1px solid var(--orca-border);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);cursor:pointer}
.wfv-spmgr textarea{width:100%;min-height:120px;box-sizing:border-box;padding:4px 6px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);font:11.5px ui-monospace,monospace;resize:vertical}
.wfv-spmgr label{display:block;margin:8px 0 2px;font-size:11px;color:var(--orca-muted-foreground)}
.wfv-spmgr input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground);font:12px ui-monospace,monospace}
.wfv-spmgr .err{margin-top:8px;color:var(--orca-destructive);font-size:11.5px;white-space:pre-wrap}
.wfv-yaml{position:absolute;inset:0;margin:0;padding:12px;overflow:auto;background:var(--orca-background);font:12px ui-monospace,monospace;white-space:pre;border:0}
.wfv-error{padding:8px 12px;background:var(--orca-destructive);color:var(--orca-destructive-foreground);font-size:12px}
.wfv-hint{padding:4px 12px;font-size:11px;color:var(--orca-muted-foreground)}
.wfv-head{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid var(--orca-border);background:var(--orca-card)}
.wfv-head input{font:13px inherit;padding:3px 8px;border:1px solid var(--orca-input);border-radius:var(--orca-radius);background:var(--orca-background);color:var(--orca-foreground)}
.wfv-head .title{flex:1;font-weight:600}
.wfv-head .ident{width:150px;font-family:ui-monospace,monospace;font-size:12px}
.wfv-head .cap{font-size:11px;color:var(--orca-muted-foreground)}
`

type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | null

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
    '<path d="M0,0 L10,5 L0,10 z" fill="var(--orca-muted-foreground)"/></marker></defs>' +
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

  // ---- project specialists: dropdown data + the manager panel -------------------------
  type Sp = { slug: string; agent: string; model: string | null; effort: string | null; spec: string | null; error: string | null }
  let specialists: Sp[] = []
  let projectPath: string | null = null
  const request = <T>(name: string, input: unknown, timeoutMs = 30000): Promise<T> =>
    orca.plugin.request(name, input as never, { timeoutMs }) as Promise<T>
  async function loadSpecialists(): Promise<void> {
    try {
      const current = await request<{ project: { path: string } | null }>('project.current', undefined)
      projectPath = current?.project?.path ?? null
    } catch {
      projectPath = null
    }
    if (projectPath) {
      try {
        const answer = await request<{ specialists: Sp[] }>('specialists.list', { projectPath }, 60000)
        specialists = answer.specialists ?? []
      } catch {
        specialists = []
      }
    } else {
      specialists = []
    }
    renderInspector()
  }
  void loadSpecialists()

  const buttons: Array<[string, () => void]> = [
    ['+ Шаг', () => addStep(true)],
    ['+ Барьер', () => addStep(false)],
    ['Автораскладка', () => { graph.layout = autoLayout(graph); push() }],
    ['YAML', () => toggleYaml()],
    ['Специалисты', () => toggleSpecialists()]
  ]
  for (const [label, onClick] of buttons) {
    const b = document.createElement('button')
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
  async function renderSpManager(editing: Sp | 'new' | null = null): Promise<void> {
    const panel = spPanel
    if (!panel) return
    if (!projectPath) await loadSpecialists()
    panel.innerHTML = ''
    const h = document.createElement('h3')
    h.textContent = `Специалисты — ${projectPath ? projectPath.split('/').pop() : 'проект не определён'}`
    panel.append(h)
    const close = document.createElement('button')
    close.textContent = '×'
    close.style.cssText = 'float:right'
    close.addEventListener('click', () => { if (spPanel) { spPanel.remove(); spPanel = null } })
    panel.append(close)
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
      const edit = document.createElement('button')
      edit.textContent = 'изменить'
      edit.addEventListener('click', () => void renderSpManager(sp))
      const rm = document.createElement('button')
      rm.textContent = 'удалить'
      let armed = false
      rm.addEventListener('click', async () => {
        if (!armed) {
          armed = true
          rm.textContent = 'точно?'
          setTimeout(() => { armed = false; rm.textContent = 'удалить' }, 2500)
          return
        }
        panel.setAttribute('data-busy', '1')
        try {
          await request('specialists.delete', { projectPath, slug: sp.slug }, 60000)
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
    if (editing === null) {
      const add = document.createElement('button')
      add.textContent = '+ Новый специалист'
      add.style.marginTop = '8px'
      add.addEventListener('click', () => void renderSpManager('new'))
      panel.append(add)
      return
    }
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
    const modelEl = input('модель (опц.)', editing === 'new' || !editing ? '' : editing.model ?? '')
    modelEl.setAttribute('list', 'dl-model')
    const effortEl = input('effort (опц.)', editing === 'new' || !editing ? '' : editing.effort ?? '')
    const spEfforts = document.createElement('datalist')
    spEfforts.id = 'dl-effort-sp'
    for (const value of [...new Set([...EFFORTS.claude, ...EFFORTS.codex])]) {
      const opt = document.createElement('option')
      opt.value = value
      spEfforts.append(opt)
    }
    effortEl.setAttribute('list', 'dl-effort-sp')
    form.append(spEfforts)
    const specL = document.createElement('label')
    specL.textContent = 'spec — промпт специалиста'
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
          'specialists.save',
          {
            projectPath,
            slug: slugEl.value,
            agent: agentEl.value,
            model: modelEl.value.trim() === '' ? null : modelEl.value.trim(),
            effort: effortEl.value.trim() === '' ? null : effortEl.value.trim(),
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
    cancel.addEventListener('click', () => void renderSpManager())
    const rowBtns = document.createElement('div')
    rowBtns.style.marginTop = '10px'
    rowBtns.append(save, cancel)
    form.append(rowBtns, errBox)
    panel.append(form)
  }

  // ---- helpers -------------------------------------------------------------------------
  function ensureLayout(): void {
    const missing = graph.steps.filter((s) => !graph.layout[s.id])
    if (missing.length === 0) return
    const auto = autoLayout(graph)
    for (const id of Object.keys(auto)) if (!graph.layout[id]) graph.layout[id] = auto[id]
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
      sub.textContent = step.specialist ? `${step.specialist} (специалист)` : step.agent ?? ''
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

  function field(label: string, value: string, onInput: (v: string) => void, list?: string): HTMLElement {
    const wrap = document.createElement('div')
    const l = document.createElement('label')
    l.textContent = label
    const input = document.createElement('input')
    input.type = 'text'
    input.value = value
    if (list) input.setAttribute('list', list)
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

  function renderInspector(): void {
    inspector.innerHTML = ''
    if (graph.parseError || !selection || selection.kind !== 'node') {
      const hint = document.createElement('div')
      hint.style.cssText = 'font-size:12px;color:var(--orca-muted-foreground);line-height:1.5'
      hint.textContent = graph.parseError
        ? 'Файл не парсится как шаблон — правь его во вкладке Source.'
        : 'Клик по блоку — свойства. Потяни от правого порта к левому — зависимость. Клик по стрелке + Del — удалить.'
      inspector.append(hint)
      return
    }
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
    inspector.append(field('Специалист (slug из .orca/specialists, вместо агента)', step.specialist ?? '', (v) => {
      step.specialist = v.trim() === '' ? null : v.trim()
      if (step.specialist) step.agent = null // либо specialist, либо agent
      push()
    }, 'dl-spec'))
    inspector.append(field('Агент (пусто = барьер, если нет специалиста)', step.agent ?? '', (v) => {
      step.agent = v.trim() === '' ? null : v.trim()
      if (step.agent) step.specialist = null
      push()
    }))
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
    inspector.append(field('Модель (опц.)', step.model ?? '', (v) => { step.model = v.trim() === '' ? null : v.trim(); push() }, 'dl-model'))
    inspector.append(field('Effort (только с моделью)', step.effort ?? '', (v) => { step.effort = v.trim() === '' ? null : v.trim(); push() }, 'dl-effort'))
    inspector.append(field('specFile (путь в каталоге шаблонов)', step.specFile ?? '', (v) => { step.specFile = v.trim() === '' ? null : v.trim(); step.spec = null; push() }))
    const specLabel = document.createElement('label')
    specLabel.textContent = 'spec (инлайн, если нет specFile)'
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
    }
    inspector.append(field('on_reject: goto', step.onReject?.goto ?? '', (v) => {
      step.onReject = v.trim() === '' ? null : { goto: v.trim(), maxRounds: step.onReject?.maxRounds ?? 2 }
      push()
    }, 'dl-goto'))
    inspector.append(field('on_reject: max_rounds', step.onReject ? String(step.onReject.maxRounds) : '', (v) => {
      const n = Number(v)
      if (step.onReject && Number.isInteger(n) && n >= 1) step.onReject.maxRounds = n
      push()
    }))
    const del = document.createElement('button')
    del.className = 'del'
    del.textContent = 'Удалить шаг'
    del.addEventListener('click', removeSelected)
    inspector.append(del)

    // Suggestions for the free-text fields: project specialists, models in use, efforts, step ids.
    const datalist = (id: string, values: string[]): HTMLElement => {
      const dl = document.createElement('datalist')
      dl.id = id
      for (const value of values) {
        const opt = document.createElement('option')
        opt.value = value
        dl.append(opt)
      }
      return dl
    }
    inspector.append(datalist('dl-spec', specialists.map((sp) => sp.slug)))
    inspector.append(
      datalist(
        'dl-model',
        [...new Set([...specialists.map((sp) => sp.model), ...graph.steps.map((st) => st.model)].filter((m): m is string => !!m))]
      )
    )
    const stepSpecialist = specialists.find((sp) => sp.slug === step.specialist)
    inspector.append(datalist('dl-effort', effortsFor(step.agent ?? stepSpecialist?.agent)))
    inspector.append(datalist('dl-goto', graph.steps.filter((st) => st.id !== step.id).map((st) => st.id)))
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
      id, title: `Шаг ${n}`, specialist: null, agent: 'claude', model: null, effort: null,
      spec: 'Новая задача: {{objective}}.', specFile: null, deps: [], gate: null, onReject: null, sub: []
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
