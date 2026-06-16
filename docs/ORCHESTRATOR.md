# Orchestrator

The default orchestrator is OpenAI.

```text
ORCHESTRATOR_PROVIDER=openai
ORCHESTRATOR_MODEL=gpt-5.4
ORCHESTRATOR_FALLBACK_PROVIDER=
```

Claude remains available as an optional fallback provider, but the current default keeps fallback disabled unless `ORCHESTRATOR_FALLBACK_PROVIDER=claude` is set intentionally. Do not delete the Claude provider or its configuration.

## Switching Providers

Use OpenAI:

```text
ORCHESTRATOR_PROVIDER=openai
ORCHESTRATOR_MODEL=gpt-5.4
ORCHESTRATOR_FALLBACK_PROVIDER=
```

Use OpenAI with Claude fallback intentionally enabled:

```text
ORCHESTRATOR_PROVIDER=openai
ORCHESTRATOR_MODEL=gpt-5.4
ORCHESTRATOR_FALLBACK_PROVIDER=claude
```

Use Claude directly:

```text
ORCHESTRATOR_PROVIDER=claude
ORCHESTRATOR_MODEL=
```

## Neutral Contract

The orchestrator must return valid JSON:

```json
{
  "intent": "general|marketing|reminder|list|crm|orders|support|elderly|unknown",
  "confidence": 0.0,
  "should_handle_in_core": true,
  "target_module": "core|marketing|reminders|lists|crmLite|orders|support|elderly",
  "needs_clarification": false,
  "clarification_question": "",
  "actions": [],
  "user_facing_ack": "",
  "state_updates": {}
}
```

`final_response_mode` is still accepted internally for backward compatibility, but the neutral contract above is preferred.

## Intent First

The orchestrator should:

1. classify intent first;
2. avoid assuming every request is marketing;
3. route reminders and lists to core utilities when enabled;
4. use marketing actions only when `intent=marketing`;
5. ask a brief clarification if intent or required fields are unclear.

## Compact Input

The orchestrator receives:

- `current_turn_summary`
- `current_turn_text`
- `media_batch_summary`
- `audio_transcripts`
- `video_metadata`
- `file_metadata`
- `conversation_summary`
- `user_style_profile`
- `customer_memory`
- `utility_memory`
- `relevant_previous_state`
- `allowed_actions`
- `campaign_state_brief`

It should not receive full raw history when compact state is enough.

## Marketing Compatibility

The existing marketing action list remains available, but it is filtered unless `intent=marketing`:

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

## Logs

- `ORCHESTRATOR_PROVIDER_SELECTED`
- `ORCHESTRATOR_MODEL_SELECTED`
- `ORCHESTRATOR_INPUT_COMPACTED`
- `ORCHESTRATOR_INTENT_DETECTED`
- `ORCHESTRATOR_ACTIONS_SELECTED`
- `ORCHESTRATOR_FALLBACK_USED`
