# AI Runtime Flow And Prompts

This Worker keeps Woztell as the WhatsApp channel and uses the Worker/Durable Object as the conversation brain.

## Runtime Flow

```text
Woztell webhook
-> inbound event collector
-> pending turn in ConversationCoordinator
-> processBuffer/alarm
-> UserTurn
-> MediaBatch
-> supervisor/orchestrator
-> specialist modules: vision, image generation, audio transcription, utilities
-> customer reply composer
-> Woztell sendResponses
```

## Active Models

| Purpose | Config | Default |
| --- | --- | --- |
| Orchestrator | `ORCHESTRATOR_MODEL` | `gpt-5.4-mini` |
| Supervisor config | `SUPERVISOR_MODEL` | `gpt-5.4-mini` |
| Vision | `VISION_MODEL` | `gpt-5.4-mini` |
| Final customer reply | `CUSTOMER_REPLY_MODEL` | `gpt-5.4-mini` |
| Image generation | `OPENAI_IMAGE_MODEL` | `gpt-image-2` |
| Audio transcription | `AUDIO_TRANSCRIPTION_MODEL` | `whisper-1` |

Claude/Anthropic compatibility code exists, but production config uses OpenAI as the active orchestrator and has no fallback provider enabled.

## Orchestrator Contract

The orchestrator must return JSON only. It should not write the final user-facing answer.

Core rules:

- Classify intent first.
- Use `general` for ordinary questions.
- Use `image_question` or `image_ocr` for analysis of uploaded images.
- Use `image_generation` when the user explicitly asks to generate, create, design, edit, or modify an image.
- Use `marketing` only when the user explicitly asks for posts, copy, ads, campaigns, Instagram, Facebook, TikTok, or content calendars.
- Never publish to Meta.
- Do not ask generic menus when the user intent is clear.

## Customer Reply Prompt Shape

The final visible WhatsApp response is composed from a JSON prompt with this shape:

```json
{
  "role": "customer_reply_composer",
  "purpose": "Redactar la respuesta final visible de un asistente conversacional de WhatsApp.",
  "output_contract": {
    "type": "json",
    "schema": {
      "text": "string",
      "shouldSend": "boolean"
    }
  },
  "non_negotiable_rules": [
    "Responde en espanol natural, calido, claro y breve.",
    "Si el usuario hizo una pregunta o solicitud clara, responde directo.",
    "Si hay imagenes y texto/audio claro, usa el texto/audio como intencion y las imagenes como evidencia.",
    "Si solo hay imagenes sin instruccion, no describas de golpe: pregunta una aclaracion util con opciones concretas.",
    "Si el sistema analizo imagenes, convierte el analisis en ayuda accionable, no en una descripcion seca.",
    "No digas que no puedes generar imagenes si el intent o nextAction indica image_generation.",
    "No inventes datos que no aparecen en systemResult o visibleFacts."
  ],
  "routing_context": {
    "intent": "general | image_question | image_generation | marketing | ...",
    "targetModules": [],
    "responseStrategy": "",
    "nextAction": ""
  },
  "user_turn": {
    "text": "",
    "inputTypes": [],
    "counts": {
      "text": 0,
      "audio": 0,
      "image": 0,
      "video": 0,
      "file": 0
    },
    "captions": [],
    "audioTranscripts": []
  },
  "media_context": {
    "currentImageCount": 0,
    "recentMediaCount": 0,
    "visibleFacts": [],
    "moduleResult": {}
  },
  "draft_response": ""
}
```

This composer does not decide tools, state, publishing, or workflow. It only turns the selected module result into a human WhatsApp answer.
