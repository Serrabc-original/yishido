# Stable WhatsApp Webhook URL

## Why the trycloudflare URL changes

`wrangler dev --remote` or a local tunnel can expose the Worker through a temporary `trycloudflare.com` URL. That URL is meant for short debugging sessions, so it can change every time the tunnel restarts. If Woztell points to that URL, you have to update the webhook after each local run.

## Recommended Option: Deployed Worker URL

Use the deployed Cloudflare Worker as the stable webhook endpoint.

Current Worker name in `wrangler.toml`:

```text
yishido-agent-gateway
```

Recommended webhook URL format:

```text
https://yishido-agent-gateway.<your-workers-subdomain>.workers.dev
```

Cloudflare shows the exact `workers.dev` URL after deploy. Put that URL in Woztell once and keep local tunnels only for occasional debugging.

## Scripts

```powershell
npm.cmd run deploy:check
npm.cmd run deploy:dev
npm.cmd run tail
```

- `deploy:check`: runs `wrangler deploy --dry-run` and verifies the Worker bundle without publishing.
- `deploy:dev`: deploys the Worker from `src/index.js` using the current `wrangler.toml`.
- `tail`: follows deployed Worker logs with `wrangler tail`.

`deploy:dev` currently deploys the configured Worker `yishido-agent-gateway`. This project does not yet define a separate Cloudflare dev environment with isolated KV, R2, queues, Durable Objects, and secrets.

## Woztell Setup

1. Run a dry run:

   ```powershell
   npm.cmd run deploy:check
   ```

2. Deploy when you are ready:

   ```powershell
   npm.cmd run deploy:dev
   ```

3. Copy the exact deployed `workers.dev` URL printed by Wrangler.

4. In Woztell, set the incoming webhook URL to:

   ```text
   https://yishido-agent-gateway.<your-workers-subdomain>.workers.dev
   ```

5. Save it once. Future local `wrangler dev` tunnel URLs do not need to be copied into Woztell.

## Test `/version`

After deployment:

```powershell
curl.exe https://yishido-agent-gateway.<your-workers-subdomain>.workers.dev/version
```

Expected response includes:

- `version: whatsapp-ai-agent-core-v3`
- `ENABLE_LISTS: true`
- `ENABLE_REMINDERS: true`
- `ENABLE_WHATSAPP_INTERACTIVE: true`
- `REMINDERS_DELIVERY_MODE: mock`
- `INTERACTIVE_DELIVERY_MODE: safe`

You can also send `/version` from WhatsApp after Woztell points to the deployed URL.

## Logs

For deployed Worker logs:

```powershell
npm.cmd run tail
```

For local tunnel logs:

```powershell
npm.cmd run dev:log
npm.cmd run logs:latest
npm.cmd run logs:analyze
```

## Local Dev vs Deployed Dev vs Production

| Mode | URL stability | Use case | Logs |
| --- | --- | --- | --- |
| Local `wrangler dev` tunnel | Temporary URL, changes often | Debug code on your machine | `npm.cmd run dev:log` |
| Deployed Worker on `workers.dev` | Stable URL | Real WhatsApp tests without changing Woztell every run | `npm.cmd run tail` |
| Production custom domain | Stable branded URL | Production traffic after domain/routes are configured | `npm.cmd run tail` or Cloudflare dashboard |

## Alternative: Named Tunnel

A named Cloudflare Tunnel can provide a stable hostname for local development, but it adds tunnel configuration and operational state outside this repo. Use it only if you need Woztell to hit your local machine continuously.

Recommended only if:

- you already have a Cloudflare-managed hostname for the tunnel;
- you can keep `cloudflared tunnel run <name>` alive during tests;
- you accept that local machine/network outages will break WhatsApp tests.

This project does not automate Woztell webhook changes. Do that manually in Woztell unless a safe, documented API is added later.

## Production Separation

No `deploy:prod` script was added because this repo does not yet define fully separated production resources. A safe production split should define separate Worker name, KV namespace, R2 bucket, queues, Durable Object migration plan, and secrets before adding a production deploy command.
