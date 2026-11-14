// Unit tests for the mini-YAML parser and the template schema validation.
import { assert, test } from 'orca/testing'
import { materialize } from './workflow'
import { parseYaml } from './yaml'
import { applyPlaceholders, parseTemplate } from './workflow'

const TEMPLATE = `# комментарий
id: feature-dev
title: 'Фича: план → ревью'
steps:
  - id: plan
    title: План (openspec)
    agent: claude
    spec: |
      строка 1

      строка 3 с {{objective}}
  - id: plan-review
    agent: claude
    specFile: specs/plan-review.md
    deps: [plan]
  - id: dev-gate
    deps: [plan-review]
    gate: { question: 'План аппрувнут?', options: [approve, request-changes] }
  - id: research
    worker: researcher
    deps: [plan]
    sub:
      - { id: probe, worker: researcher, optional: true }
  - id: dev
    agent: claude
    model: some-model
    effort: high
    specFile: specs/dev.md
    deps: [dev-gate]
    on_reject: { goto: dev, max_rounds: 2 }
`

test('парсер: fallback-цепочка на шаге и подшаге', () => {
  const value = parseYaml(`id: t
title: T
steps:
  - id: dev
    agent: claude
    spec: |
      работать
    fallback: [codex, kimi]
  - id: tests
    agent: claude
    spec: |
      проверить
    sub:
      - { id: test-api, agent: claude, fallback: [zcode] }
`) as { [k: string]: unknown }
  const steps = value.steps as Array<{ [k: string]: unknown }>
  assert.deepEqual(steps[0].fallback, ['codex', 'kimi'])
  const child = (steps[1].sub as Array<{ [k: string]: unknown }>)[0]
  assert.deepEqual(child.fallback, ['zcode'])
  assert.deepEqual(parseTemplate('t', value as never).steps[0].fallback, ['codex', 'kimi'])
})

test('фазы подшагов: before_start готовит, before_end параллелен, after — постшаг', () => {
  const tpl = parseTemplate('phases', parseYaml(`
id: phases
title: Фазы
steps:
  - id: plan
    worker: planner
    sub:
      - { id: prep, worker: researcher }
      - { id: side, worker: researcher, phase: before_end }
      - { id: post, worker: researcher, phase: after, optional: true }
  - id: review
    worker: reviewer
    sub:
      - { id: arch, worker: reviewer, phase: before_end }
    on_reject: { goto: plan, max_rounds: 2 }
  - id: dev
    worker: coder
`))
  assert.deepEqual(tpl.steps[0].sub.map((c) => [c.id, c.phase]), [
    ['prep', 'before_start'],
    ['side', 'before_end'],
    ['post', 'after']
  ], 'фаза читается, дефолты: обязательный → before_start, optional → after')
  const { units } = materialize(tpl.steps)
  const deps = new Map(units.map((u) => [u.id, u.deps]))
  assert.deepEqual(deps.get('prep'), [], 'before_start наследует позицию родителя (первый шаг — без deps)')
  assert.deepEqual(deps.get('side'), [], 'before_end стартует вместе с родителем')
  assert.deepEqual(deps.get('post'), ['plan'], 'after ждёт родителя')
  assert.deepEqual(deps.get('plan'), ['prep'], 'родитель ждёт только before_start-подшаги')
  assert.ok((deps.get('review') ?? []).includes('arch') === false, 'before_end НЕ блокирует родителя')
  assert.ok((deps.get('dev') ?? []).includes('arch'), 'следующий шаг ждёт и родителя, и его before_end-подшаги')
})

test('воркеры: только worker:, specialist больше не читается', () => {
  const good = parseTemplate('t', parseYaml('id: t\ntitle: T\nsteps:\n  - { id: a, worker: coder }\n'))
  assert.equal(good.steps[0].specialist, 'coder')
  assert.throws(
    () => parseTemplate('t', parseYaml('id: t\ntitle: T\nsteps:\n  - { id: a, specialist: coder }\n')),
    /нужен worker/,
    'specialist без agent/spec больше не валиден'
  )
})

test('парсер: блоки, потоки, кавычки, блочные скаляры', () => {
  const value = parseYaml(TEMPLATE) as { [k: string]: unknown }
  assert.equal(value.id, 'feature-dev')
  assert.equal(value.title, 'Фича: план → ревью')
  const steps = value.steps as Array<{ [k: string]: unknown }>
  assert.equal(steps.length, 5)
  assert.equal(steps[0].agent, 'claude')
  assert.equal(steps[0].spec, 'строка 1\n\nстрока 3 с {{objective}}\n')
  assert.deepEqual(steps[1].deps, ['plan'])
  const gate = steps[2].gate as { [k: string]: unknown }
  assert.equal(gate.question, 'План аппрувнут?')
  assert.deepEqual(gate.options, ['approve', 'request-changes'])
  assert.equal(steps[3].worker, 'researcher')
  const subChild = (steps[3].sub as Array<{ [k: string]: unknown }>)[0]
  assert.equal(subChild.optional, true)
  const reject = steps[4].on_reject as { [k: string]: unknown }
  assert.equal(reject.goto, 'dev')
  assert.equal(reject.max_rounds, 2)
})

test('парсер: числa/булевы/null и комментарии после значений', () => {
  const value = parseYaml('a: 7\nb: true\nc: null\nd: текст с # не комментарий в значении? нет — это комментарий\n') as {
    [k: string]: unknown
  }
  assert.equal(value.a, 7)
  assert.equal(value.b, true)
  assert.equal(value.c, null)
  assert.equal(typeof value.d, 'string')
})

test('парсер: вложенные списки в потоке и пустой список', () => {
  const value = parseYaml('a: []\nb: [x, y]\nc: {k: [1, 2], j: v}\n') as { [k: string]: unknown }
  assert.deepEqual(value.a, [])
  assert.deepEqual(value.b, ['x', 'y'])
  const c = value.c as { [k: string]: unknown }
  assert.deepEqual(c.k, [1, 2])
})

test('парсер: невалидный отступ падает с номером строки', () => {
  assert.throws(() => parseYaml('a: 1\n  b: 2\n'), /строка 2/)
})

test('шаблон: валидация проходит, поля на месте', () => {
  const parsed = parseTemplate('feature-dev.yaml', parseYaml(TEMPLATE))
  assert.equal(parsed.id, 'feature-dev')
  assert.equal(parsed.steps[4].model, 'some-model')
  assert.equal(parsed.specFiles['plan-review'], 'specs/plan-review.md')
})

test('шаблон: неизвестная зависимость отклоняется', () => {
  const bad = TEMPLATE.replace('deps: [plan]', 'deps: [nope]')
  assert.throws(() => parseTemplate('feature-dev.yaml', parseYaml(bad)), /nope/)
})

test('шаблон: спецификация без агента и специалиста отклоняется', () => {
  const bad = TEMPLATE.replace('  - id: dev\n    agent: claude\n    model: some-model', '  - id: dev\n    model: some-model')
  assert.throws(() => parseTemplate('feature-dev.yaml', parseYaml(bad)), /dev/)
})

test('шаблон: checkpoint — старое имя gate — тоже читается', () => {
  const legacy = TEMPLATE.replace(
    "    gate: { question: 'План аппрувнут?', options: [approve, request-changes] }",
    "    checkpoint: { question: 'План аппрувнут?', options: [approve, request-changes] }"
  )
  if (legacy === TEMPLATE) throw new Error('fixture replace not applied')
  const parsed = parseTemplate('feature-dev.yaml', parseYaml(legacy))
  assert.equal(parsed.steps[2].gate?.question, 'План аппрувнут?')
})

test('плейсхолдеры подставляются, неизвестные остаются', () => {
  const out = applyPlaceholders('цель {{objective}}, репо {{repo}}, {{unknown}}', {
    objective: 'фича X',
    repo: 'biz.erp'
  })
  assert.equal(out, 'цель фича X, репо biz.erp, {{unknown}}')
})
