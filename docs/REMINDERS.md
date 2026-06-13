# Reminders

`src/modules/reminders/` is an active core utility for WhatsApp reminders. In local development the default delivery mode is mock, so reminders are saved and shown but are not delivered by a real scheduler.

## Supported Parsing

- `Recuerdame manana a las 9 llamar a Juan`
- `Recuerdame 1 dia antes y 1 hora antes de la reunion`
- `Recuerdame esta lista manana a las 8`
- `Hazme acuerdo el viernes pagar la luz`
- `Cancela el recordatorio de comprar leche`
- `Muestrame mis recordatorios`
- `/reminders`
- `/clear-reminders`

The parser returns:

- `action`
- `title`
- `dueAt`
- `timezone`
- `context`
- `reminderOffsets`
- `recurrence`
- `confidence`
- `missingFields`

If date, time, or title is missing, the core asks only for the missing field. References like `eso`, `lo anterior` or `esta lista` can use `activeContext.lastUserGoal`.

## Activation

```text
ENABLE_REMINDERS=true
REMINDERS_DELIVERY_MODE=mock
CORE_UTILITIES_SANDBOX=true
```

Supported modes:

- `mock`: local/safe default. Stores reminders, no automatic delivery.
- `disabled`: reminder requests can be routed away from the core.
- `alarm`: reserved for Durable Object Alarms.
- `cron`: reserved for scheduled delivery.

## Logs

- `REMINDER_PARSE_START`
- `REMINDER_PARSE_OK`
- `REMINDER_PARSE_MISSING_FIELDS`
- `REMINDER_CREATE_OK`
- `REMINDER_CREATE_FAILED`
- `REMINDER_LIST_OK`
- `REMINDER_CANCEL_OK`
