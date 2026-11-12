// Unit tests for the mini-YAML parser and the template schema validation.
import { assert, test } from 'orca/testing'
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
    checkpoint: { question: 'План аппрувнут?', options: [approve, request-changes] }
  - id: dev
    agent: claude
    model: some-model
    effort: high
    specFile: specs/dev.md
    deps: [dev-gate]
    on_reject: { goto: dev, max_rounds: 2 }
`

test('парсер: блоки, потоки, кавычки, блочные скаляры', () => {
  const value = parseYaml(TEMPLATE) as { [k: string]: unknown }
  assert.equal(value.id, 'feature-dev')
  assert.equal(value.title, 'Фича: план → ревью')
  const steps = value.steps as Array<{ [k: string]: unknown }>
  assert.equal(steps.length, 4)
  assert.equal(steps[0].agent, 'claude')
  assert.equal(steps[0].spec, 'строка 1\n\nстрока 3 с {{objective}}\n')
  assert.deepEqual(steps[1].deps, ['plan'])
  const gate = steps[2].checkpoint as { [k: string]: unknown }
  assert.equal(gate.question, 'План аппрувнут?')
  assert.deepEqual(gate.options, ['approve', 'request-changes'])
  const reject = steps[3].on_reject as { [k: string]: unknown }
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
  assert.equal(parsed.steps[3].model, 'some-model')
  assert.equal(parsed.specFiles['plan-review'], 'specs/plan-review.md')
})

test('шаблон: неизвестная зависимость отклоняется', () => {
  const bad = TEMPLATE.replace('deps: [plan]', 'deps: [nope]')
  assert.throws(() => parseTemplate('feature-dev.yaml', parseYaml(bad)), /nope/)
})

test('шаблон: спецификация без агента отклоняется', () => {
  const bad = TEMPLATE.replace('  - id: dev\n    agent: claude\n    model: some-model', '  - id: dev\n    model: some-model')
  assert.throws(() => parseTemplate('feature-dev.yaml', parseYaml(bad)), /dev/)
})

test('плейсхолдеры подставляются, неизвестные остаются', () => {
  const out = applyPlaceholders('цель {{objective}}, репо {{repo}}, {{unknown}}', {
    objective: 'фича X',
    repo: 'biz.erp'
  })
  assert.equal(out, 'цель фича X, репо biz.erp, {{unknown}}')
})
