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

## Que no guardar

- tokens;
- API keys;
- headers de autorizacion;
- documentos completos;
- datos medicos, financieros o legales innecesarios;
- historial crudo largo;
- imagenes o archivos completos;
- payloads completos de Woztell salvo necesidad puntual y redaccion manual.
