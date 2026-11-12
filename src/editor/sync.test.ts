// Session sync through the real document shell, on an in-memory file.
import { assert, mockEditorHost, test } from 'orca/testing'
import { decode, emit } from './core'

const YAML = `id: demo
title: 'Демо'
steps:
  - { id: plan, agent: claude, specFile: specs/plan.md }
  - id: dev
    agent: claude
    specFile: specs/dev.md
    deps: [plan]
    gate: { question: 'Готов?', options: [approve, request-changes] }
`

test('change летит в файл как валидный yaml с layout', async () => {
  const host = mockEditorHost({ text: YAML })
  const doc = await (await import('./sync')).startSession()
  const graph = doc.value
  assert.equal(graph.parseError, null)
  graph.layout.plan = { x: 11, y: 22 }
  graph.steps[1].gate = null
  doc.change(graph)
  await host.flush()
  const onDisk = host.text ?? ''
  assert.ok(onDisk.includes('# workflow-view: layout plan:11,22'), onDisk)
  assert.ok(!onDisk.includes('question'), 'гейт исчез из файла')
  assert.equal(decode(onDisk).parseError, null)
  doc.dispose()
  host.dispose()
})

test('внешняя правка мержится по id, пока у нас черновик', async () => {
  const host = mockEditorHost({ text: YAML })
  const doc = await (await import('./sync')).startSession()

  // Первая правка принята в файл (гейт переименован) — это новая база.
  const first = doc.value
  const dev0 = first.steps.find((s) => s.id === 'dev')
  if (dev0?.gate) dev0.gate.question = 'Мой вопрос?'
  doc.change(first)
  await host.flush()

  // Вторая правка ещё в полёте (модель на dev), и тут файл меняют снаружи:
  // у plan новый заголовок, у dev.gate — чужой вопрос.
  const mine = { ...doc.value, steps: doc.value.steps.map((s) => ({ ...s })) }
  const devMine = mine.steps.find((s) => s.id === 'dev')
  if (devMine) devMine.model = 'my-model'
  doc.change(mine)
  const outsideGraph = decode(YAML)
  for (const s of outsideGraph.steps) {
    if (s.id === 'plan') s.title = 'Чужой заголовок'
    if (s.id === 'dev' && s.gate) s.gate.question = 'Чужой вопрос?'
  }
  host.replace(emit(outsideGraph))
  await host.flush()

  const merged = decode(host.text ?? '')
  assert.equal(merged.parseError, null)
  assert.equal(merged.steps.find((s) => s.id === 'dev')?.model, 'my-model', 'моя правка в полёте выигрывает')
  assert.equal(merged.steps.find((s) => s.id === 'plan')?.title, 'Чужой заголовок', 'чужая правка другого шага входит')
  assert.equal(
    merged.steps.find((s) => s.id === 'dev')?.gate?.question,
    'Чужой вопрос?',
    'поле, которое я не трогал в полёте, берётся снаружи'
  )
  doc.dispose()
  host.dispose()
})
