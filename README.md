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

## Google Cloud OAuth Setup

Use these exact values for the admin/reporting backend when it runs at `https://admin.yishido.com`. The current Worker implements the Gmail OAuth bootstrap routes; the remaining reporting routes belong to the Admin Dashboard, Billing & Reports work.

| Campo en Google Cloud | Valor exacto |
| --- | --- |
| Authorized domains for OAuth consent screen | `yishido.com` |
| App homepage URL | `https://admin.yishido.com` |
| Privacy Policy URL | `https://admin.yishido.com/privacy` |
| Terms of Service URL | `https://admin.yishido.com/terms` |
| Authorized JavaScript origins | `https://admin.yishido.com` |
| Authorized redirect URIs | `https://admin.yishido.com/auth/google/callback` and `http://localhost:8787/auth/google/callback` |
| OAuth scopes, Gmail only | `https://www.googleapis.com/auth/gmail.send` |
| OAuth scopes, Gmail + user OAuth Sheets | `https://www.googleapis.com/auth/gmail.send` and `https://www.googleapis.com/auth/spreadsheets` |
| OAuth scopes, Gmail + Service Account Sheets | `https://www.googleapis.com/auth/gmail.send` only |
| APIs to enable | Gmail API, Google Sheets API, Google Drive API, Apps Script API, Generative Language API |
| Backend health route | `GET https://admin.yishido.com/health` |
| OAuth start route | `GET https://admin.yishido.com/auth/google/start` |
| OAuth callback route | `GET https://admin.yishido.com/auth/google/callback` |
| Generate report route | `POST https://admin.yishido.com/reports/generate` |
| Send report route | `POST https://admin.yishido.com/reports/send` |
| Sync metrics route | `POST https://admin.yishido.com/metrics/sync` |

The OAuth consent screen must use `yishido.com` as the authorized domain. The OAuth client must be a Web application client. The redirect URI configured in Google Cloud must exactly match `GOOGLE_REDIRECT_URI`. Use `https://admin.yishido.com/auth/google/callback` in production and `http://localhost:8787/auth/google/callback` in local development.

Required Worker routes:

```text
GET /health
GET /auth/google/start
GET /auth/google/callback
POST /reports/generate
POST /reports/send
POST /metrics/sync
```

Required environment variables and secrets:

```text
ADMIN_BASE_URL=https://admin.yishido.com
ADMIN_AUTH_SECRET=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=https://admin.yishido.com/auth/google/callback
GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.send
GOOGLE_GMAIL_SENDER_EMAIL=
GOOGLE_GMAIL_REPORT_RECIPIENTS=
GOOGLE_REFRESH_TOKEN=
GEMINI_API_KEY=
REPORTS_SHEETS_MODE=service_account
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=
GOOGLE_REPORTS_SPREADSHEET_ID=
```

If Sheets uses OAuth from the admin user, set:

```text
GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/spreadsheets
REPORTS_SHEETS_MODE=oauth
```

If Sheets uses a Service Account, do not add the Sheets scope to the user OAuth flow. Keep:

```text
GOOGLE_OAUTH_SCOPES=https://www.googleapis.com/auth/gmail.send
REPORTS_SHEETS_MODE=service_account
```

Google Cloud setup steps:

1. Create or select the Google Cloud project for `admin.yishido.com`.
2. Configure the OAuth consent screen with authorized domain `yishido.com`.
3. Add the homepage, privacy policy, and terms URLs listed above.
4. Enable Gmail API.
5. Enable Google Sheets API only if reports export to Sheets.
6. Enable Google Drive API if the app creates or manages spreadsheet files.
7. Enable Apps Script API only if building the direct Looker Studio Community Connector.
8. Enable Generative Language API for Gemini report summaries and anomaly explanations.
9. Create a Web application OAuth client.
10. Add `https://admin.yishido.com` as the only JavaScript origin.
11. Add `https://admin.yishido.com/auth/google/callback` and `http://localhost:8787/auth/google/callback` as redirect URIs.
12. Store the client ID, client secret, refresh token, Gemini key, service account email, and private key as Cloudflare Worker secrets.

Implementation confirmations required before deploy:

- `/auth/google/callback` exists in the Worker and uses exactly `GOOGLE_REDIRECT_URI` as the `redirect_uri` sent to Google.
- No secret, token, client secret, refresh token, service account private key, or API key is hardcoded.
- No real secret is committed to Git.
- `.env.example` contains placeholders only.
- Production secrets are configured with Cloudflare secrets, not plain source files.

Local Gmail OAuth setup:

1. Create the OAuth Client in Google Cloud as a Web application.
2. Add both redirect URIs:

```text
https://admin.yishido.com/auth/google/callback
http://localhost:8787/auth/google/callback
```

3. Create `.dev.vars` locally and do not commit it:

```text
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:8787/auth/google/callback
```

4. Start local dev:

```powershell
npm run dev
```

5. Open:

```text
http://localhost:8787/auth/google/start
```

6. Complete Google consent. In local development only, `/auth/google/callback` returns `refreshToken` when Google provides one.
7. Store the value as a Worker secret:

```powershell
npx.cmd wrangler secret put GOOGLE_REFRESH_TOKEN
```

8. For production, set:

```text
GOOGLE_REDIRECT_URI=https://admin.yishido.com/auth/google/callback
```

Production callback responses do not include token values. They only report `hasRefreshToken`.

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

## Reminder Templates

`REMINDERS_DELIVERY_MODE=alarm` sends reminders inside the WhatsApp 24-hour session window as normal session messages. Reminders due outside that window require an approved WhatsApp template.

Do not invent or hardcode template names. After the template is approved in the provider console, configure:

```text
REMINDER_TEMPLATE_NAME=<approved_template_name>
REMINDER_TEMPLATE_LANGUAGE=es
REMINDER_TEMPLATE_NAMESPACE=<provider_namespace_if_required>
REMINDER_TEMPLATE_PARAM_MODE=body_text
```

Use `/version` to verify `REMINDER_TEMPLATE_STATUS`. If it shows `outside_24h_blocked_template_missing`, reminders outside 24h will stay blocked instead of failing silently. Use `/debug-template-reminder` to inspect the delivery decision without sending a real due reminder.

## Local Logs

Capture local Worker logs without copying terminal output manually:

```powershell
npm run dev:log
npm run logs:latest
npm run logs:analyze
```

Logs are written under `logs/agent-YYYY-MM-DD.log` and ignored by Git.
`dev:log` also writes `logs/dev-latest.log`, which `logs:latest` reads first.
