# Input Cases

The core groups WhatsApp events into a User Turn. One turn can contain text, captions, images, audio, video, and files.

| Case | Expected behavior |
| --- | --- |
| Text only | Build one text turn and send compact input to the orchestrator. |
| Audio only | Buffer audio placeholder, wait for transcription, then use transcript. If it fails or times out, send audio fallback. |
| Several audios | Wait for available transcripts, consolidate them, and continue if one fails. |
| Image only | Store one asset in `campaign_assets` and ask/route based on intent. |
| Image with caption | Keep caption in `captions` and current turn text. |
| Several images together | Store all as one media batch with asset indexes. |
| Several images one by one | Buffer window groups them into one turn. |
| Several images with captions | Preserve captions and build one media batch. |
| Images then text | Same turn if inside buffer window; text is instruction. |
| Text then images | Same turn if inside buffer window; text is instruction. |
| Audio then images | Wait for transcript up to `AUDIO_TURN_WAIT_SECONDS`; use images regardless. |
| Images then audio | Same as above. |
| Text + audio + images | Consolidate text, transcript, and media summary in one turn. |
| Video | Store metadata only; do not run Vision on video. |
| File | Store metadata only; do not parse document content yet. |
| “Usa la segunda imagen” | `shouldUsePreviousContext` allows previous context and `asset_index: 2` can be referenced. |
| New request after previous post | `shouldStartNewTurn` separates new media/request from old campaign context. |
| `/reset` | Clears pending state and campaign state through the existing reset path. |

Fixtures for these cases live in `test/fixtures`. Run:

```powershell
npm.cmd run test:inputs
```
