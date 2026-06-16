import { parseListCommand } from "./modules/lists/index.js";
import { parseReminderRequest } from "./modules/reminders/index.js";

export function routeCoreUtilityIntent(userTurn, options) {
  const cleanOptions = options || {};
  const text = extractRoutableText(String(userTurn && (userTurn.current_turn_text || userTurn.text || "") || ""));
  const normalized = normalizeText(text);
  const flags = cleanOptions.flags || {};
  const media = getTurnMediaCounts(userTurn);

  if (isReminderIntent(normalized) || cleanOptions.pendingReminderDraft && isReminderContinuation(normalized)) {
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

  if (isTaskIntent(normalized)) {
    return intentResult("task", 0.72, "tasks");
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

function isReminderContinuation(text) {
  if (!text) return false;
  if (/\b(ma[nn]ana|hoy|pasado ma[nn]ana|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b/.test(text)) return true;
  if (/\b(a las|a la)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/.test(text)) return true;
  if (/\b(?:para\s+)?(?:en|dentro de)\s+(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h)\b/.test(text)) return true;
  if (/^\s*(si|sí|ok|listo|dale)\s*$/i.test(text)) return true;
  if (/\b(lo que te dije|lo que dije|lo del audio|en el audio|del audio)\b/.test(text)) return true;
  if (/\b(solo|solamente)?\s*(me\s+)?(haces? acuerdo|recuerdame|avisame)\b/.test(text)) return true;
  if (/\bpara\s+.{3,120}/.test(text)) return true;
  return false;
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
  return /\b(recuerdame|recordarme|recordatorio|recordatorios|avisame|hazme acuerdo|acuerdame|cancel(a|ar).*(recordatorio)|muestrame.*recordatorio|mostrar.*recordatorio)\b/.test(text) ||
    /\b(?:para\s+)?(?:en|dentro de)\s+(?:\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h)\b/.test(text) && /\b(comprar|pagar|llamar|hacer|enviar|mandar|escribir|actualizar|revisar)\b/.test(text);
}

function isListIntent(text) {
  if (isReminderIntent(text) && !/\blista\b/.test(text)) return false;
  return /\b(lista|listado|compras|super|supermercado|anota|agrega|quita|elimina|muestrame|mostrar|marca como hecho|marca .*comprado|comprado|pendientes)\b/.test(text);
}

function isImageOcrIntent(text, media) {
  return media.imageCount > 0 && (/\b(saca|extrae|extraer|lee|leer|transcribe|transcribir|anota)\b.*\b(texto|letras|contenido)\b/.test(text) || /\bocr\b/.test(text));
}

function isImageQuestionIntent(text, media) {
  if (media.imageCount <= 0) return false;
  if (isMarketingIntent(text)) return false;
  return /\b(que ves|que aparece|como funciona|que es|que tal|como lo ves|vale la pena|explica|analiza|revisa|esta maquina|esta foto|esta imagen)\b/.test(text);
}

function isMarketingIntent(text) {
  if (/\b(no quiero|sin)\s+(post|posts|marketing|campana|campanas|contenido)\b/.test(text)) return false;
  return /\b(post|posts|copy|caption|instagram|facebook|tiktok|redes sociales|campana|campanas|anuncio|ads|publicidad|publicacion|publicaciones|hashtag|calendario editorial|calendario de contenido|contenido para redes)\b/.test(text);
}

function isTaskIntent(text) {
  if (isReminderIntent(text) || isListIntent(text)) return false;
  if (/\b(muestra|muestrame|ver|lista|listar)\b.*\b(tareas|pendientes|seguimientos)\b/.test(text)) return true;
  if (/\b(guarda|guardar|registra|registrar)\b.*\b(lead|cliente|prospecto|contacto)\b/.test(text)) return true;
  if (/\b(cierra|cerrar|pausa|pausar|cancela|cancelar|termina|terminar|completa|completar)\b.*\b(tarea|pendiente|seguimiento)\b/.test(text)) return true;
  return /\b(tarea|pendiente|seguimiento|hacer seguimiento|llama|llamar|revisa estas fotos|revisa estas imagenes|reporte diario)\b/.test(text);
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

function extractRoutableText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const clean = [];

  for (const line of lines) {
    let value = String(line || "").trim();
    value = value.replace(/^\[\d+\]\s+\w+:\s*/i, "");
    value = value.replace(/^fileId=[^:]+:\s*/i, "");
    value = value.replace(/^\[Audio transcrito\]:\s*/i, "");
    value = value.replace(/^\[Texto adicional\]:\s*/i, "");
    if (!value || /\[IMAGE uploaded/i.test(value)) continue;
    clean.push(value);
  }

  return clean.join("\n").trim() || String(text || "");
}

function getTurnMediaCounts(userTurn) {
  const turn = userTurn || {};
  const current = turn.currentTurnMedia || turn.current_turn_media || {};
  const imageCount = Number(turn.image_count || current.image_count || current.asset_count || 0);

  return {
    imageCount: Number.isFinite(imageCount) ? imageCount : 0
  };
}
