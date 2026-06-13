import { parseListCommand } from "./modules/lists/index.js";
import { parseReminderRequest } from "./modules/reminders/index.js";

export function routeCoreUtilityIntent(userTurn, options) {
  const cleanOptions = options || {};
  const text = String(userTurn && (userTurn.current_turn_text || userTurn.text || "") || "");
  const normalized = normalizeText(text);
  const flags = cleanOptions.flags || {};

  if (isReminderIntent(normalized)) {
    const parsed = parseReminderRequest(text, cleanOptions.timezone || "UTC", {
      now: cleanOptions.now
    });
    return {
      intent: "reminder",
      confidence: parsed.confidence,
      module: "reminders",
      missingFields: parsed.missingFields,
      shouldHandleInCore: Boolean(flags.enableReminders),
      shouldPassToAgent: !flags.enableReminders,
      parsed: parsed
    };
  }

  if (isListIntent(normalized)) {
    const parsed = parseListCommand(text);
    return {
      intent: "list",
      confidence: parsed.confidence,
      module: "lists",
      missingFields: parsed.missingFields,
      shouldHandleInCore: Boolean(flags.enableLists),
      shouldPassToAgent: !flags.enableLists,
      parsed: parsed
    };
  }

  if (isMarketingIntent(normalized)) {
    return intentResult("marketing", 0.72, "marketing");
  }

  if (isSupportIntent(normalized)) {
    return intentResult("support", 0.68, "support");
  }

  if (isOrdersIntent(normalized)) {
    return intentResult("orders", 0.68, "orders");
  }

  if (isCrmIntent(normalized)) {
    return intentResult("crm", 0.62, "crmLite");
  }

  return intentResult("general", normalized ? 0.5 : 0.1, "core");
}

function intentResult(intent, confidence, module) {
  return {
    intent: intent,
    confidence: confidence,
    module: module,
    missingFields: [],
    shouldHandleInCore: false,
    shouldPassToAgent: true
  };
}

function isReminderIntent(text) {
  return /\b(recuerdame|recordarme|recordatorio|recuérdame|avisame|avísame)\b/.test(text);
}

function isListIntent(text) {
  return /\b(lista|anota|agrega|quita|elimina|muestrame|muéstrame|marca como hecho|pendientes)\b/.test(text);
}

function isMarketingIntent(text) {
  return /\b(post|copy|instagram|facebook|campana|campaña|contenido|calendario|publicacion|publicación|hashtag)\b/.test(text);
}

function isSupportIntent(text) {
  return /\b(soporte|problema|error|ayuda|ticket|reclamo)\b/.test(text);
}

function isOrdersIntent(text) {
  return /\b(pedido|orden|comprar|compra|cotizacion|cotización|precio|envio|envío)\b/.test(text);
}

function isCrmIntent(text) {
  return /\b(cliente|seguimiento|lead|crm|contacto|prospecto)\b/.test(text);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
