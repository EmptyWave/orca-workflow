// Core editor logic: decode/emit round-trip through the real parser, validation, layout.
import { assert, test } from 'orca/testing'
import { autoLayout, decode, emit, mergeGraphs, validate } from './core'
import { parseTemplate } from '../workflow'
import { parseYaml } from '../yaml'

const YAML = `id: demo
title: 'Демо'
steps:
  - id: plan
    title: 'План'
    agent: claude
    specFile: specs/plan.md
  - { id: rev, agent: claude, specFile: specs/rev.md, deps: [plan] }
  - id: dev
    agent: claude
    model: some-model
    specFile: specs/dev.md
    deps: [rev]
    gate:
      question: 'План готов?'
      options: [approve, request-changes]
    on_reject: { goto: dev, max_rounds: 2 }
`

test('decode: шаги, гейты, on_reject', () => {
  const graph = decode(YAML)
  assert.equal(graph.parseError, null)
  assert.equal(graph.steps.length, 3)
  const dev = graph.steps.find((s) => s.id === 'dev')
  assert.equal(dev?.gate?.question, 'План готов?')
  assert.deepEqual(dev?.deps, ['rev'])
  assert.equal(dev?.onReject?.goto, 'dev')
  assert.equal(dev?.specFile, 'specs/dev.md')
})

test('emit → parseTemplate: round-trip без потерь', () => {
  const graph = decode(YAML)
  graph.layout = { plan: { x: 10, y: 20 }, rev: { x: 220, y: 20 }, dev: { x: 430, y: 20 } }
  const text = emit(graph)
  assert.ok(text.includes('# workflow-view: layout plan:10,20; rev:220,20; dev:430,20'), 'layout-комментарий')
  const again = decode(text)
  assert.equal(again.parseError, null)
  assert.equal(again.steps.length, 3)
  const dev = again.steps.find((s) => s.id === 'dev')
  assert.equal(dev?.gate?.question, 'План готов?')
  assert.deepEqual(dev?.gate?.options, ['approve', 'request-changes'])
  assert.equal(dev?.model, 'some-model')
  assert.equal(dev?.onReject?.maxRounds, 2)
  assert.deepEqual(again.layout.dev, { x: 430, y: 20 })
  // Эмиттер пишет валидный файл и для парсера шаблонов.
  assert.equal(parseTemplate('x', parseYaml(text)).steps.length, 3)
})

test('emit: инлайн-спека и русские кавычки выживают', () => {
  const graph = decode(YAML)
  const plan = graph.steps.find((s) => s.id === 'plan')
  if (plan) {
    plan.specFile = null
    plan.spec = "Строка с 'кавычкой'\nи второй строкой"
  }
  const again = decode(emit(graph))
  assert.equal(again.parseError, null)
  assert.equal(again.steps.find((s) => s.id === 'plan')?.spec, "Строка с 'кавычкой'\nи второй строкой\n")
})

test('decode: битый файл даёт parseError, а не исключение', () => {
  const bad = decode('id: demo\nsteps:\n  - id: x\n    deps: [nope]\n')
  assert.ok(bad.parseError)
  assert.ok(bad.parseError.includes('nope'))
})

test('validate: цикл, битая зависимость, агент без спеки', () => {
  const graph = decode(YAML)
  const dev = graph.steps.find((s) => s.id === 'dev')
  const plan = graph.steps.find((s) => s.id === 'plan')
  if (dev) dev.deps = ['dev'] // self-loop
  if (plan) plan.deps = ['ghost']
  const errors = validate(graph)
  assert.ok(errors.some((e) => e.includes('цикл')), errors.join('; '))
  assert.ok(errors.some((e) => e.includes('ghost')), errors.join('; '))
})

test('autoLayout: вертикально — уровни вниз, параллельные рядом', () => {
  const graph = decode(YAML)
  const layout = autoLayout(graph)
  assert.ok(layout.rev.y > layout.plan.y, 'rev ниже plan')
  assert.ok(layout.dev.y > layout.rev.y, 'dev ниже rev')
  // Параллельные ветки на одном уровне — в строке, бок о бок.
  graph.steps.push({ ...graph.steps[0], id: 'parallel', deps: ['rev'], title: 'Параллельный' })
  const withParallel = autoLayout(graph)
  assert.equal(withParallel.parallel.y, withParallel.dev.y, 'один уровень зависимостей — одна строка')
  assert.ok(Math.abs(withParallel.parallel.x - withParallel.dev.x) > 100, 'стоят рядом по горизонтали')
})

test('mergeGraphs: по id — чужая правка полем, моя — другим полем', () => {
  const base = decode(YAML)
  const outside = decode(YAML)
  const mine = decode(YAML)
  const o = outside.steps.find((s) => s.id === 'dev')
  const m = mine.steps.find((s) => s.id === 'dev')
  if (o?.gate) o.gate.question = 'Чужой вопрос?'
  if (m) m.model = 'my-model'
  if (m) m.title = 'Мой заголовок'
  const merged = mergeGraphs(base, outside, mine)
  const dev = merged.steps.find((s) => s.id === 'dev')
  assert.equal(dev?.gate?.question, 'Чужой вопрос?')
  assert.equal(dev?.model, 'my-model')
  assert.equal(dev?.title, 'Мой заголовок')
})

test('aip-шаблон: specialist вместо агента валиден, подшаги не теряются', () => {
  const text = `id: feature-dev
title: 'Фича'
steps:
  - id: plan
    title: 'План'
    worker: planner
    sub:
      - { id: research, title: 'Ресерч', worker: researcher, optional: true }
  - { id: dev, title: 'Разработка', worker: coder, gate: { question: 'Пустить?', options: [approve] } }
  - { id: commit, title: 'Коммит', worker: committer, deps: [dev] }
`
  const graph = decode(text)
  assert.deepEqual(validate(graph), [], 'специалист — не барьер')
  const back = decode(emit(graph))
  assert.equal(back.steps[0].specialist, 'planner')
  assert.equal(back.steps[0].sub.length, 1)
  assert.equal(back.steps[0].sub[0].optional, true)
  assert.equal(back.steps[1].gate?.question, 'Пустить?')
  const noGate = structuredClone(graph.steps)
  noGate[1].gate = null
  assert.deepEqual(validate({ ...graph, steps: noGate }), [])
})

test('on_skip: editor keeps the field on emit; validate mirrors the parser rules', () => {
  const Y2 = YAML
    .replace('options: [approve, request-changes]', 'options: [approve, request-changes, skip]')
    .replace('    on_reject: { goto: dev, max_rounds: 2 }', '    on_reject: { goto: dev, max_rounds: 2 }\n    on_skip: { goto: ship }') +
    '  - { id: ship, agent: claude, specFile: specs/ship.md, deps: [dev] }\n'
  const graph = decode(Y2)
  assert.equal(graph.parseError, null, graph.parseError ?? '')
  assert.deepEqual(graph.steps.find((s) => s.id === 'dev')?.onSkip, { goto: 'ship' })
  assert.deepEqual(validate(graph), [], 'валидный шаблон')
  // Редактор пишет только известные поля: on_skip обязан пережить emit → decode
  const again = decode(emit(graph))
  assert.deepEqual(again.steps.find((s) => s.id === 'dev')?.onSkip, { goto: 'ship' }, 'emit сохраняет on_skip')
  const bad = decode(Y2)
  const dev = bad.steps.find((s) => s.id === 'dev')!
  dev.onSkip = { goto: 'plan' }
  assert.ok(validate(bad).some((e) => e.includes('on_skip.goto "plan" — это сам шаг или шаг позади')), validate(bad).join('; '))
  dev.onSkip = { goto: 'ship' }
  dev.gate!.options = ['approve', 'request-changes']
  assert.ok(validate(bad).some((e) => e.includes('только при гейте с опцией skip')), validate(bad).join('; '))
  // merge: правка on_skip в редакторе не теряется при слиянии с изменениями с диска
  const mine = decode(Y2)
  mine.steps.find((s) => s.id === 'dev')!.onSkip = { goto: 'plan' }
  const base = decode(Y2)
  const merged = mergeGraphs(base, base, mine) // (base, outside, mine): моя правка on_skip при слиянии не теряется
  assert.deepEqual(merged.steps.find((s) => s.id === 'dev')?.onSkip, { goto: 'plan' }, 'mergeGraphs несёт on_skip')
})
