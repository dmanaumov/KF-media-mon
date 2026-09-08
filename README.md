# PR-мониторинг — веб-интерфейс команды (v1)

Первая часть сервиса из `pr-monitoring-architecture.md`: таблица фактов публикаций и сводка по клиентам.
Поисковый пайплайн (перепечатки, точный охват) — фаза 2, здесь ещё не подключён.

## Что уже работает

- Простая staff-авторизация (логин/пароль из `.env`).
- Дашборд `/` — все факты (карточки борда «PR департамент» с заполненной «Ссылкой на публикацию»), фильтры по клиенту и статусу, охват из поля UVM.
- `/clients` — сводка по клиентам: сколько фактов, сколько опубликовано, суммарный охват (пока только по вручную заполненным UVM).
- Реальные данные для проверки — засижены из `.boardarchive`, выгруженного 2026-09-08 (31 факт из 193 карточек, клиент ФЛГ).

## Локальный запуск

```bash
npm install
cp .env.example .env      # поправить пароли/секрет
createdb prmonitor         # или через psql, см. ниже
npm run migrate
npm run seed                # опционально — грузит реальные тестовые данные из data/pr-department-board.jsonl
npm start
```

Если Postgres ещё не создан:
```sql
CREATE USER pruser WITH PASSWORD 'prpass';
CREATE DATABASE prmonitor OWNER pruser;
```

## Деплой в Dokploy (по паттерну KF Approval)

Репозиторий: `KF-media-mon`. `docker-compose.yml` + `Dockerfile` уже в репо — сервис `app` (Node, memory limit 256M) + `db` (Postgres 16, memory limit 256M, healthcheck), `app` ждёт `db: condition: service_healthy` (тот же паттерн, что в KF Approval, см. `docker-container-migration-runbook.md`/`kf-approval-mattermost.md`). Миграция (`node src/migrate.js`, идемпотентна — `CREATE TABLE IF NOT EXISTS`) гоняется автоматически при каждом старте контейнера `app`.

1. В Dokploy — новый проект, тип **Docker Compose**, источник — этот git-репозиторий (`dmanaumov/KF-media-mon`, ветка `main`).
2. Обязательные переменные окружения (см. `.env.example`): `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `STAFF_AUTH_USER`, `STAFF_AUTH_PASSWORD`, `SESSION_SECRET`. Задать реальные значения в Dokploy, не в `.env.example`.
3. Сервер — менее загруженный (Германия), как договорились. Явные memory limits уже прописаны в compose — не полагаться только на выбор менее загруженного хоста (см. предупреждение в `pr-monitoring-architecture.md`).
4. Домен — предложение из архитектурной доки: `pr.kontentferma.com`, но можно любой свободный.
5. После первого деплоя — по желанию `docker exec` в контейнер `app` и `npm run seed`, чтобы затравить реальными данными из `data/pr-department-board.jsonl` (сама миграция схемы уже прогоняется автоматически).

## Дальше (не входит в эту итерацию)

- Живой поллинг борда «PR департамент» вместо разового `seed.js` (нужен Mattermost-токен — см. открытые вопросы в `pr-monitoring-architecture.md`, §7).
- Кнопка «Найти перепечатки» на дашборде сейчас не активна — появится вместе с поисковым пайплайном (фаза 2).
- Нормализация «СМИ/ресурс» в `src/seed.js` — рабочая, но простая (домен из URL/текста); при живой синхронизации использовать ту же функцию.
