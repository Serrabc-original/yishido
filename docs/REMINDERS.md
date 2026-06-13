# Reminders

`src/modules/reminders/` provides a base reminder utility for WhatsApp.

## Supported Parsing

Examples:

- `Recuérdame mañana a las 9 llamar a Juan`
- `Recuérdame 1 día antes y 1 hora antes de la reunión`
- `Recuérdame el viernes comprar medicina`
- `Anota un recordatorio para pagar la luz el 30 a las 8am`

The parser returns:

- `title`
- `dueAt`
- `timezone`
- `context`
- `reminderOffsets`
- `recurrence`
- `confidence`
- `missingFields`

If date or time is missing, the core can ask a short clarification.

## Activation

```text
ENABLE_REMINDERS=false
```

When disabled, reminder requests pass to the orchestrator. When enabled, the core can create/list mock reminders in Durable Object state or local tests.

## No Real Scheduler Yet

Production reminder delivery is not active. For production, choose one:

- Durable Object alarms;
- Cron Triggers;
- Queue-based scheduler;
- external scheduler.

## Logs

- `REMINDER_PARSE_START`
- `REMINDER_PARSE_OK`
- `REMINDER_PARSE_MISSING_FIELDS`
- `REMINDER_CREATE_OK`
- `REMINDER_CREATE_FAILED`
- `REMINDER_LIST_OK`
- `REMINDER_CANCEL_OK`
