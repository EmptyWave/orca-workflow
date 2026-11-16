# workflow-view — Orca plugin

Перед работой с кодом плагина обязательно прочти:

- **[docs/internals.md](docs/internals.md)** — полная логика плагина: архитектура (воркер/панель/редактор), мост (CLI runner), схема шаблона (фазы подшагов, воркеры), координатор-агент, панель (сессионная привязка ранов, попытки, трассер), редактор (layout, project detection), тесты и швы, известные ограничения.
- **[docs/orca-notes.md](docs/orca-notes.md)** — опыт работы с Orca: host API (quirks: readContext виснет, sendText скоуплен, agent.launch теряет промт — используй CLI), оркестрационный CLI (`--from`, фенсы, статусы, транскрипты), dev-цикл (`plugin dev load/reload/request/shot/test`), sqlite (`orchestration.db`, `agent-model-catalog.db`), все грабли.

Оба документа написаны по итогам живой разработки и тестирования — экономят дни археологии.
