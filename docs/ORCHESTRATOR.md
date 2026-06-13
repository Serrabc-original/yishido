# Orchestrator

Claude remains the active orchestrator.

Configuration:

```text
ORCHESTRATOR_PROVIDER=claude
ORCHESTRATOR_MODEL=
```

`ORCHESTRATOR_PROVIDER=openai` exists as a safe stub route and currently falls back to Claude so production behavior does not change.

## Compact Input

The orchestrator receives:

- `current_turn_summary`
- `current_turn_text`
- `media_batch_summary`
- `audio_transcripts`
- `video_metadata`
- `file_metadata`
- `relevant_previous_state`
- `allowed_actions`
- `campaign_state_brief`

It should not receive full raw history unless the current turn explicitly references previous context.

## Allowed Actions

The compatibility action list remains:

- `generate_copy`
- `generate_image`
- `edit_image`
- `analyze_uploaded_image`
- `save_draft_to_sheets`
- `create_content_calendar`
- `generate_bulk_posts`
- `approve_draft`
- `mark_ready_to_publish`
- `request_changes`
- `ask_clarification`
