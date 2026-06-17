import { parseListCommand } from "../modules/lists/index.js";
import {
  INTENT_ROUTER_V2_SCHEMA_VERSION,
  buildIntentTask,
  normalizeIntentRouterV2Result
} from "./intentRouterV2.schema.js";

export function routeIntentV2(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || {};
  const state = clean.conversationState || {};
  const tenant = clean.tenantConfig || {};
  const timezone = String(clean.timezone || tenant.timezone || state.timezone || "America/Guayaquil");
  const locale = String(userTurn.locale || tenant.locale || "es-EC");
  const text = extractTurnText(userTurn);
  const normalized = normalizeText(text);
  const conversationMode = normalizeConversationMode(state.conversation_mode || state.conversationMode || tenant.conversation_mode || "bot");
  const base = {
    schema_version: INTENT_ROUTER_V2_SCHEMA_VERSION,
    tenant_id: tenant.tenant_id || tenant.tenantId || state.tenant_id || null,
    user_id: userTurn.user_id || userTurn.userId || state.user_id || null,
    channel: userTurn.channel || "whatsapp",
    locale: locale,
    timezone: timezone,
    conversation_mode: conversationMode,
    user_goal_summary: text.slice(0, 240),
    references: {},
    state_recommendations: {},
    safety: { requires_human: false, reason: null }
  };

  if (conversationMode === "live_chat") {
    return result(base, {
      turn_type: "new_request",
      should_not_execute_tools: true,
      tasks: [],
      reply_strategy: { kind: "do_nothing", human_summary: "Live chat activo; no responder como bot." }
    });
  }

  if (isCorrection(normalized)) {
    return result(base, {
      turn_type: "correction",
      should_not_execute_tools: true,
      tasks: [replyOnlyTask("correction")],
      state_recommendations: { clear_pending_action: true },
      reply_strategy: {
        kind: "apologize_and_repair",
        human_summary: "El usuario corrige una respuesta anterior; reparar sin ejecutar herramientas."
      }
    });
  }

  if (isMetaQuestion(normalized)) {
    return result(base, {
      turn_type: "meta_question",
      should_not_execute_tools: true,
      tasks: [replyOnlyTask("meta_question")],
      reply_strategy: {
        kind: "answer_only",
        human_summary: "Responder sobre el contexto sin ejecutar acciones."
      }
    });
  }

  const imageFollowup = buildImageFollowup(base, text, normalized, userTurn, state);
  if (imageFollowup) return imageFollowup;

  if (isDocumentRequest(normalized)) {
    return result(base, {
      turn_type: "document_request",
      tasks: [buildIntentTask({
        intent: "document.search",
        action_type: "read",
        status: "ready",
        confidence: 0.82,
        entities: { query: text.replace(/^\s*(pasame|p[aá]same|env[ií]ame|manda|mandame)\s+/i, "").trim() || text },
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: "Buscar documento existente."
      })],
      reply_strategy: {
        kind: "execute_and_confirm",
        human_summary: "Buscar y enviar documento existente si esta disponible."
      }
    });
  }

  const crm = buildCrmRoute(base, text, normalized, userTurn);
  if (crm) return crm;

  const utility = buildListReminderRoute(base, text, normalized, userTurn);
  if (utility) return utility;

  return result(base, {
    turn_type: normalized ? "new_request" : "unknown",
    tasks: [replyOnlyTask("unknown")],
    reply_strategy: {
      kind: "answer_only",
      human_summary: normalized ? "Responder sin herramienta." : "No hay intencion clara."
    }
  });
}

function buildListReminderRoute(base, text, normalized, userTurn) {
  const hasList = /\b(lista|compras|pendientes)\b/.test(normalized) && !isCorrection(normalized) && !isMetaQuestion(normalized);
  const hasListCreation = isListCreationIntent(normalized);
  const hasReminder = isReminderIntent(normalized);

  if (hasList && hasReminder && hasListCreation) {
    const list = parseListCommand(text);
    const items = cleanListItems(Array.isArray(list.items) ? list.items : []);
    const due = extractRelativeDue(normalized);
    const listTask = buildIntentTask({
      task_id: "list.format",
      intent: "list.format",
      action_type: "reply_only",
      status: items.length ? "ready" : "needs_clarification",
      confidence: items.length ? 0.9 : 0.55,
      entities: { listName: list.listName || "compras", items: items },
      missing_slots: items.length ? [] : ["items"],
      source_evidence: evidenceFromTurn(userTurn, text),
      user_visible_summary: "Ordenar lista en texto."
    });
    const reminderTask = buildIntentTask({
      task_id: "reminder.create",
      intent: "reminder.create",
      action_type: "schedule",
      status: due ? "ready" : "needs_clarification",
      confidence: due ? 0.9 : 0.62,
      entities: {
        title: "lista de compras",
        message: items.length ? items.join(", ") : text,
        relativeDue: due || "",
        timezone: base.timezone
      },
      required_slots: ["title", "due_at", "timezone"],
      missing_slots: due ? [] : ["due_at"],
      depends_on_task_ids: ["list.format"],
      source_evidence: evidenceFromTurn(userTurn, text),
      user_visible_summary: due ? "Crear recordatorio de la lista." : "Falta cuando recordar la lista."
    });

    return result(base, {
      turn_type: "multi_intent_request",
      tasks: [listTask, reminderTask],
      reply_strategy: {
        kind: due ? "execute_and_confirm" : "ask_clarification",
        one_question_to_ask: due ? null : "Cuando quieres que te recuerde la lista?",
        human_summary: due ? "Ordenar la lista y programar recordatorio." : "Ordenar lista y pedir hora del recordatorio."
      }
    });
  }

  if (hasList && hasListCreation) {
    const list = parseListCommand(text);
    const items = cleanListItems(Array.isArray(list.items) ? list.items : []);
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "list.format",
        intent: "list.format",
        action_type: "reply_only",
        status: items.length ? "ready" : "needs_clarification",
        confidence: items.length ? 0.88 : 0.55,
        entities: { listName: list.listName || "compras", items: items },
        missing_slots: items.length ? [] : ["items"],
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: "Ordenar lista en texto."
      })],
      reply_strategy: {
        kind: "answer_only",
        human_summary: "Formatear lista sin persistir por defecto."
      }
    });
  }

  if (hasReminder) {
    const due = extractRelativeDue(normalized);
    const title = cleanupReminderSubject(text);
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "reminder.create",
        intent: "reminder.create",
        action_type: "schedule",
        status: due && title ? "ready" : "needs_clarification",
        confidence: due && title ? 0.86 : 0.58,
        entities: { title: title || "recordatorio", relativeDue: due || "", timezone: base.timezone },
        required_slots: ["title", "due_at", "timezone"],
        missing_slots: due ? [] : ["due_at"],
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: due ? "Crear recordatorio." : "Falta cuando crear el recordatorio."
      })],
      reply_strategy: {
        kind: due ? "execute_and_confirm" : "ask_clarification",
        one_question_to_ask: due ? null : "Cuando quieres que te lo recuerde?",
        human_summary: due ? "Crear recordatorio." : "Pedir fecha u hora del recordatorio."
      }
    });
  }

  return null;
}

function buildCrmRoute(base, text, normalized, userTurn) {
  if (/\bborra|borrar|elimina|eliminar\b/.test(normalized) && /\b(cliente|lead|contacto)\b/.test(normalized)) {
    const name = extractAfter(text, /\b(?:cliente|lead|contacto)\s+(.+)$/i);
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "crm.delete",
        intent: "crm.delete",
        action_type: "delete",
        status: "needs_confirmation",
        confidence: 0.84,
        entities: { name: name },
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: "Borrar cliente requiere confirmacion fuerte."
      })],
      reply_strategy: {
        kind: "ask_confirmation",
        one_question_to_ask: "Confirmas que quieres borrar este cliente?",
        human_summary: "Pedir confirmacion fuerte antes de borrar."
      }
    });
  }

  if (/\b(actualiza|actualizar|cambia|editar|edita)\b/.test(normalized) && /\b(cliente|lead|contacto)\b/.test(normalized)) {
    const fields = extractCrmFields(text);
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "crm.update",
        intent: "crm.update",
        action_type: "write",
        status: "needs_confirmation",
        confidence: 0.78,
        entities: fields,
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: "Actualizar cliente requiere confirmacion con datos estructurados."
      })],
      reply_strategy: {
        kind: "ask_confirmation",
        one_question_to_ask: "Lo guardo asi?",
        human_summary: "Resumir datos estructurados y pedir confirmacion."
      }
    });
  }

  if (/\b(busca|buscame|buscar|encuentra)\b/.test(normalized) && /\b(cliente|lead|contacto|cedula)\b/.test(normalized)) {
    const cedula = (text.match(/\b(\d{10,13})\b/) || [])[1] || "";
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "crm.search",
        intent: "crm.search",
        action_type: "read",
        status: "ready",
        confidence: cedula ? 0.9 : 0.68,
        entities: cedula ? { cedula: cedula } : { query: text },
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: "Buscar cliente."
      })],
      reply_strategy: {
        kind: "execute_and_confirm",
        human_summary: "Buscar cliente sin confirmacion porque es lectura."
      }
    });
  }

  return null;
}

function buildImageFollowup(base, text, normalized, userTurn, state) {
  if (!isImageFollowupText(normalized)) return null;

  const source = selectImageSource(normalized, userTurn, state);
  if (!source.assetIds.length) return null;

  return result(base, {
    turn_type: "image_followup",
    tasks: [buildIntentTask({
      task_id: "image.edit",
      intent: "image.edit",
      action_type: "generate",
      status: "ready",
      confidence: 0.86,
      entities: {
        instruction: text,
        source_asset_ids: source.assetIds,
        source: source.usesGenerated ? "last_generated_image" : "uploaded_image"
      },
      source_evidence: evidenceFromTurn(userTurn, text),
      user_visible_summary: "Editar o generar variante usando imagen disponible."
    })],
    references: {
      uses_last_uploaded_image: source.usesUploaded,
      uses_last_generated_image: source.usesGenerated,
      source_asset_ids: source.assetIds
    },
    state_recommendations: {
      suspend_previous_task: shouldSuspendPreviousTask(state),
      new_active_task_type: "image_design"
    },
    reply_strategy: {
      kind: "execute_and_confirm",
      human_summary: "Usar imagen disponible sin pedirla otra vez."
    }
  });
}

function result(base, patch) {
  return normalizeIntentRouterV2Result(Object.assign({}, base, patch || {}));
}

function replyOnlyTask(reason) {
  return buildIntentTask({
    task_id: "reply_only",
    intent: "reply_only",
    action_type: "reply_only",
    status: "ready",
    confidence: 0.8,
    entities: { reason: reason || "reply_only" },
    user_visible_summary: "Responder sin herramientas."
  });
}

function evidenceFromTurn(userTurn, text) {
  const source = Number(userTurn && userTurn.audio_count || 0) > 0 ? "audio_transcript" : "text";
  return [{ source: source, quote_or_summary: String(text || "").slice(0, 240) }];
}

function extractTurnText(userTurn) {
  const turn = userTurn || {};
  return String(
    turn.combinedUserText ||
    turn.current_turn_text ||
    turn.currentTurnText ||
    (Array.isArray(turn.audio_transcripts) ? turn.audio_transcripts.join(" ") : "") ||
    (Array.isArray(turn.audioTranscripts) ? turn.audioTranscripts.join(" ") : "") ||
    ""
  ).trim();
}

function normalizeConversationMode(value) {
  const clean = normalizeText(value);
  if (clean === "live_chat" || clean === "human" || clean === "humano") return "live_chat";
  if (clean === "bot") return "bot";
  return clean || "unknown";
}

function isCorrection(text) {
  return /\b(no\s+no\s+te\s+estoy\s+preguntando|no\s+te\s+estoy\s+preguntando|esa\s+no\s+es|eso\s+no\s+es|te\s+confundiste|me\s+confundiste)\b/.test(text);
}

function isMetaQuestion(text) {
  return /\b(cuando\s+te\s+dije\s+eso|cuando\s+dije\s+eso|donde\s+te\s+dije\s+eso)\b/.test(text);
}

function isReminderIntent(text) {
  return /\b(recuerdame|recuerdamela|recordarme|recordatorio|avisame|hazme\s+acuerdo|hacer\s+acuerdo|acuerdame|me\s+puedes\s+hacer\s+acuerdo)\b/.test(text);
}

function isListCreationIntent(text) {
  if (/\b(hazme\s+acuerdo|hacer\s+acuerdo|recuerdame|recuerdamela|recordarme)\s+(?:de\s+)?(?:esta\s+|esa\s+|la\s+)?lista\b/.test(text)) {
    return false;
  }
  return /\b(hazme|hacer|crea|crear|creame|generar|genera|prepara|preparame|ayudame\s+a\s+generar|me\s+puedes\s+hacer)\b.*\blista\b/.test(text) ||
    /\blista\s+de\s+[^?]+(?:,|\s+y\s+)/.test(text);
}

function cleanListItems(items) {
  return (Array.isArray(items) ? items : []).filter(function (item) {
    const clean = normalizeText(item);
    return clean && !/\b(recuerdame|recuerdamela|recordarme|hazme\s+acuerdo|hacer\s+acuerdo)\b/.test(clean);
  });
}

function isDocumentRequest(text) {
  return /\b(pasame|enviame|mandame|manda|pasar)\b/.test(text) &&
    /\b(catalogo|catalogos|documento|archivo|contrato|pdf)\b/.test(text);
}

function isImageFollowupText(text) {
  if (!text) return false;
  return /\b(portada|disenalo|disena|dise[nñ]alo|dise[nñ]a|hazlo|hazla|neon|miami\s+wave|cute|chevere|otra\s+version|version|flyer|banner|afiche|post|logo|vintage|realista|oscuro)\b/.test(text);
}

function selectImageSource(normalized, userTurn, state) {
  const currentAssets = normalizeAssets(userTurn && userTurn.media_batch && userTurn.media_batch.assets || []);
  const campaignAssets = normalizeAssets(state && state.campaign_assets || []);
  const lastUploaded = state && (state.last_uploaded_image || state.lastUploadedImage) || null;
  const lastGenerated = state && (state.last_generated_image || state.lastGeneratedImage) || null;
  const wantsGenerated = /\b(hazla|otra\s+version|mas\s+cute|cute|chevere|version)\b/.test(normalized) && lastGenerated;

  if (wantsGenerated) {
    return {
      usesUploaded: false,
      usesGenerated: true,
      assetIds: [lastGenerated.assetId || lastGenerated.asset_id || findAssetId(campaignAssets, lastGenerated.fileId || lastGenerated.file_id) || "last_generated_image"].filter(Boolean)
    };
  }

  if (currentAssets.length) {
    return { usesUploaded: true, usesGenerated: false, assetIds: currentAssets.map(function (asset) { return asset.asset_id; }).filter(Boolean) };
  }

  if (campaignAssets.length) {
    const imageAssets = campaignAssets.filter(function (asset) { return asset.media_type === "IMAGE"; });
    if (imageAssets.length) {
      return { usesUploaded: true, usesGenerated: false, assetIds: imageAssets.slice(-1).map(function (asset) { return asset.asset_id; }).filter(Boolean) };
    }
  }

  if (lastUploaded) {
    return {
      usesUploaded: true,
      usesGenerated: false,
      assetIds: [lastUploaded.assetId || lastUploaded.asset_id || findAssetId(campaignAssets, lastUploaded.fileId || lastUploaded.file_id) || "last_uploaded_image"].filter(Boolean)
    };
  }

  return { usesUploaded: false, usesGenerated: false, assetIds: [] };
}

function normalizeAssets(assets) {
  return (Array.isArray(assets) ? assets : []).map(function (asset, index) {
    const clean = asset || {};
    return {
      asset_id: String(clean.asset_id || clean.assetId || "asset_" + (index + 1)),
      file_id: String(clean.file_id || clean.fileId || ""),
      media_type: String(clean.media_type || clean.mediaType || "IMAGE").toUpperCase(),
      status: String(clean.status || "received")
    };
  });
}

function findAssetId(assets, fileId) {
  const found = assets.find(function (asset) { return asset.file_id && asset.file_id === fileId; });
  return found && found.asset_id || "";
}

function shouldSuspendPreviousTask(state) {
  const pending = state && (state.pending_action || state.pendingAction);
  const active = state && (state.active_task || state.activeTask);
  return Boolean(pending || active && String(active.type || "").toLowerCase() !== "image_design");
}

function extractRelativeDue(text) {
  const match = text.match(/\b(?:en|dentro\s+de)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h|dia|dias|d)\b/);
  if (!match) return "";
  const value = parseSpokenNumber(match[1]);
  const unit = match[2];
  if (!value) return "";
  if (unit === "h" || unit.startsWith("hora")) return "PT" + value + "H";
  if (unit === "m" || unit === "min" || unit.startsWith("minuto")) return "PT" + value + "M";
  return "P" + value + "D";
}

function parseSpokenNumber(value) {
  const clean = normalizeText(value);
  const words = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    quince: 15,
    veinte: 20,
    treinta: 30
  };
  const numeric = Number(clean);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return words[clean] || 0;
}

function cleanupReminderSubject(text) {
  return String(text || "")
    .replace(/^\s*(hazme\s+acuerdo|recuerdame|recordarme|avisame|acuerdame)\s+(de\s+|para\s+)?/i, "")
    .replace(/\b(?:en|dentro\s+de)\s+\S+\s*(min|minuto|minutos|m|hora|horas|h|dia|dias|d)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractCrmFields(text) {
  const email = (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
  const phone = (text.match(/\b0\d{8,10}\b/) || [])[0] || "";
  const name = extractAfter(text, /\bcliente\s+([^,.;]+?)(?:,|\s+el\s+correo|\s+correo|\s+telefono|\s+tel[eé]fono|$)/i);
  const noteMatch = text.match(/\b(?:anota|nota|interes|inter[eé]s)\s+(?:que\s+)?(.+)$/i);
  const entities = {};
  if (name) entities.name = name;
  if (email) entities.email = email;
  if (phone) entities.phone = phone;
  if (noteMatch && noteMatch[1]) entities.notes = cleanupTrailing(noteMatch[1]);
  return entities;
}

function extractAfter(text, pattern) {
  const match = String(text || "").match(pattern);
  return cleanupTrailing(match && match[1] || "");
}

function cleanupTrailing(value) {
  return String(value || "").replace(/[.,;:?\s]+$/g, "").trim();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
