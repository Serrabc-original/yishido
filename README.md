# whatsapp-agent-core

Yishido Agent Gateway is a Cloudflare Worker core for WhatsApp AI agents. The first use case is a marketing agent, but the core is intentionally kept reusable for orders, support, lightweight CRM, and assistant-style agents.

Current architecture:

- Woztell receives WhatsApp webhooks.
- The Worker routes each conversation to `ConversationCoordinator`.
- The Durable Object buffers text and media before processing.
- User Turn Builder groups the short burst of WhatsApp events into one `current_turn`.
- Audio goes through `AUDIO_QUEUE`.
- Generated or edited images go through `IMAGE_QUEUE`.
- OpenAI handles copy, image generation/editing, audio transcription, and image vision.
- OpenAI is the default JSON orchestrator.
- Google Sheets stores drafts, calendars, posts, and status updates.

Important constraints:

- No N8n or Make.
- No Meta API yet.
- No automatic publishing yet.
- Media is always normalized as `media: []`.
- Multiple images are processed as a batch.
- Audio is represented in the turn first, then updated when transcription finishes.
- Video and files are accepted as metadata-only inputs for now.
- `campaign_assets` is the source of truth for uploaded images.
- `last_uploaded_image` remains only for compatibility.

## Local Checks

Use direct Node commands in PowerShell if `npm.ps1` is blocked:

```powershell
node --check src\index.js
node --test test/**/*.test.js
node scripts/test-all-input-cases.js
node scripts/test-text-plus-images.js
```

## Deploy

`wrangler.toml` points to `src/index.js`, which is the real Worker entrypoint.

## WhatsApp Control Commands

- `/help`: shows general assistant capabilities.
- `/context`: shows `activeIntent`, `contextId`, `lastUserGoal`, pending clarification, current-turn media count, previous relevant media count, and stale media count.
- `/clear-media`: clears previous images/files without deleting lists or reminders.
- `/lists`: shows saved lists for the conversation.
- `/reminders`: shows pending reminders.
- `/clear-reminders`: clears mock/local reminders for the conversation.
- `/debug-interactive`: sends a safe interactive-message test with text fallback.
- `/reset`: clears conversation context, previous media, campaign state, and pending clarification.

## Local Feature Modes

Local development enables the assistant core by default:

- `DEBUG_LOGS=true`
- `ENABLE_LISTS=true`
- `ENABLE_REMINDERS=true`
- `ENABLE_WHATSAPP_INTERACTIVE=true`
- `ENABLE_TEMPLATE_MODULE=true`
- `SAVE_CONVERSATION_LOGS=true`
- `ENABLE_USER_STYLE_PROFILE=true`
- `ENABLE_CUSTOMER_MEMORY=true`
- `CORE_UTILITIES_SANDBOX=true`
- `REMINDERS_DELIVERY_MODE=mock`
- `INTERACTIVE_DELIVERY_MODE=safe`
- `MEMORY_RETENTION_MODE=summarized`
- `LOG_CAPTURE_MODE=console_and_file`

Run `/version` in WhatsApp to see which capabilities are active and which are mock/sandbox.

## Local Logs

Capture local Worker logs without copying terminal output manually:

```powershell
npm run dev:log
npm run logs:latest
npm run logs:analyze
```

Logs are written under `logs/agent-YYYY-MM-DD.log` and ignored by Git.
`dev:log` also writes `logs/dev-latest.log`, which `logs:latest` reads first.
