# Serditov CRM

Отдельный форк Twenty для команды продаж. Проверено локально 2026-10-15.

## Что работает

- Twenty v2.47.0, PostgreSQL 16 и Redis 7.4; образ Twenty закреплён digest.
- Лиды, заказы и ученики платформы как отдельные сущности Twenty с русскими названиями.
- Приём полных снимков через `POST /events/funnel` и `POST /events/lms`.
- Отдельная HMAC-подпись каждого источника, проверка времени и размера запроса.
- SQLite-очередь с WAL: ответ 202 отправляется после сохранения события.
- Повтор одного события не создаёт новую запись. Более старая версия не откатывает данные.
- При недоступности API событие остаётся в очереди и повторяется с задержкой до пяти минут.
- Поля менеджера не входят в обновляемые снимки.

Схема и тестовые записи созданы через API, без изменения ядра Twenty.
Платформа подключается через `integration/src/publish.mjs` и совместимый HTTP-контракт.
Боевые источники ещё не включены; здесь только вымышленные тестовые данные.

## Локальный запуск

В корне форка:

```bash
set -a
source ~/.config/secrets/bitwarden-agents.env
set +a
~/.local/bin/hermes-secrets run serditov/local.env.bws -- docker compose -f serditov/compose.yaml up -d
~/.local/bin/hermes-secrets run serditov/local.env.bws -- node serditov/integration/scripts/local-session.mjs bootstrap
~/.local/bin/hermes-secrets run serditov/local.env.bws -- node serditov/integration/scripts/local-session.mjs smoke
CRM_QUEUE_PATH="$PWD/serditov/.local/queue.sqlite" ~/.local/bin/hermes-secrets run serditov/local.env.bws -- node serditov/integration/scripts/local-session.mjs server
```

CRM: <http://localhost:3033>. Приёмник: <http://localhost:3034/healthz>.
Все опубликованные порты привязаны к loopback. Postgres и Redis снаружи не опубликованы.
Логин локального администратора: `crm-local@serditov.example`.
Пароль: Bitwarden Infra, `SERDITOV_CRM_LOCAL_ADMIN_PASSWORD`; не помещать его в чат, файл или argv.
Локальный launcher получает короткую сессию штатным входом Twenty, держит её в памяти и обновляет при необходимости.
Это только локальная проверка. Для production приёмнику нужен отдельный API token с ограниченными правами.

Файл `local.env.bws` содержит только ссылки на Bitwarden. Значения на диск не записываются.
Не запускать `docker compose config`, `docker inspect` или дамп окружения с подставленными секретами.

## Контракт событий

```json
{
  "schemaVersion": 1,
  "eventId": "lead_fl_demo_revision_1",
  "entity": "lead",
  "recordId": "fl_demo",
  "revision": 1,
  "occurredAt": "2026-10-15T00:00:00.000Z",
  "data": {
    "name": "Тестовый лид",
    "funnelLeadId": "fl_demo",
    "platformUserId": "",
    "telegramId": "",
    "email": "test@example.invalid",
    "phone": "",
    "source": "LOCAL_TEST",
    "offerSlug": "demo-offer"
  }
}
```

`revision` — возрастающее положительное целое для конкретной пары entity/recordId.
Событие содержит полный снимок своих полей; отсутствующие необязательные строки очищаются.
Нельзя использовать время отправки повторной попытки как новую revision.
Для одного eventId повторяется тот же нормализованный снимок. Другой снимок с тем же ID или revision даёт 409.

Заголовки: `x-crm-timestamp` — Unix seconds, `x-crm-signature` —
`sha256=HMAC_SHA256(source_secret, timestamp + '.' + raw_body)`.
Допустимое расхождение времени — пять минут; это проверка запроса, а не срок жизни ссылки.
Повторная попытка использует свежую подпись, сохраняя само событие.

| Источник | entity | Сущность Twenty | Основные данные |
| --- | --- | --- | --- |
| Funnel | lead | platformLead | ID лида, Telegram, источник, контакты, предложение |
| LMS | order | platformOrder | ID заказа, ID ученика и лида, статус, сумма в минимальных единицах, валюта |
| LMS | student | platformStudent | ID ученика, контакты, подтверждённое состояние доступа, если оно передано LMS |

Ученик имеет `recordId = platformUserId`, лид — `recordId = funnelLeadId`.
Заказ принимает `paymentStatus`: pending, paid, refunded, partially_refunded, cancelled.
`amountMinor` — целое >= 0; `currencyCode` — три заглавные латинские буквы.
Лиды разных воронок не объединяются автоматически по email или телефону.
Записи связаны внешними ID; нативные relation-поля и объединение контактов ещё не добавлены.

## Владение данными

LMS владеет ценами, платежами и доступами. Funnel владеет лидами и источниками.
CRM показывает снимки для менеджеров. Обратных вызовов, меняющих оплату или доступ, нет.
Webhook-ключ Twenty и секреты платформы никогда не поступают в браузер.

Полученный 202 означает сохранение в очереди. Завершение записи в Twenty асинхронно.
Процесс worker должен быть единственным для конкретного SQLite-файла.
Несколько реплик с общей SQLite-базой не поддерживаются; для масштабирования нужна отдельная очередь/БД.
История обработанных событий сохраняется для защиты от повторов; очистка автоматически не запускается.
`/healthz` проверяет жизнь процесса. Он не подтверждает исправность Twenty или отсутствие отложенных событий.
Для production нужны наблюдение за pending/attempts, резервное копирование очереди и базы CRM.

## Проверки

```bash
cd serditov/integration
npm test
```

Проверяются подписи, разные источники, конфликт снимков, сохранение после перезапуска,
запоздавшие события, повтор после ошибки API и полный HTTP-путь publisher → receiver.
Команда smoke использует настоящий локальный Twenty, создаёт только три фиксированные
демо-записи и проверяет их чтением через API. Она отказывается работать с другим URL.

## Размещение

`compose.yaml` предназначен для localhost. Для production подготовить отдельные
server, worker, PostgreSQL, Redis, хранилище файлов и приёмник с постоянным томом.
Хостинг платформы — Timeweb App Platform. Совместимость и ресурсы нового приложения CRM
в Timeweb ещё не проверены. Production-домены, DNS, webhook и текущие приложения не изменялись.
Публикация потребует отдельной явной команды владельца согласно AGENTS.md платформы.
Не деплоить этот localhost compose как production-конфигурацию.

## Лицензия и обновления

Сохраняется upstream LICENSE. Коммерческие Enterprise-файлы не изменялись.
Собственный код лежит в `serditov/`; ядро Twenty остаётся без изменений.
Локальный checkout sparse: корневые файлы и `packages/twenty-docker`.
Полная история/исходники доступны в форке; для изменения ядра расширить sparse-checkout.
Исходный main форка: aaee94d72ddeb6f15b7af76e243e5857f656fdea.
Runtime зафиксирован отдельно на выпущенном образе v2.47.0.
