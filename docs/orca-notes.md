# Опыт работы с Orca (host API, CLI, dev-цикл)

Памятка для будущих сессий: всё, что стоило крови при разработке workflow-view.
Проверено на Orca ≥ 1.4.248, macOS, конец 2026.

## Dev-цикл плагина

```bash
orca plugin dev load .          # загрузить папку как dev-плагин
orca plugin dev reload          # перезагрузить воркер+панели (открытые вкладки НЕ обновляются!)
orca plugin dev request <key> <handler> --data '<json>'   # дёрнуть хендлер воркера как панель
orca plugin dev emit <key> <event>                        # кинуть событие воркеру
orca plugin logs <key>          # логи воркера (ошибки агентных запусков видны здесь)
orca plugin test                # node-тесты: src/*.test.ts через orca/testing
orca plugin check               # статическая проверка манифеста + редактора
orca plugin validate .          # схема манифеста (подсказывает поля: screenshots, icon, cover!)
```

**Скриншоты**: `orca plugin shot <key> --panel <id> [--width N]` / `--editor <файл> [--width --height]`
/ `--window` (всё окно) / `--theme light|dark`. Панель ограничена ~1190px шириной; манифесту
нужны скриншоты ≥1280×800 — апскейль lanczos'ом (PIL). Харнесс снимает вкладку из
`html.tab` storage — ставь её через `ui.set` перед снимком. `--act` работает только для
components-панелей, не HTML. Анализ картинки моделью зрения ненадёжен — сверяй пиксели
программно (PIL: цвет в колонке/полосе).

**Критично**: после `dev reload` открытые панели/редакторы держат СТАРЫЙ код. «Сломалось»
после серии релоадов = переоткрой вкладку. В проде этого нет.

## Host API (типы: /Applications/Orca.app/Contents/Resources/plugins/types/orca-host.d.ts)

- У каждого метода есть `surfaces: worker|panel|editor` — панель НЕ может `editor.open`,
  воркер может всё терминальное.
- `workspace.readContext` может **виснуть вечно** (модальные окна, нет фокуса) — всегда
  `Promise.race` с таймаутом. Возвращает `{branch, displayName, terminals}` БЕЗ id воркспейса —
  id ищи в `workspace.list`/`worktree list` по displayName/branch.
- `terminal.sendText` жёстко скоуплен **активным ворктри**: «terminal is outside the active
  worktree». Фоновый терминал исполняет команду только когда его воркспейс активен;
  созданный «в фоне» терминал с командой откладывает её до активации.
- `agent.launch` (host) печатает промт в момент создания терминала — если агент ещё
  грузится, промт падает в пустой шелл (`agent_launch_terminal_not_running_agent`).
  **Надёжный путь — CLI**: `orca agent launch --agent X --worktree path:... --prompt ... --json`
  (он ждёт агента). После запуска проверяй тайтл терминала (Claude Code/Codex/…) и ретрай.
- `editor.open {workspaceId, path}` открывает таб в окне, где открыт ЭТОТ воркспейс; окно
  не выбирается. Перед ним `workspace.open` — нужное окно всплывёт вперёд.
- Хочешь спавнить процессы из воркера — trusted-worker может `node:child_process`.
  Это фундамент нашего моста: `bash -c` без терминалов вообще.

## Оркестрация (CLI)

- Мутации (`run-create/task-create/gate-*/worker-start/run-use/send`) требуют
  идентичность отправителя: `--from <handle живого терминала>`; мёртвый хендл →
  `stable_pane_required`; без контекста → `no_active_sender_terminal`. Живой спящий
  терминал-хелпер подходит (у нас `workflow-view-runner`, создаётся host-вызовом —
  без видимой вкладки; CLI-создание вкладку показывает).
- Один ран = один координатор: `run-use` фенсит прошлого (`consumer_fenced`). В ране
  с живым координатором panel-старты воркеров отвергаются — и это правильно.
- `worker-start` пускает только ready-задачу (`task_not_startable` + unmetDependencies) —
  DAG движка главный судья порядка. `task-update --status completed/pending/failed`
  пишется БЕЗ проверки зависимостей (ручной инструмент).
- Статусы задач: pending/ready/dispatched/completed/failed/blocked. **skipped нет** —
  выводится производно на панели.
- `worker-read --dispatch <id> --json` → `result.transcript.messages[].blocks[]`:
  текст ассистента = блоки `type:'text'` у `role:'assistant'` (tool-call блоки — мусор).
- Сообщения: `send --to dispatch:<id>/run:<id>` доставляет и **будит** агента;
  `check --json` — ящик, `reply --id`. `inbox` принимает `--terminal`, не `--from`.
- Хранилище: `~/Library/Application Support/orca/orchestration.db` (sqlite, WAL).
  Удаление ранов — напрямую SQL в транзакции; `dispatch_contexts` содержит диспетчер
  в колонке **`id`** (не dispatch_id); JOIN с `worker_dispatches.dispatch_id`.
  Живые состояния воркеров: `starting`, `ready` (у dispatch), остальное — settled.
- Каталог моделей: `agent-model-catalog.db`, таблица `rows(key,value)` — value это JSON
  `{agent, discovered:{models:[{id,label}]}}`; воркспейсы в `worktree list` различаются
  по **displayName** (поля name нет). Аргументы-алиасы (opus→glm-5.3) — смотри подписи,
  окно контекста у алиаса может быть меньше (1M — отдельный id `glm-5[1m]`-стиля).

## Селекторы и мелочи

- worktree-селектор: `path:<p>`, `id:<repoId>::<path>`, `name:<displayName>` (может быть
  `selector_ambiguous` — давай path/id).
- `orca terminal list --json` — глобальный список; у записи `orphaned` (нет панели),
  `title` (агент сам называет). `terminal close` убивает pty.
- CLI-вывод: envelope `{ok, result}` + возможный мусор вокруг — парсь срезом от первого
  `{` до последнего `}`.
- `--json` у CLI-команд с mutациями печатает requestId — полезно в ошибках.
- Плагинный storage общий у воркера и панелей (это наш кэш снимка и html.* состояние).

## Тестирование (orca/testing)

- `mockHost({storage, results})`: results — значение или функция; `host.callsOf`, refusals.
- Наш спавн-сим: экспортированный `spawnHooks.exec` подменяется canned-ответами по
  подстрокам команды; мутации в canned требуют `--from` (как настоящий CLI) — но
  не применяй эвристику к командам, несущим брифы (там встречается « run-use »).
- Скоростные швы: `coordLaunch.bootWaitMs` (ожидание бута агента).
- События: `worker.emit('workspace.changed', …)` сбрасывает кэши.
