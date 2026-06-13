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
- Memoria compacta y segura, apagada para datos sensibles por defecto.

## Configuracion

Variables nuevas:

- `DEBUG_LOGS=false`
- `SAVE_CONVERSATION_LOGS=false`
- `ENABLE_USER_STYLE_PROFILE=false`
- `ENABLE_CUSTOMER_MEMORY=false`
- `ENABLE_REMINDERS=false`
- `ENABLE_TEMPLATE_MODULE=false`

Las features sensibles no se activan por defecto.

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
