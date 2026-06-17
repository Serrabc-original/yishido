# Codex Notes

This repo is now being shaped as `whatsapp-agent-core`.

Current product boundary:

- stabilize multimedia intake
- keep the marketing agent as the first use case
- avoid Meta API and automatic publishing
- avoid large new product features

When editing:

- prefer incremental changes
- add tests before changing critical flow
- keep `ConversationCoordinator` intact
- keep `src/index.js` as the deployable source
- keep Woztell, OpenAI, Claude, Google Sheets, R2, KV, and queues compatible

Important batch logs:

- `TURN_CREATED`
- `TURN_BUFFER_STARTED`
- `TURN_BUFFER_READY`
- `TURN_INPUT_TYPES`
- `TURN_TEXT_COUNT`
- `TURN_AUDIO_COUNT`
- `TURN_IMAGE_COUNT`
- `TURN_VIDEO_COUNT`
- `TURN_FILE_COUNT`
- `TURN_CAPTIONS_FOUND`
- `TURN_CONTEXT_POLICY`
- `TURN_CONTEXT_RESET_REASON`
- `MEDIA_BATCH_CREATED`
- `MEDIA_BATCH_ASSET_COUNT`
- `MEDIA_BATCH_FILE_IDS`
- `MEDIA_ASSET_ANALYSIS_START`
- `MEDIA_ASSET_ANALYSIS_OK`
- `MEDIA_ASSET_ANALYSIS_FAILED`
- `MEDIA_BATCH_ANALYSIS_DONE`
- `MEDIA_BATCH_PARTIAL_FAILURE`
- `MEDIA_BATCH_ALL_FAILED`
- `ORCHESTRATOR_INPUT_SUMMARY`
- `ORCHESTRATOR_INPUT_COMPACTED`
- `ORCHESTRATOR_PROVIDER_SELECTED`
- `ORCHESTRATOR_ACTIONS_SELECTED`
- `CAMPAIGN_ASSETS_UPDATED`
- `AUDIO_JOB_RECEIVED`
- `AUDIO_DOWNLOAD_START`
- `AUDIO_DOWNLOAD_OK`
- `AUDIO_TRANSCRIPTION_START`
- `AUDIO_TRANSCRIPTION_OK`
- `AUDIO_TRANSCRIPTION_FAILED`
- `AUDIO_TURN_UPDATE_OK`
- `AUDIO_TIMEOUT`
- `USER_RESPONSE_SENT`
