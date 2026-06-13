# Testing

## Unit Tests

Run:

```powershell
node --test test/**/*.test.js
```

Covered behavior:

- text-only parsing still works
- one image normalizes to `media: []`
- multiple images remain as one batch
- duplicate assets are not re-added
- OpenAI Vision partial failure keeps valid assets
- text plus images stays consolidated for Claude

## Simulations

Run local fixtures without WhatsApp:

```powershell
node scripts/test-text.js
node scripts/test-single-image.js
node scripts/test-multiple-images.js
node scripts/test-text-plus-images.js
node scripts/test-invalid-image.js
node scripts/test-all-input-cases.js
```

Fixtures live in `test/fixtures`.

`npm.cmd test:inputs` runs every fixture through the local User Turn simulator.

## Real WhatsApp Smoke Test

1. Send text only and confirm one response.
2. Send one image without text and confirm the agent asks what to do with it.
3. Send three images quickly and confirm there is one grouped response after `IMAGE_MESSAGE_WAIT_SECONDS`.
4. Send text, then three images quickly, for example: `Hazme 3 posts con estas imagenes`.
5. Confirm logs show `MEDIA_BATCH_CREATED`, `BUFFER_MEDIA_BATCH_READY`, and `ORCHESTRATOR_INPUT_SUMMARY`.
6. Confirm Google Sheets still receives draft/calendar/bulk rows.
7. Send `/reset` and confirm context resets.
8. Send audio and confirm `AUDIO_QUEUE` still handles it.
