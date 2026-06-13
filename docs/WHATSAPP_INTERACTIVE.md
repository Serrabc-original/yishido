# WhatsApp Interactive Messages

`src/whatsapp/sendInteractiveMessage.js` prepares interactive WhatsApp/Woztell messages with fallback to plain text.

## When To Use Buttons

Use quick reply buttons when there are up to 3 short choices, for example:

- Aprobar
- Editar
- Cancelar

Buttons should be used for low-risk choices that the user can understand immediately.

## When To Use Lists

Use lists when there are more than 3 options or when choices need descriptions. The builder automatically switches to a list when too many buttons are provided.

## When To Use Templates

Use templates for outbound, business-initiated WhatsApp messages that require approved template flows. The template module flag is active locally, but automatic publishing and Meta API remain out of scope.

## Fallback

Interactive messages are controlled by:

```text
ENABLE_WHATSAPP_INTERACTIVE=true
INTERACTIVE_DELIVERY_MODE=safe
```

In `safe` mode, unsupported or failed interactive sends fall back to text using `fallbackText`. `/debug-interactive` sends a low-risk test message.

## Logs

- `WHATSAPP_INTERACTIVE_SEND_START`
- `WHATSAPP_INTERACTIVE_SEND_OK`
- `WHATSAPP_INTERACTIVE_SEND_FAILED`
- `WHATSAPP_INTERACTIVE_FALLBACK_SENT`

## Limits

- Maximum safe quick replies: 3.
- More than 3 options become a list.
- List rows are capped to 10.
- Payload shape should be validated in Woztell before enabling in production.
