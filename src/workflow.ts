// Workflow template: schema validation on top of the parsed YAML and placeholder substitution.
import type { WfStep, WfTemplate } from './protocol'
import type { YamlValue } from './yaml'

const SLUG = /^[a-z][a-z0-9-]{0,63}$/

export type ParsedTemplate = {
  id: string
  title: string
  steps: WfStep[]
  specFiles: Record<string, string | null> // step id -> specFile (unresolved path)
}

/** A step's `sub:` children, one level deep: a block runs its children in parallel and its
 *  own specialist (if any) after the required ones; `optional` children start only on request. */
export type WfSubStep = {
  id: string
  title: string | null
  specialist: string | null
  agent: string | null
  model: string | null
  effort: string | null
  spec: string | null
  specFile: string | null
  deps: string[] // sibling sub-step ids only
  optional: boolean
}

function isMap(v: YamlValue): v is { [key: string]: YamlValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: YamlValue, what: string): string {
  if (typeof v !== 'string') throw new Error(`${what}: ожидалась строка`)
  return v
}

function strOrNull(v: YamlValue | undefined, what: string): string | null {
  if (v === undefined || v === null) return null
  return str(v, what)
}

/** Parses and validates one template file; throws with a readable message on any schema violation. */
export function parseTemplate(file: string, yaml: YamlValue): ParsedTemplate {
  if (!isMap(yaml)) throw new Error('корень шаблона должен быть отображением (key: value)')
  const id = str(yaml.id ?? '', 'id')
  if (!SLUG.test(id)) throw new Error(`id "${id}": ожидался slug ^[a-z][a-z0-9-]{0,63}$`)
  const title = str(yaml.title ?? '', 'title')
  const rawSteps = yaml.steps
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error('steps: ожидался непустой список')

  const steps: WfStep[] = []
  const specFiles: Record<string, string | null> = {}
  const seen = new Set<string>()
  for (const raw of rawSteps) {
    if (!isMap(raw)) throw new Error('steps[]: каждый шаг должен быть отображением')
    const stepId = str(raw.id ?? '', 'steps[].id')
    if (!SLUG.test(stepId)) throw new Error(`steps[].id "${stepId}": ожидался slug`)
    if (seen.has(stepId)) throw new Error(`шаг "${stepId}" определён дважды`)
    seen.add(stepId)

    const agent = strOrNull(raw.agent, 'steps[].agent')
    const specialist = strOrNull(raw.specialist, 'steps[].specialist')
    const spec = strOrNull(raw.spec, 'steps[].spec')
    const specFile = strOrNull(raw.specFile, 'steps[].specFile')
    const hasSub = Array.isArray(raw.sub) && raw.sub.length > 0

    const depsRaw = raw.deps
    let deps: string[] = []
    if (depsRaw !== undefined && depsRaw !== null) {
      if (typeof depsRaw === 'string') deps = [depsRaw]
      else if (Array.isArray(depsRaw)) deps = depsRaw.map((d) => str(d, 'steps[].deps[]'))
      else throw new Error(`шаг "${stepId}": deps должен быть списком`)
    }
    if (!specialist && !agent && !hasSub) {
      // A bare barrier (no agent, only deps/gate) is legal: a join point for the DAG.
      if (deps.length === 0) {
        throw new Error(`шаг "${stepId}": нужен specialist (slug), agent, sub-блок или deps-барьер`)
      }
    }
    if (agent && !specialist && !spec && !specFile && !hasSub) {
      throw new Error(`шаг "${stepId}": нужен spec (|) или specFile`)
    }
    if (!agent && !specialist && (spec || specFile)) {
      throw new Error(`шаг "${stepId}": spec у барьера бессмыслен — убери spec/specFile или дай specialist`)
    }

    let gate: WfStep['gate'] = null
    const gateRaw = raw.gate !== undefined ? raw.gate : raw.checkpoint // `checkpoint` — старое имя
    if (gateRaw !== undefined && gateRaw !== null) {
      if (!isMap(gateRaw)) throw new Error(`шаг "${stepId}": gate должен быть {question, options}`)
      const question = str(gateRaw.question ?? '', `шаг "${stepId}": gate.question`)
      const optionsRaw = gateRaw.options
      if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
        throw new Error(`шаг "${stepId}": gate.options должен быть непустым списком`)
      }
      gate = { question, options: optionsRaw.map((o) => str(o, 'gate.options[]')) }
    }

    let onReject: WfStep['onReject'] = null
    if (raw.on_reject !== undefined && raw.on_reject !== null) {
      if (!isMap(raw.on_reject)) throw new Error(`шаг "${stepId}": on_reject должен быть {goto, max_rounds}`)
      const goto = str(raw.on_reject.goto ?? '', `шаг "${stepId}": on_reject.goto`)
      const rounds = raw.on_reject.max_rounds
      onReject = { goto, maxRounds: typeof rounds === 'number' ? rounds : Number(str(rounds ?? '1', 'on_reject.max_rounds')) }
      if (!Number.isInteger(onReject.maxRounds) || onReject.maxRounds < 1) {
        throw new Error(`шаг "${stepId}": on_reject.max_rounds должен быть целым >= 1`)
      }
    }

    // `sub:` block children: parallel, own specialists, one level deep.
    const sub: WfStep['sub'] = []
    const rawSub = raw.sub
    if (rawSub !== undefined && rawSub !== null) {
      if (!Array.isArray(rawSub) || rawSub.length === 0) {
        throw new Error(`шаг "${stepId}": sub должен быть непустым списком подшагов`)
      }
      const subSeen = new Set<string>()
      for (const rawChild of rawSub) {
        if (!isMap(rawChild)) throw new Error(`шаг "${stepId}": sub[] — каждый подшаг отображение`)
        const childId = str(rawChild.id ?? '', 'sub[].id')
        if (!SLUG.test(childId)) throw new Error(`шаг "${stepId}": sub[].id "${childId}" — ожидался slug`)
        if (subSeen.has(childId)) throw new Error(`подшаг "${childId}" в "${stepId}" определён дважды`)
        if (seen.has(childId)) throw new Error(`id "${childId}" уже занят шагом верхнего уровня`)
        subSeen.add(childId)
        seen.add(childId)
        const childAgent = strOrNull(rawChild.agent, 'sub[].agent')
        const childSpecialist = strOrNull(rawChild.specialist, 'sub[].specialist')
        const childSpec = strOrNull(rawChild.spec, 'sub[].spec')
        const childSpecFile = strOrNull(rawChild.specFile, 'sub[].specFile')
        if (!childSpecialist && !childAgent) {
          throw new Error(`подшаг "${childId}": нужен specialist (slug) или agent`)
        }
        const childDepsRaw = rawChild.deps
        let childDeps: string[] = []
        if (typeof childDepsRaw === 'string') childDeps = [childDepsRaw]
        else if (Array.isArray(childDepsRaw)) childDeps = childDepsRaw.map((d) => str(d, 'sub[].deps[]'))
        for (const d of childDeps) {
          if (!subSeen.has(d)) throw new Error(`подшаг "${childId}": зависимость "${d}" вне блока "${stepId}"`)
        }
        sub.push({
          id: childId,
          title: strOrNull(rawChild.title, 'sub[].title'),
          specialist: childSpecialist,
          agent: childAgent,
          model: strOrNull(rawChild.model, 'sub[].model'),
          effort: strOrNull(rawChild.effort, 'sub[].effort'),
          spec: childSpec,
          specFile: childSpecFile,
          deps: childDeps,
          optional: rawChild.optional === true || rawChild.when === 'optional'
        })
        specFiles[childId] = childSpecFile
      }
    }

    steps.push({
      id: stepId,
      title: strOrNull(raw.title, 'steps[].title'),
      agent,
      specialist,
      model: strOrNull(raw.model, 'steps[].model'),
      effort: strOrNull(raw.effort, 'steps[].effort'),
      spec,
      specFile,
      deps,
      gate,
      onReject,
      sub
    })
    specFiles[stepId] = specFile
  }

  // aip-style: steps without deps follow the previous step (the pipeline reads top to bottom).
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].deps.length === 0) steps[i].deps = [steps[i - 1].id]
  }

  for (const step of steps) {
    for (const dep of step.deps) {
      if (!seen.has(dep)) throw new Error(`шаг "${step.id}": зависимость "${dep}" не определена`)
    }
    if (step.onReject && !seen.has(step.onReject.goto)) {
      throw new Error(`шаг "${step.id}": on_reject.goto "${step.onReject.goto}" не определён`)
    }
    if (step.effort && !step.model) {
      throw new Error(`шаг "${step.id}": effort задаётся только вместе с model`)
    }
  }

  void file
  return { id, title, steps, specFiles }
}

/** Substitutes {{placeholders}} in spec/title/question texts. */
export function applyPlaceholders(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (whole, name: string) =>
    name in vars ? vars[name] : whole
  )
}

// ---- materialization: template steps -> flat task units ---------------------------------------

export type WfUnit = {
  id: string
  stepId: string // owning template step (block owner for children)
  title: string | null
  specialist: string | null
  agent: string
  model: string | null
  effort: string | null
  spec: string | null
  specFile: string | null
  deps: string[] // unit ids
  gate: { question: string; options: string[] } | null
  onReject: { goto: string; maxRounds: number } | null
  role: 'step' | 'child'
  optional: boolean
}

export type WfBlockWatch = {
  /** A parentless block with on_reject: reject when any watched child task fails. */
  children: string[]
  goto: string
  maxRounds: number
}

/** Flattens steps with `sub:` blocks into task units. Children (non-optional) gate on the
 *  block's external deps; the block's own specialist runs after its required children;
 *  a dep on a block id expands to all its required members (join). */
export function materialize(steps: WfStep[]): { units: WfUnit[]; blockWatches: WfBlockWatch[] } {
  const byId = new Map(steps.map((s) => [s.id, s]))
  const isBlock = (id: string): boolean => (byId.get(id)?.sub?.length ?? 0) > 0
  /** Join members of a dep id: block -> required children (+ parent unit when it exists). */
  const expandDep = (id: string, hasParentUnit: Map<string, boolean>): string[] => {
    const step = byId.get(id)
    if (!step) return [id]
    if (!isBlock(id)) return [id]
    const members: string[] = []
    for (const child of step.sub ?? []) if (!child.optional) members.push(child.id)
    if (hasParentUnit.get(id)) members.push(id)
    return members
  }
  const hasParentUnit = new Map<string, boolean>()
  for (const s of steps) hasParentUnit.set(s.id, Boolean(s.agent || s.specialist))

  const units: WfUnit[] = []
  const blockWatches: WfBlockWatch[] = []
  for (const step of steps) {
    const external = step.deps.flatMap((d) => expandDep(d, hasParentUnit))
    if (isBlock(step.id)) {
      for (const child of step.sub ?? []) {
        units.push({
          id: child.id,
          stepId: step.id,
          title: child.title,
          specialist: child.specialist,
          agent: child.agent ?? '',
          model: child.model,
          effort: child.model ? child.effort : null,
          spec: child.spec,
          specFile: child.specFile,
          deps: child.optional ? [] : child.deps.length > 0 ? [...child.deps] : [...external],
          gate: null,
          onReject: null,
          role: 'child',
          optional: child.optional
        })
      }
      if (hasParentUnit.get(step.id)) {
        units.push({
          id: step.id,
          stepId: step.id,
          title: step.title,
          specialist: step.specialist,
          agent: step.agent ?? '',
          model: step.model,
          effort: step.model ? step.effort : null,
          spec: step.spec,
          specFile: step.specFile,
          deps: (step.sub ?? []).filter((c) => !c.optional).map((c) => c.id),
          gate: step.gate,
          onReject: step.onReject,
          role: 'step',
          optional: false
        })
      } else if (step.onReject) {
        blockWatches.push({
          children: (step.sub ?? []).filter((c) => !c.optional).map((c) => c.id),
          goto: step.onReject.goto,
          maxRounds: step.onReject.maxRounds
        })
      }
    } else {
      units.push({
        id: step.id,
        stepId: step.id,
        title: step.title,
        specialist: step.specialist,
        agent: step.agent ?? '',
        model: step.model,
        effort: step.model ? step.effort : null,
        spec: step.spec,
        specFile: step.specFile,
        deps: [...external],
        gate: step.gate,
        onReject: step.onReject,
        role: 'step',
        optional: false
      })
    }
  }
  // Gate-on-block: a gate declared on a parentless block gates its first child.
  for (const step of steps) {
    if (!step.gate || !isBlock(step.id) || hasParentUnit.get(step.id)) continue
    const firstChild = units.find((u) => u.stepId === step.id && !u.optional)
    if (firstChild) firstChild.gate = step.gate
  }
  return { units, blockWatches }
}

/** Topological order of materialized units (stable for parallel branches). */
export function topoUnits(units: WfUnit[]): WfUnit[] {
  const byId = new Map(units.map((u) => [u.id, u]))
  const seen = new Set<string>()
  const out: WfUnit[] = []
  const visit = (id: string, stack: Set<string>): void => {
    if (seen.has(id)) return
    if (stack.has(id)) return
    stack.add(id)
    for (const dep of byId.get(id)?.deps ?? []) visit(dep, stack)
    stack.delete(id)
    seen.add(id)
    const unit = byId.get(id)
    if (unit) out.push(unit)
  }
  for (const unit of units) visit(unit.id, new Set())
  for (const unit of units) if (!seen.has(unit.id)) out.push(unit)
  return out
}

export function templateForError(file: string, id: string, title: string, message: string): WfTemplate {
  void file
  return { id, title, source: 'library', sourcePath: null, file: file, steps: [], error: message }
}
