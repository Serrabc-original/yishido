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

  const utility = buildListReminderRoute(base, text, normalized, userTurn, state);
  if (utility) return utility;

  return result(base, {
    turn_type: normalized ? "new_request" : "unknown",
    tasks: [replyOnlyTask("unknown")],
    reply_strategy: {
      kind: "answer_only",
      human_summary: normalized ? "No tengo claro si quieres que cree algo o solo responda." : "No me llego suficiente contexto para responder."
    }
  });
}

function buildListReminderRoute(base, text, normalized, userTurn, state) {
  const hasList = /\b(lista|compras|pendientes)\b/.test(normalized) && !isCorrection(normalized) && !isMetaQuestion(normalized);
  const hasListCreation = isListCreationIntent(normalized);
  const hasReminder = isReminderIntent(normalized);
  const listDetails = hasListCreation ? extractListDetails(text) : { listName: "compras", items: [] };

  if (hasReminder && referencesExistingList(normalized) && !hasListCreation) {
    const due = extractRelativeDue(normalized);
    const latestList = getLatestListReference(state);
    const items = latestList && latestList.items || [];
    const listName = latestList && latestList.name || "compras";

    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "reminder.create",
        intent: "reminder.create",
        action_type: "schedule",
        status: due && items.length ? "ready" : "needs_clarification",
        confidence: due && items.length ? 0.88 : 0.58,
        entities: {
          title: latestList && latestList.title || formatListReminderTitle(listName),
          message: items.length ? items.join(", ") : "esa lista",
          items: items,
          listName: listName,
          relativeDue: due || "",
          timezone: base.timezone
        },
        required_slots: ["title", "due_at", "timezone"],
        missing_slots: due ? items.length ? [] : ["items"] : ["due_at"],
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: due ? "Crear recordatorio de la lista reciente." : "Falta cuando recordar la lista."
      })],
      state_recommendations: {
        continue_active_task: Boolean(latestList)
      },
      reply_strategy: {
        kind: due && items.length ? "execute_and_confirm" : "ask_clarification",
        one_question_to_ask: due ? "Que lista quieres que te recuerde?" : "Cuando quieres que te recuerde esa lista?",
        human_summary: due && items.length ? "Programar recordatorio de la lista reciente." : "Pedir dato faltante para recordar lista reciente."
      }
    });
  }

  const pendingReminder = getPendingReminderReference(state);
  if (hasReminder && pendingReminder && !hasList && !hasListCreation) {
    const due = extractRelativeDue(normalized);
    return result(base, {
      turn_type: "clarification_answer",
      tasks: [buildIntentTask({
        task_id: "reminder.create",
        intent: "reminder.create",
        action_type: "schedule",
        status: due ? "ready" : "needs_clarification",
        confidence: due ? 0.88 : 0.6,
        entities: {
          title: pendingReminder.title,
          message: pendingReminder.message || pendingReminder.title,
          relativeDue: due || "",
          timezone: base.timezone
        },
        required_slots: ["title", "due_at", "timezone"],
        missing_slots: due ? [] : ["due_at"],
        source_evidence: evidenceFromTurn(userTurn, text),
        user_visible_summary: due ? "Completar recordatorio pendiente." : "Sigue faltando cuando recordar."
      })],
      state_recommendations: {
        clear_pending_action: Boolean(due)
      },
      reply_strategy: {
        kind: due ? "execute_and_confirm" : "ask_clarification",
        one_question_to_ask: due ? null : "Cuando quieres que te lo recuerde?",
        human_summary: due ? "Crear recordatorio pendiente con la hora recibida." : "Pedir hora del recordatorio pendiente."
      }
    });
  }

  if (hasList && hasReminder && hasListCreation) {
    const items = listDetails.items;
    const due = extractRelativeDue(normalized);
    const listTask = buildIntentTask({
      task_id: "list.format",
      intent: "list.format",
      action_type: "reply_only",
      status: items.length ? "ready" : "needs_clarification",
      confidence: items.length ? 0.9 : 0.55,
      entities: { listName: listDetails.listName, items: items },
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
        title: formatListReminderTitle(listDetails.listName),
        message: items.length ? items.join(", ") : text,
        items: items,
        listName: listDetails.listName,
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
    const items = listDetails.items;
    return result(base, {
      turn_type: "new_request",
      tasks: [buildIntentTask({
        task_id: "list.format",
        intent: "list.format",
        action_type: "reply_only",
        status: items.length ? "ready" : "needs_clarification",
        confidence: items.length ? 0.88 : 0.55,
        entities: { listName: listDetails.listName, items: items },
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
    user_visible_summary: "Responder sin ejecutar herramientas."
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
  return /\b(recuerdame|recuerdamela|recordarme|recordar|recordatorio|avisame|hazme\s+acuerdo|hacer\s+acuerdo|acuerdame|me\s+puedes\s+hacer\s+acuerdo|me\s+lo\s+puedes\s+recordar|me\s+puedes\s+recordar)\b/.test(text);
}

function isListCreationIntent(text) {
  if (/\b(hazme\s+acuerdo|hacer\s+acuerdo|recuerdame|recuerdamela|recordarme)\s+(?:de\s+)?(?:esta\s+|esa\s+|la\s+)?lista\b/.test(text)) {
    return false;
  }
  return /\b(hazme|hacer|crea|crear|creame|generar|genera|prepara|preparame|ayudame\s+a\s+generar|me\s+puedes\s+hacer)\b.*\blista\b/.test(text) ||
    /\blista\s+de\s+[^?]+(?:,|\s+y\s+)/.test(text);
}

function cleanListItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(sanitizeListItem)
    .flatMap(expandCompoundListItem)
    .filter(function (item) {
    const clean = normalizeText(item);
    return isUsableListItem(clean);
  });
}

function extractListDetails(text) {
  const parsed = parseListCommand(text);
  const parsedItems = cleanListItems(Array.isArray(parsed.items) ? parsed.items : []);
  const naturalItems = extractNaturalListItems(text);
  const items = shouldPreferNaturalItems(parsedItems, naturalItems) ? naturalItems : parsedItems;
  return {
    listName: inferListNameForV2(text, parsed.listName || ""),
    items: items
  };
}

function shouldPreferNaturalItems(parsedItems, naturalItems) {
  if (!naturalItems.length) return false;
  if (!parsedItems.length) return true;
  if (parsedItems.some(function (item) { return !isUsableListItem(normalizeText(item)); })) return true;
  if (parsedItems.some(function (item) { return normalizeText(item).split(" ").length > 7; })) return true;
  return naturalItems.length >= parsedItems.length;
}

function extractNaturalListItems(text) {
  let segment = String(text || "")
    .replace(/^\s*\[Audio transcrito\]:\s*/i, "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .trim();

  segment = takeAfterBestListMarker(segment);
  segment = stripAfterReminderClause(segment);
  segment = segment
    .replace(/\s+\b(ah|eh)\b\s+/ig, ", ")
    .replace(/\b(entonces|por favor|gracias|ahi|ah)\b/ig, " ")
    .replace(/\b(eso necesito comprar|eso necesito|creo que eso|y creo que eso)\b/ig, " ")
    .replace(/\s+/g, " ")
    .trim();

  return cleanListItems(segment.split(/\s*,\s*|\s+y\s+/i));
}

function takeAfterBestListMarker(text) {
  const source = String(text || "");
  const markers = [
    /\blo que necesito es\s+/i,
    /\blo que necesito comprar es\s+/i,
    /\bnecesito comprar\s+/i,
    /\bnecesito es\s+/i,
    /\bque sea de\s+/i,
    /\blista\s+(?:de|con)\s+/i,
    /\bcompras?\s+(?:de|con)\s+/i
  ];

  let bestIndex = -1;
  let bestEnd = -1;
  for (const marker of markers) {
    const match = source.match(marker);
    if (!match) continue;
    const index = match.index || 0;
    if (index >= bestIndex) {
      bestIndex = index;
      bestEnd = index + match[0].length;
    }
  }
  if (bestEnd >= 0) return source.slice(bestEnd).trim();

  return source
    .replace(/^\s*(me\s+puedes\s+|puedes\s+|quiero\s+|queria\s+que\s+|ayudame\s+a\s+|ayudes\s+a\s+)*/i, "")
    .replace(/^\s*(hacer|hazme|crear|creame|generar|genera|preparar|prepara)\s+(una\s+)?lista\s*/i, "")
    .trim();
}

function stripAfterReminderClause(text) {
  return String(text || "")
    .replace(/\s+(y\s+que\s+)?(?:esa|esta|la)\s+lista\s+me\s+(?:hagas|haz)\s+acuerdo\b.*$/i, "")
    .replace(/\s+(y\s+)?(?:recuerdamela|recuerdame|recordarme|hazme\s+acuerdo|hacerme\s+acuerdo|hacer\s+acuerdo|avisame)\b.*$/i, "")
    .replace(/\s+pero\s+(?:a\s+\S+\s+)?(?:me\s+)?(?:acuerdame|recuerdame|hazme\s+acuerdo)\b.*$/i, "")
    .replace(/\s+(?:acuerdame|recuerdame)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m)?\b.*$/i, "")
    .replace(/\s+(?:en|dentro\s+de)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h|dia|dias|d)\b.*$/i, "")
    .trim();
}

function inferListNameForV2(text, fallback) {
  const normalized = normalizeText(text);
  if (/\bsupermaxi\b/.test(normalized)) return "super";
  if (/\bsuper\b|\bsupermercado\b/.test(normalized)) return "super";
  if (/\bcompras?\b|\bcomprar\b/.test(normalized)) return "compras";
  const cleanFallback = String(fallback || "").trim();
  if (cleanFallback && !/^(pendientes|lista)$/i.test(cleanFallback)) return cleanFallback;
  return "compras";
}

function formatListReminderTitle(listName) {
  const clean = String(listName || "compras").trim() || "compras";
  if (clean === "compras") return "lista de compras";
  return "lista " + clean;
}

function isUsableListItem(item) {
  const clean = normalizeText(item);
  if (!clean) return false;
  if (clean.length < 2) return false;
  if (clean.split(" ").length > 6) return false;
  if (/\b(recuerdame|recuerdamela|recordarme|hazme\s+acuerdo|hacer\s+acuerdo|me\s+hagas\s+acuerdo)\b/.test(clean)) return false;
  if (/\b(me\s+puedes|puedes|quiero|queria|ayudes|ayudame|generar|crear|hacer\s+una\s+lista|lista\s+para|creo\s+que\s+eso|eso\s+necesito|entonces|gracias)\b/.test(clean)) return false;
  if (/^(de|del|la|el|los|las|y|o|ah|eh)$/.test(clean)) return false;
  return true;
}

function sanitizeListItem(item) {
  return String(item || "")
    .replace(/^\s*(y|o)\s+/i, "")
    .replace(/\b(ah|eh)\b/ig, " ")
    .replace(/[.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function expandCompoundListItem(item) {
  const clean = String(item || "").trim();
  const normalized = normalizeText(clean);
  const matches = [];
  const regex = /\b(comida\s+de\s+gatito|comida\s+para\s+peces|zanahoria\s+en\s+blanca|zanahoria|huevos?|leche|crema|pan|carne|queso|pollo|pescado|aceite|sal|agua|harina)\b/gi;
  let match;
  while ((match = regex.exec(normalized)) !== null) {
    matches.push(match[1]);
  }
  if (matches.length > 1) return matches;
  return [clean];
}

function referencesExistingList(text) {
  return /\b(esa|esta|la|mi)\s+lista\b/.test(text) || /\b(lista\s+que\s+te\s+(?:di|dije|mande|pase)|lista\s+anterior)\b/.test(text);
}

function getLatestListReference(state) {
  const clean = state && typeof state === "object" ? state : {};
  const direct = normalizeListReference(clean.latest_list || clean.latestList || clean.last_ephemeral_list || clean.lastEphemeralList || null);
  if (direct) return direct;
  const core = clean.core_utility_state || clean.coreUtilityState || {};
  return normalizeListReference(core.lastEphemeralList || core.last_ephemeral_list || null);
}

function getPendingReminderReference(state) {
  const clean = state && typeof state === "object" ? state : {};
  const pending = clean.pending_action || clean.pendingAction || null;
  const draft = pending && typeof pending === "object" ? pending : {};
  const title = String(draft.title || draft.subject || "").trim();
  if (!title) return null;
  return {
    title: title,
    message: String(draft.message || draft.body || draft.context || title).trim()
  };
}

function normalizeListReference(value) {
  const clean = value && typeof value === "object" ? value : {};
  const items = cleanListItems(Array.isArray(clean.items) ? clean.items : []);
  if (!items.length) return null;
  const name = String(clean.name || clean.listName || clean.list_name || "compras").trim() || "compras";
  return {
    name: name,
    title: String(clean.title || "lista " + name).trim(),
    items: items
  };
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
  const cleaned = String(text || "")
    .replace(/^\s*(oye|hola|gracias|porfa|por favor)[,.\s]*/i, "")
    .replace(/^\s*(me\s+puedes\s+)?(hazme\s+acuerdo|hacer\s+acuerdo|recuerdame|recordarme|me\s+lo\s+puedes\s+recordar|me\s+puedes\s+recordar|recordar|avisame|acuerdame)\s+(de\s+|para\s+)?/i, "")
    .replace(/\b(?:en|dentro\s+de)\s+\S+\s*(min|minuto|minutos|m|hora|horas|h|dia|dias|d)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const normalized = normalizeText(cleaned);
  if (/\bcorreo\b/.test(normalized) && /\bcliente\b/.test(normalized) && /\bseguimiento\b/.test(normalized)) {
    return "correo de seguimiento al cliente";
  }
  if (/\bcorreo\b/.test(normalized)) return "correo pendiente";
  return cleaned;
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
