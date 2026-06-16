# Modules

Modules are optional building blocks for a universal WhatsApp AI Agent Core. The core should stay useful for many agent types without becoming a specialized product too early.

## Core Ahora

- `src/logger.js`: structured logging with secret redaction.
- `src/conversationMemory.js`: compact conversation summary, optional style profile, optional customer memory, utility memory.
- `src/coreUtilityRouter.js`: lightweight intent router for reminders, lists, general, marketing, support, orders, CRM and future elderly flows.
- `src/whatsapp/sendInteractiveMessage.js`: WhatsApp/Woztell interactive message builder and sender with text fallback.
- `src/agent/`: active task/agent runtime for tasks, lightweight CRM actions and handoff policy.
- `src/agents/`: specialist agent registry for intent-specific behavior.
- `scripts/export-bug-report.js`: redacted bug report bundle by `traceId`.

## Modulo Opcional

- `src/modules/reminders/`: parser, reminder storage and delivery-path selection for `mock`, `alarm` and template-gated delivery. Variable: `ENABLE_REMINDERS=false`.
- `src/modules/lists/`: notes/lists parser and mock/local list storage. Variable: `ENABLE_LISTS=false`.
- `src/modules/templates/`: WhatsApp templates stub. Variable: `ENABLE_TEMPLATE_MODULE=false`.
- `src/modules/customerMemory/`: customer memory read model. Variable: `ENABLE_CUSTOMER_MEMORY=false`.
- `src/modules/crmLite/`: lightweight CRM module scaffold used by the active task/agent runtime; full CRM remains future work.
- `src/modules/orders/`: orders intake proposal.
- `src/modules/support/`: support ticketing proposal.

## Backlog

- Cron Triggers, Queues or another reminder scheduler beyond the current Durable Object Alarm path.
- WhatsApp template catalog with approval states.
- CRM-lite with contact tags, pipeline and handoff.
- Orders agent with catalog, pricing and availability.
- Support ticketing with SLA and destination system.
- Sales follow-up assistant with anti-spam rules.
- Elderly assistant with safety, consent and emergency-contact rules.

## Activation Rule

Before activating any large module:

1. define minimum data;
2. define retention;
3. define consent;
4. add tests;
5. keep `/reset`, audio queue, image queue, Google Sheets and `campaign_assets` intact.
