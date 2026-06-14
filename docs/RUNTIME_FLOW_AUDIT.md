# Runtime Flow Audit

Fecha: 2026-06-14

Objetivo: documentar la ruta real de produccion para que los modulos conversacionales no queden como arquitectura paralela.

## Ruta real del webhook

El webhook publico en `src/index.js` recibe eventos Woztell/WhatsApp, extrae el mensaje con `extractWoztellMessage`, normaliza el evento con `inboundEventCollector` y envia el cuerpo al Durable Object por `https://conversation.local/message`.

Para audio, el webhook tambien crea un trabajo de transcripcion, pero el mensaje original entra al Durable Object como `AUDIO` pendiente. El transcript vuelve luego por `https://conversation.local/tool-result`.

## Ruta real del Durable Object

`ConversationCoordinator.fetch` enruta:

- `/message` hacia `receiveMessage`.
- `/tool-result` hacia `receiveToolResult`.
- alarmas hacia `processBuffer`.

`receiveMessage` usa `normalizeInboundEvent` y `shouldIgnoreInboundEvent` para bloquear status events, unsupported events y duplicados por `messageId`. Despues normaliza el mensaje con `normalizeIncomingMessage` y lo agrega con `appendPendingEvent`.

## Ruta que procesa el buffer

`processBuffer` toma `data.pendingMessages`, espera silencio, max wait, user done o transcripts de audio listos, y construye `userTurn = buildUserTurn(messages, data.campaignState, { turnId })`.

Desde este punto, `UserTurn` es la unidad enviada a supervisor/orchestrator. Sus campos de autoridad son:

- `combinedUserText` / `current_turn_text`
- `audioTranscripts`
- `images`
- `media_batch`
- `counts`

## Ruta que analiza imagenes

La ruta preferida es:

`processBuffer -> createConversationSupervisorPlan -> handleVisionUtility -> analyzeMediaBatch`

`handleVisionUtility` usa `userTurn.media_batch`, no `last_uploaded_image`.

La ruta legacy en `executePlan` todavia existe para acciones de orchestrator tipo `analyze_uploaded_image`, pero ahora arma el batch desde `buildMediaBatch(..., { userTurn })` y bloquea la caida a un solo asset cuando `UserTurn.images` tiene mas imagenes.

## Ruta que procesa audios transcritos

El webhook guarda el mensaje como `AUDIO` pendiente. La transcripcion llega por `receiveToolResult` con `type: "audio_transcribed"`.

El texto visible para IA se guarda limpio:

- sin `[Audio transcrito]:`
- sin `[Texto adicional]:`
- como `audioTranscript`
- unido por `UserTurn` en orden temporal

La ruta legacy que convertia audio a texto prefijado queda bloqueada con `LEGACY_AUDIO_TEXT_PREFIX_BLOCKED`.

## Ruta que construye respuesta final

Las respuestas conversacionales finales deben pasar por `sendConversationalResponse`, que llama a `customerReplyComposer`.

Excepciones aceptadas:

- comandos tecnicos como `/version`, `/reset`, `/lists`, `/reminders`
- respuestas internas de control o fallbacks tecnicos

Vision en `handleVisionUtility` ya usa composer. La respuesta legacy de vision en `executePlan` tambien fue cableada a composer.

## Partes nuevas conectadas

- `inboundEventCollector`: conectado en `receiveMessage`.
- `turnAggregator`: conectado via `appendPendingEvent`, readiness y logs de turno.
- `userTurnBuilder`: conectado en `buildUserTurn` / `attachUserTurnContract`.
- `mediaBatchBuilder`: conectado cuando `buildMediaBatch` recibe `userTurn`.
- `customerReplyComposer`: conectado via `sendConversationalResponse`.

## Partes nuevas agregadas pero vigiladas

No debe haber un segundo flujo de produccion paralelo. Los modulos nuevos se usan desde `src/index.js`; cualquier cambio futuro debe reforzar esta ruta, no crear otra.

## Rutas legacy que siguen activas con guardas

- `executePlan` para acciones marketing/orchestrator antiguas.
- Envio directo de comandos tecnicos.
- `last_uploaded_image` como compatibilidad solamente.
- `campaign_assets` como historico/source of truth de media, pero no debe pisar `UserTurn.media_batch` del turno actual.

Guardas/logs:

- `LEGACY_IMAGE_SINGLE_ASSET_PATH_BLOCKED`
- `LEGACY_AUDIO_TEXT_PREFIX_BLOCKED`
- `LEGACY_ORCHESTRATOR_DIRECT_REPLY_BLOCKED`
- `LEGACY_MARKETING_PATH_ALLOWED`
- `LEGACY_MARKETING_PATH_BLOCKED`
