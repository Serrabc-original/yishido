# Core Features

Este proyecto debe funcionar como un core universal de agentes inteligentes por WhatsApp, no solo como un agente de marketing.

## Core ahora

- Durable Object `ConversationCoordinator` como coordinador de conversacion.
- User Turn como unidad enviada al orquestador.
- Media siempre como array.
- `campaign_assets` como fuente de verdad para lotes de media.
- `last_uploaded_image` solo como compatibilidad.
- Buffer de mensajes para unir texto, audio, imagenes, video y archivos en un turno.
- Audio por `AUDIO_QUEUE`.
- Imagen por `IMAGE_QUEUE`.
- Orquestador con input compacto, no historial crudo completo.
- Google Sheets como integracion existente.
- Logging estructurado con `traceId`.
- Memoria compacta y segura, resumida y sin historial crudo completo.
- Router ligero de utilidades core.
- Recordatorios y listas como utilidades core activas en modo seguro local.
- Mensajes interactivos WhatsApp/Woztell activos en modo seguro con fallback a texto.
- Bug report bundle por `traceId`.

## Configuracion

Defaults locales:

- `DEBUG_LOGS=true`
- `SAVE_CONVERSATION_LOGS=true`
- `ENABLE_USER_STYLE_PROFILE=true`
- `ENABLE_CUSTOMER_MEMORY=true`
- `ENABLE_REMINDERS=true`
- `ENABLE_LISTS=true`
- `ENABLE_WHATSAPP_INTERACTIVE=true`
- `ENABLE_TEMPLATE_MODULE=true`
- `CORE_UTILITIES_SANDBOX=true`
- `REMINDERS_DELIVERY_MODE=mock`
- `INTERACTIVE_DELIVERY_MODE=safe`
- `MEMORY_RETENTION_MODE=summarized`
- `LOG_CAPTURE_MODE=console_and_file`

`/version` muestra estos flags, el modo mock/sandbox y que los recordatorios no tienen entrega real mientras `REMINDERS_DELIVERY_MODE=mock`.

## Compatibilidad

Mantener:

- Woztell;
- OpenAI;
- Claude;
- Cloudflare Workers;
- Google Sheets;
- `/reset`;
- audio queue;
- image queue;
- Durable Object `ConversationCoordinator`.

## No implementado en core

- N8n o Make.
- Meta API.
- Publicacion automatica.
- CRM completo.
- Procesamiento real de video o archivos. Hoy son metadata-only salvo que se agregue soporte explicito.
