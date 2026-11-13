// The graph editor's pure core: no DOM, testable in Node. decode/emit go through the same
// yaml/workflow modules the worker uses, so the file format has exactly one implementation.
import type { WfStep } from '../protocol'
import { parseTemplate } from '../workflow'
import { parseYaml } from '../yaml'

export type WfGraph = {
  id: string
  title: string
  steps: WfStep[]
  /** Node positions the editor drags to; absent ids get autoLayout. */
  layout: Record<string, { x: number; y: number }>
  /** Set when the file did not parse: the editor turns read-only and shows the text. */
  parseError: string | null
  raw: string
}

export const NODE_W = 190
export const NODE_H = 68
/** Horizontal distance from a parent block to its sub-step blocks. */
export const SUB_GAP_X = 70

export function emptyGraph(): WfGraph {
  return { id: '', title: '', steps: [], layout: {}, parseError: null, raw: '' }
}

const LAYOUT_RE = /^#\s*workflow-view:\s*layout\s+(.+)$/m

/** `# workflow-view: layout id:x,y; id2:x,y` — ignored by the parser, read here. */
function readLayoutComment(text: string): Record<string, { x: number; y: number }> {
  const layout: Record<string, { x: number; y: number }> = {}
  const match = text.match(LAYOUT_RE)
  if (!match) return layout
  for (const part of match[1].split(';')) {
    const bit = part.trim().match(/^([a-z0-9-]+):(-?\d+),(-?\d+)$/)
    if (bit) layout[bit[1]] = { x: Number(bit[2]), y: Number(bit[3]) }
  }
  return layout
}

export function decode(text: string): WfGraph {
  let parsed: ReturnType<typeof parseTemplate>
  try {
    parsed = parseTemplate('editor', parseYaml(text))
  } catch (error) {
    return { ...emptyGraph(), parseError: error instanceof Error ? error.message : String(error), raw: text }
  }
  return {
    id: parsed.id,
    title: parsed.title,
    steps: parsed.steps,
    layout: readLayoutComment(text),
    parseError: null,
    raw: text
  }
}

function yamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Steps in dependency order (stable), so the emitted file reads top to bottom. */
export function topoSortSteps(steps: WfStep[]): WfStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const seen = new Set<string>()
  const out: WfStep[] = []
  const visit = (id: string, stack: Set<string>): void => {
    if (seen.has(id)) return
    if (stack.has(id)) return // a cycle: validate() reports it; emit still terminates
    stack.add(id)
    for (const dep of byId.get(id)?.deps ?? []) visit(dep, stack)
    stack.delete(id)
    seen.add(id)
    const step = byId.get(id)
    if (step) out.push(step)
  }
  for (const step of steps) visit(step.id, new Set())
  return out
}

export function emit(graph: WfGraph): string {
  const lines: string[] = []
  const positioned = Object.entries(graph.layout)
    .filter(([id]) => graph.steps.some((s) => s.id === id))
    .map(([id, p]) => `${id}:${Math.round(p.x)},${Math.round(p.y)}`)
  if (positioned.length > 0) lines.push(`# workflow-view: layout ${positioned.join('; ')}`)
  lines.push(`id: ${graph.id || 'workflow'}`)
  lines.push(`title: ${yamlScalar(graph.title || graph.id || 'Воркфлоу')}`)
  lines.push('steps:')
  for (const step of topoSortSteps(graph.steps)) {
    lines.push(`  - id: ${step.id}`)
    if (step.title) lines.push(`    title: ${yamlScalar(step.title)}`)
    if (step.specialist) lines.push(`    specialist: ${step.specialist}`)
    if (step.agent) lines.push(`    agent: ${step.agent}`)
    if (step.model) lines.push(`    model: ${step.model}`)
    if (step.model && step.effort) lines.push(`    effort: ${step.effort}`)
    if (step.specFile) lines.push(`    specFile: ${step.specFile}`)
    else if (step.spec) {
      lines.push('    spec: |')
      for (const line of step.spec.replace(/\n$/, '').split('\n')) lines.push(`      ${line}`)
    }
    if (step.fallback.length > 0) lines.push(`    fallback: [${step.fallback.join(', ')}]`)
    if (step.deps.length > 0) lines.push(`    deps: [${step.deps.join(', ')}]`)
    if (step.gate) {
      lines.push('    gate:')
      lines.push(`      question: ${yamlScalar(step.gate.question)}`)
      lines.push(`      options: [${step.gate.options.join(', ')}]`)
    }
    if (step.onReject) {
      lines.push(`    on_reject: { goto: ${step.onReject.goto}, max_rounds: ${step.onReject.maxRounds} }`)
    }
    if (step.sub.length > 0) {
      lines.push('    sub:')
      for (const child of step.sub) {
        const bits = [`id: ${child.id}`]
        if (child.title) bits.push(`title: ${yamlScalar(child.title)}`)
        if (child.specialist) bits.push(`specialist: ${child.specialist}`)
        if (child.agent) bits.push(`agent: ${child.agent}`)
        if (child.model) bits.push(`model: ${child.model}`)
        if (child.fallback.length > 0) bits.push(`fallback: [${child.fallback.join(', ')}]`)
        if (child.optional) bits.push('optional: true')
        if (child.specFile) bits.push(`specFile: ${child.specFile}`)
        lines.push(`      - { ${bits.join(', ')} }`)
      }
    }
  }
  return lines.join('\n') + '\n'
}

/** Live validation for the editor: every problem as one human line. */
export function validate(graph: WfGraph): string[] {
  const errors: string[] = []
  const ids = new Set<string>()
  for (const step of graph.steps) {
    if (step.id.trim() === '') errors.push('у шага пустой id')
    else if (ids.has(step.id)) errors.push(`id "${step.id}" повторяется`)
    ids.add(step.id)
  }
  for (const step of graph.steps) {
    for (const dep of step.deps) {
      if (!ids.has(dep)) errors.push(`шаг "${step.id}": зависимость "${dep}" не существует`)
    }
    if (step.agent && !step.spec && !step.specFile) {
      errors.push(`шаг "${step.id}": агенту нужна спека (spec или specFile)`)
    }
    if (!step.agent && !step.specialist && step.deps.length === 0) {
      errors.push(`шаг "${step.id}": барьер без зависимостей ничего не делает`)
    }
    if (step.agent && step.specialist) {
      errors.push(`шаг "${step.id}": либо specialist, либо agent — не оба`)
    }
    if (step.gate && step.gate.question.trim() === '') errors.push(`шаг "${step.id}": пустой вопрос гейта`)
    if (step.onReject && !ids.has(step.onReject.goto)) {
      errors.push(`шаг "${step.id}": on_reject.goto "${step.onReject.goto}" не существует`)
    }
  }
  // Cycles: a dependency walk that meets itself.
  const state = new Map<string, 1 | 2>()
  const walk = (id: string): void => {
    const mark = state.get(id)
    if (mark === 2) return
    if (mark === 1) {
      errors.push(`цикл в зависимостях через "${id}"`)
      return
    }
    state.set(id, 1)
    for (const dep of graph.steps.find((s) => s.id === id)?.deps ?? []) walk(dep)
    state.set(id, 2)
  }
  for (const step of graph.steps) walk(step.id)
  return [...new Set(errors)]
}

/** Layered layout, top to bottom: a row per dependency depth, parallel steps side by side. */
export function autoLayout(graph: WfGraph): Record<string, { x: number; y: number }> {
  const byId = new Map(graph.steps.map((s) => [s.id, s]))
  const depth = new Map<string, number>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    depth.set(id, 0) // guard against cycles
    const step = byId.get(id)
    const value = step && step.deps.length > 0 ? 1 + Math.max(...step.deps.map(depthOf)) : 0
    depth.set(id, value)
    return value
  }
  for (const step of graph.steps) depthOf(step.id)
  const layers = new Map<number, string[]>()
  for (const step of graph.steps) {
    const d = depth.get(step.id) ?? 0
    const layer = layers.get(d) ?? []
    layer.push(step.id)
    layers.set(d, layer)
  }
  const layout: Record<string, { x: number; y: number }> = {}
  for (const [d, layerIds] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
    layerIds.forEach((id, i) => {
      layout[id] = { x: 40 + i * (NODE_W + 50), y: 40 + d * (NODE_H + 90) }
    })
  }
  // Sub-steps are real blocks to the RIGHT of their parent: the chain keeps its vertical
  // order, nested checks hang off sideways with a right-pointing arrow.
  for (const step of graph.steps) {
    const base = layout[step.id]
    if (!base) continue
    const kids = step.sub
    kids.forEach((child, i) => {
      layout[child.id] = {
        x: base.x + NODE_W + SUB_GAP_X,
        y: base.y + (i - (kids.length - 1) / 2) * (NODE_H + 20)
      }
    })
  }
  return layout
}

/** Session merge by id: for each step, take my fields where they differ from base, else outside's. */
export function mergeGraphs(base: WfGraph, outside: WfGraph, mine: WfGraph): WfGraph {
  const ids = new Set([...base.steps, ...outside.steps, ...mine.steps].map((s) => s.id))
  const find = (g: WfGraph, id: string): WfStep | undefined => g.steps.find((s) => s.id === id)
  const merged: WfStep[] = []
  for (const id of ids) {
    const b = find(base, id)
    const o = find(outside, id)
    const m = find(mine, id)
    if (!o && m) merged.push(m)
    else if (!m && o) merged.push(o)
    else if (o && m) {
      const pick = <K extends keyof WfStep>(key: K): WfStep[K] =>
        JSON.stringify(m[key]) !== JSON.stringify(b?.[key] ?? null) ? m[key] : (o[key] as WfStep[K])
      merged.push({
        id,
        title: pick('title'),
        specialist: pick('specialist'),
        fallback: pick('fallback'),
        agent: pick('agent'),
        model: pick('model'),
        effort: pick('effort'),
        spec: pick('spec'),
        specFile: pick('specFile'),
        deps: pick('deps'),
        gate: pick('gate'),
        onReject: pick('onReject'),
        sub: pick('sub')
      })
    }
  }
  const layout = { ...outside.layout, ...mine.layout }
  return { id: mine.id || outside.id, title: mine.title || outside.title, steps: merged, layout, parseError: null, raw: '' }
}
