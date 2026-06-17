# Memory And Logging

## Objetivo

El core guarda suficiente contexto para mejorar respuestas futuras sin mezclar todo el historial crudo en cada prompt.

## Conversation log

`conversationLog` se guarda por `turnId` solo si:

```text
SAVE_CONVERSATION_LOGS=true
```

El log de conversacion contiene:

- `turnId`;
- `traceId`;
- tipos de input;
- conteos de texto, audio, imagen, video y archivo;
- `contextPolicy`;
- preview sanitizado de texto;
- ids de media;
- conteo de assets.

No debe guardar secretos, tokens, headers de autorizacion ni datos sensibles innecesarios.

La memoria corta vive en el Durable Object `ConversationCoordinator` y se limita a los ultimos 20 turnos compactos. `SHORT_TERM_MEMORY_TURNS` puede declararse, pero el runtime lo limita a 20 para evitar que el contexto crezca como historial crudo.

## Resumen compacto

`conversationSummary` se actualiza con un resumen pequeno:

- cantidad de turns;
- turns recientes;
- tipos de input vistos;
- keywords;
- ultima politica de contexto.
- memoria de utilidades (`utilityMemory`) con conteos de recordatorios y nombres de listas, sin payloads crudos.

Este resumen puede enviarse al orquestador porque es compacto.

## User style profile

Se activa con:

```text
ENABLE_USER_STYLE_PROFILE=true
```

Campos preparados:

- tono del usuario;
- idioma;
- nivel de detalle;
- preferencia por respuestas cortas o largas;
- vocabulario frecuente;
- intencion tipica.

Es heuristico y debe considerarse una base, no una verdad absoluta.

## Customer memory

Se activa con:

```text
ENABLE_CUSTOMER_MEMORY=true
```

Debe almacenar solo informacion util y minimizada, por ejemplo terminos de negocio o preferencias no sensibles. No es CRM completo.

## Long-term memory

La memoria larga es opcional y esta desactivada por defecto:

```text
ENABLE_LONG_TERM_MEMORY=false
LONG_TERM_MEMORY_MODE=disabled
LONG_TERM_MEMORY_REQUIRES_CONSENT=true
LONG_TERM_MEMORY_KV_BINDING=SESSIONS_KV
LONG_TERM_MEMORY_NAMESPACE=ltm
```

Cuando `ENABLE_LONG_TERM_MEMORY=true` y `LONG_TERM_MEMORY_MODE=kv`, el Worker usa un adapter KV. No agrega Mem0 ni otro servicio obligatorio.

La escritura requiere consentimiento del usuario por defecto:

- `/memory-on`: guarda permiso para memoria larga opcional.
- `/memory-off`: revoca permiso y borra la memoria larga opcional.
- `/forget-memory`: borra memoria de usuario corta y larga, mantiene listas y recordatorios.
- `/forget-all`: borra memoria, listas, recordatorios, media y contexto de la conversacion.

La memoria larga guarda solo estado compacto:

- perfil estable minimo;
- preferencias de respuesta;
- hechos compactos sanitizados;
- pistas de utilidades como lista activa o conteos.

No guarda `conversationLog`, payloads crudos de Woztell, imagenes, audios, archivos completos, tokens ni historial largo.

## Redaccion de secretos

El logger redacta campos como:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `WOZTELL_ACCESS_TOKEN`
- `WOZTELL_OPEN_API_TOKEN`
- `GOOGLE_SHEETS_SECRET`
- headers `Authorization`

Tambien reduce telefonos en campos conocidos. Aun asi, evita pegar payloads crudos en logs.

## Uso de traceId

Cada User Turn recibe un `traceId`. Para investigar:

1. busca el `traceId` en `logs/agent-YYYY-MM-DD.log`;
2. revisa eventos desde `WEBHOOK_RECEIVED` hasta `USER_RESPONSE_SENT`;
3. si hay `ERROR_CAPTURED`, revisa `logs/errors-YYYY-MM-DD.log` si existe;
4. ejecuta `npm run logs:analyze`.

## Trace buffer por conversacion

Ademas de los logs de consola/Cloudflare, el `ConversationCoordinator` guarda un buffer compacto en `traceEvents`.

Ese buffer:

- vive dentro del Durable Object de la conversacion;
- conserva solo los ultimos eventos operativos;
- guarda estados como `USER_TURN_READY`, `REQUEST_CONTEXT_COMPACTED`, `SUPERVISOR_PLAN_CREATED`, `TURN_BUFFER_READY`, `MEDIA_BATCH_CREATED`, `AGENT_EXECUTION_PLAN_CREATED`, `TURN_PROCESSING_DONE`, `TURN_PROCESSING_FAILED` y `USER_FALLBACK_SENT`;
- redacta secretos, telefonos, URLs de media, headers, cuerpos crudos y payloads completos;
- no reemplaza los logs externos, pero permite diagnosticar una conversacion desde WhatsApp.

Comandos utiles:

- `/debug-logs`: muestra los ultimos eventos compactos de la conversacion.
- `/trace`: alias de `/debug-logs`.
- `/health`: muestra estado del asistente, pendientes, errores recientes, media, memoria y utilidades.

## Que no guardar

- tokens;
- API keys;
- headers de autorizacion;
- documentos completos;
- datos medicos, financieros o legales innecesarios;
- historial crudo largo;
- imagenes o archivos completos;
- payloads completos de Woztell salvo necesidad puntual y redaccion manual.
