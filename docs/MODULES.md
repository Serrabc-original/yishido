# Modules

Los modulos opcionales quedan preparados como stubs seguros. No se activan por defecto y no cambian el flujo principal.

## Core ahora

- `src/logger.js`: logger estructurado con redaccion de secretos.
- `src/conversationMemory.js`: resumen compacto, perfil de estilo opcional y customer memory opcional.

## Modulo opcional

- `src/modules/templates/`: borrador para WhatsApp templates. Variable: `ENABLE_TEMPLATE_MODULE=false`.
- `src/modules/reminders/`: borrador para recordatorios. Variable: `ENABLE_REMINDERS=false`.
- `src/modules/customerMemory/`: read model de memoria de cliente. Variable: `ENABLE_CUSTOMER_MEMORY=false`.
- `src/modules/crmLite/`: propuesta de CRM-lite sin activacion.
- `src/modules/orders/`: propuesta de intake de ordenes.
- `src/modules/support/`: propuesta de tickets de soporte.

## Backlog

- Motor real de recordatorios con zona horaria, consentimiento y reintentos.
- Templates aprobados por WhatsApp con catalogo y estados.
- CRM-lite con tags, pipeline y handoff humano.
- Orders agent con catalogo, precio, disponibilidad y confirmacion.
- Support agent con SLA, prioridades y destino de tickets.
- Sales follow-up assistant con ventanas de contacto y reglas anti-spam.
- Elderly assistant con reglas reforzadas de seguridad, contacto de emergencia y consentimiento.

## Regla de activacion

Antes de activar cualquier modulo grande:

1. definir datos minimos;
2. definir retencion;
3. definir consentimiento;
4. agregar pruebas;
5. mantener intacto el core.
