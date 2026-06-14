# WOZTELL Event Contract

This document captures the Worker-facing contract for WOZTELL WhatsApp events and replies. It is based on the official WOZTELL Message Event, BotAPI, and OpenAPI references, plus local Worker constraints. Do not include access tokens, API keys, or raw secret values in examples, logs, tests, or audit notes.

## Official References

- Message Event reference: `https://doc.woztell.com/docs/reference/message-event-reference/`
- OpenAPI reference: `https://doc.woztell.com/open-api-reference/`
- BotAPI reference: `https://doc.woztell.com/docs/reference/bot-api-reference/`

## Common Message Event Fields

WOZTELL message events vary by platform, but the official reference states that `type` and `data` are common fields. For WhatsApp, the documented common shape includes:

- `type`: message type, including `TEXT`, `IMAGE`, and other media types.
- `data`: message payload.
- `data.text`: text content for `TEXT`.
- `data.fileId`: unique WOZTELL file id used to retrieve media through OpenAPI.
- `data.attachments`: attachments for non-text/system messages.
- `from`: WhatsApp sender id.
- `to`: WhatsApp receiver id.
- `timestamp`: epoch milliseconds.
- `messageId`: optional or platform-provided message id.

The Worker also preserves these local routing fields when present:

- `member`: WOZTELL member id.
- `channel`: WOZTELL channel id.
- `app`: WOZTELL app id.
- `caption`: caption text from `data.caption`, `body.caption`, or attachment caption/text.

## Inbound Types

### TEXT

Accepted as user text when `type` is `TEXT` and a non-empty `data.text` or `text` value exists. Multiple text messages in one turn are appended in timestamp/message order and become one `combinedUserText`.

### IMAGE

Accepted as media evidence. `fileId` must be preserved. Captions stay attached to the image by `messageId` and `fileId`. Multiple images in separate webhooks must be accumulated in `pendingEvents`/`pendingMessages` and processed as one batch when they belong to the same user turn.

### AUDIO

Accepted as audio media and queued for transcription. `VOICE` and `PTT` are normalized to `AUDIO`. Transcribed audio becomes clean user text for the turn, without internal prefixes. Multiple audio transcripts are joined in order.

### VIDEO

Accepted as metadata-only unless explicit video processing is added. Preserve `fileId`, `mimeType`, `fileName`, caption, and message metadata.

### FILE

Accepted as metadata-only unless explicit file processing is added. Preserve `fileId`, `mimeType`, `fileName`, caption, and message metadata.

### LOCATION

If WOZTELL sends `LOCATION`, preserve it as a location event. Do not convert it into empty text. It can participate in `UserTurn.locations` and counts, but it is metadata-only until explicit location handling is added.

## Status And Unsupported Events

Ignore status events and do not add them to user turns:

- `SENT`
- `DELIVERED`
- `READ`
- compatible status aliases such as delivery/read status payloads

Unsupported WhatsApp errors, including code `131051`, must be ignored as user input. They must not create `TEXT` with an empty body. The Worker logs them as ignored unsupported events and keeps the current pending turn clean.

## Normalized Event Shape

Each accepted inbound webhook is normalized to:

```json
{
  "eventId": "",
  "messageId": "",
  "type": "TEXT",
  "text": "",
  "caption": "",
  "fileId": "",
  "timestamp": 0,
  "channelId": "",
  "memberId": "",
  "appId": "",
  "from": "",
  "rawType": "",
  "isStatusEvent": false,
  "isUnsupported": false
}
```

Rules:

- Append every accepted inbound event to the pending turn.
- Deduplicate by `messageId`, not by `type`.
- Preserve `fileId` for every media event.
- Preserve captions per image.
- Do not synthesize empty `TEXT` for empty `type`, status events, or unsupported/error events.

## Sending Replies With BotAPI sendResponses

Use BotAPI `POST https://bot.api.woztell.com/sendResponses?accessToken=...` with the token in the query string. Never log the token.

Request body shape:

```json
{
  "channelId": "WOZTELL_CHANNEL_ID",
  "memberId": "WOZTELL_MEMBER_ID_OR_NULL",
  "recipientId": "WHATSAPP_PHONE_OR_NULL",
  "response": [
    {
      "type": "TEXT",
      "text": "Hello"
    }
  ]
}
```

`channelId` is required. WOZTELL requires either `memberId` or `recipientId`.

### memberId vs recipientId

- `memberId`: WOZTELL's internal member id. Prefer this when available because it is stable inside WOZTELL.
- `recipientId`: integration recipient id, such as WhatsApp phone number. WOZTELL documents that this is integration-specific and not guaranteed by every integration creator.

The Worker may attempt member-based send first when `memberId` exists and fall back to recipient-based send only through the existing safe send attempts.

## OpenAPI Audit Usage

OpenAPI exposes `chat` and `conversationHistory` queries with `conversation:read`, `member:getConversation`, or `api:admin` scope. Use them for audit/debugging only:

- Query by `messageId` via `chat` when investigating a single event.
- Query `conversationHistory` with filters/cursors when reconstructing a customer thread.
- Store only the minimal evidence needed: ids, types, timestamps, selected text previews, and media file ids.
- Do not store or print tokens.
- Do not use OpenAPI audit history as the source of truth for the current turn when local `pendingEvents`/`pendingMessages` are enough.

## Worker Invariants

- `campaign_assets` is the source of truth for uploaded media batches.
- `last_uploaded_image` is compatibility state only and may represent only the latest image.
- `UserTurn` is the unit sent to the orchestrator.
- `MediaBatch` for current processing must come from `UserTurn.images` plus active task assets, deduped by `fileId`/`messageId`.
- Text/audio intent wins over `unknown_image_request` when clear text exists.
- Video and files remain metadata-only until explicit processing support is added.

