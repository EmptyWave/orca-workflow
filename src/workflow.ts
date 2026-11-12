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
    const spec = strOrNull(raw.spec, 'steps[].spec')
    const specFile = strOrNull(raw.specFile, 'steps[].specFile')
    if (agent && !spec && !specFile) {
      throw new Error(`шаг "${stepId}": нужен spec (|) или specFile`)
    }
    if (!agent && (spec || specFile)) {
      throw new Error(`шаг "${stepId}": spec/specFile задан, но agent нет — укажи агента или убери спеку`)
    }

    const depsRaw = raw.deps
    let deps: string[] = []
    if (depsRaw !== undefined && depsRaw !== null) {
      if (typeof depsRaw === 'string') deps = [depsRaw]
      else if (Array.isArray(depsRaw)) deps = depsRaw.map((d) => str(d, 'steps[].deps[]'))
      else throw new Error(`шаг "${stepId}": deps должен быть списком`)
    }

    let checkpoint: WfStep['checkpoint'] = null
    if (raw.checkpoint !== undefined && raw.checkpoint !== null) {
      if (!isMap(raw.checkpoint)) throw new Error(`шаг "${stepId}": checkpoint должен быть {question, options}`)
      const question = str(raw.checkpoint.question ?? '', `шаг "${stepId}": checkpoint.question`)
      const optionsRaw = raw.checkpoint.options
      if (!Array.isArray(optionsRaw) || optionsRaw.length === 0) {
        throw new Error(`шаг "${stepId}": checkpoint.options должен быть непустым списком`)
      }
      checkpoint = { question, options: optionsRaw.map((o) => str(o, 'checkpoint.options[]')) }
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

    steps.push({
      id: stepId,
      title: strOrNull(raw.title, 'steps[].title'),
      agent,
      model: strOrNull(raw.model, 'steps[].model'),
      effort: strOrNull(raw.effort, 'steps[].effort'),
      spec,
      deps,
      checkpoint,
      onReject
    })
    specFiles[stepId] = specFile
  }

  for (const step of steps) {
    for (const dep of step.deps) {
      if (!seen.has(dep)) throw new Error(`шаг "${step.id}": зависимость "${dep}" не определена`)
    }
    if (!step.agent && step.deps.length === 0) {
      throw new Error(`шаг "${step.id}": шаг без агента должен иметь deps (иначе он ничего не делает)`)
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

export function templateForError(file: string, id: string, title: string, message: string): WfTemplate {
  void file
  return { id, title, source: 'library', sourcePath: null, file: file, steps: [], error: message }
}
