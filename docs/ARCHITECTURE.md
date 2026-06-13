# Architecture

## Request Flow

1. Woztell sends an inbound webhook to the Worker.
2. `extractWoztellMessage` parses text, file id, mime type, and message id.
3. `normalizeIncomingMessage` converts the payload into a stable message shape with `media: []`.
4. Audio messages are accepted quickly and routed to `AUDIO_QUEUE`.
5. Text, image, video, and file messages go to `ConversationCoordinator`.
6. The Durable Object appends `pendingMessages`, updates `hasMedia`, assigns a `turnId`, and calculates `processAfter`.
7. Audio placeholders stay in the turn while `AUDIO_QUEUE` transcribes them.
8. The alarm triggers `processBuffer`.
9. `buildUserTurn` groups text, captions, images, audio, video, and files into one current turn.
10. `buildMediaBatch` collects current-turn assets from `campaign_assets`.
11. `analyzeMediaBatch` calls OpenAI Vision per image asset and keeps partial successes.
12. Claude receives compact current-turn context and returns supported actions only.
11. Tool actions generate copy, images, calendars, bulk posts, or Google Sheets updates.
12. Woztell sends user-facing responses.

## Media Model

Media is always an array, even when one image arrives:

```js
media: [{ type: "IMAGE", fileId, mimeType, fileName }]
```

`campaign_assets` is the durable source of truth. Each asset can be:

- `received`
- `url_pending`
- `analyzed`
- `analysis_failed`
- `metadata_only`

`media_batch_summary` stores aggregate state for Claude. `uploaded_image_analysis` is preserved as a compatibility field and can contain the aggregate summary.

## User Turn

A User Turn is the processing unit sent to the orchestrator. It contains:

- `turn_id`
- `current_turn_text`
- `media_batch_summary`
- `audio_transcripts`
- `video_metadata`
- `file_metadata`
- `context_policy`

Previous campaign content is omitted unless the user explicitly references it, for example “usa la imagen anterior” or “cambia el anterior”.

## Durable Object Safety

The refactor keeps:

- `processedMessageIds`
- stale processing lock reset
- `/reset`
- alarm scheduling
- `pendingMessages`
- `hasMedia`
- `processAfter`
- audio queue routing
- image queue routing
