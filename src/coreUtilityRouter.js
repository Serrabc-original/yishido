import { parseListCommand } from "./modules/lists/index.js";
import { parseReminderRequest } from "./modules/reminders/index.js";

export function routeCoreUtilityIntent(userTurn, options) {
  const cleanOptions = options || {};
  const text = String(userTurn && (userTurn.current_turn_text || userTurn.text || "") || "");
  const normalized = normalizeText(text);
  const flags = cleanOptions.flags || {};
  const media = getTurnMediaCounts(userTurn);

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

  if (isImageOcrIntent(normalized, media)) {
    return intentResult("image_ocr", 0.82, "vision");
  }

  if (isImageQuestionIntent(normalized, media)) {
    return intentResult("image_question", 0.78, "vision");
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
  return /\b(recuerdame|recordarme|recordatorio|recordatorios|avisame|hazme acuerdo|acuerdame|cancel(a|ar).*(recordatorio)|muestrame.*recordatorio|mostrar.*recordatorio)\b/.test(text);
}

function isListIntent(text) {
  return /\b(lista|listado|compras|super|supermercado|anota|agrega|quita|elimina|muestrame|mostrar|marca como hecho|marca .*comprado|comprado|pendientes)\b/.test(text);
}

function isImageOcrIntent(text, media) {
  return media.imageCount > 0 && (/\b(saca|extrae|extraer|lee|leer|transcribe|transcribir|anota)\b.*\b(texto|letras|contenido)\b/.test(text) || /\bocr\b/.test(text));
}

function isImageQuestionIntent(text, media) {
  if (media.imageCount <= 0) return false;
  if (isMarketingIntent(text)) return false;
  return /\b(que ves|que aparece|como funciona|que es|explica|analiza|revisa|esta maquina|esta foto|esta imagen)\b/.test(text);
}

function isMarketingIntent(text) {
  if (/\b(no quiero|sin)\s+(post|posts|marketing|campana|campanas|contenido)\b/.test(text)) return false;
  return /\b(post|posts|copy|caption|instagram|facebook|tiktok|redes sociales|campana|campanas|anuncio|ads|publicidad|publicacion|publicaciones|hashtag|calendario editorial|calendario de contenido|contenido para redes)\b/.test(text);
}

function isSupportIntent(text) {
  return /\b(soporte|problema|error|ayuda|ticket|reclamo)\b/.test(text);
}

function isOrdersIntent(text) {
  return /\b(pedido|orden|comprar|compra|cotizacion|precio|envio)\b/.test(text);
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

function getTurnMediaCounts(userTurn) {
  const turn = userTurn || {};
  const current = turn.currentTurnMedia || turn.current_turn_media || {};
  const imageCount = Number(turn.image_count || current.image_count || current.asset_count || 0);

  return {
    imageCount: Number.isFinite(imageCount) ? imageCount : 0
  };
}
