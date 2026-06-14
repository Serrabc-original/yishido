import { composeFinalResponse } from "../ai/finalResponseComposer.js";
import { getSupervisorModel } from "../ai/modelRegistry.js";
import { logEvent } from "../logger.js";

const INTENTS = new Set([
  "general",
  "product_advice",
  "price_review",
  "multi_image_price_review",
  "multi_image_review",
  "image_description",
  "pet_photo",
  "unknown_image_request",
  "image_question",
  "image_ocr",
  "mechanic",
  "list",
  "reminder",
  "marketing",
  "support",
  "order",
  "memory",
  "unknown"
]);

export function getSupervisorConfig(env) {
  return {
    model: getSupervisorModel(env || {}),
    fallbackModel: String(env && env.SUPERVISOR_FALLBACK_MODEL || "gpt-5.4-mini")
  };
}

export function getRecentConversationWindow(data, limit) {
  const cleanLimit = Number(limit || 20);
  const logs = Array.isArray(data && data.conversationLog) ? data.conversationLog : [];

  return logs.slice(-cleanLimit).map(function (entry) {
    const counts = entry.counts || {};
    const media = entry.media || {};
    const inputTypes = Array.isArray(entry.inputTypes) ? entry.inputTypes : [];
    const type = inferWindowType(inputTypes, counts);

    return {
      turnId: String(entry.turnId || ""),
      traceId: String(entry.traceId || ""),
      type: type,
      timestamp: String(entry.at || ""),
      summary: String(entry.textPreview || "").slice(0, 500),
      mediaRefs: {
        fileIds: Array.isArray(media.fileIds) ? media.fileIds.map(String).filter(Boolean) : [],
        assetCount: Number(media.assetCount || 0),
        failedAssetCount: Number(media.failedAssetCount || 0)
      },
      audioTranscript: (Array.isArray(entry.audioTranscripts) ? entry.audioTranscripts : []).join("\n").slice(0, 800),
      visualResult: entry.visualResult || null
    };
  });
}

export function createConversationSupervisorPlan(input) {
  const clean = input || {};
  const currentTurn = clean.currentTurn || clean.current_turn || {};
  const activeContext = clean.activeContext || clean.active_context || {};
  const recentWindow = Array.isArray(clean.recentConversationWindow || clean.recent_conversation_window)
    ? clean.recentConversationWindow || clean.recent_conversation_window
    : [];
  const currentText = extractPlainText(currentTurn.current_turn_text || currentTurn.text || "");
  const normalized = normalizeText(currentText);
  const previousWindow = recentWindow.filter(function (entry) {
    return !entry.turnId || entry.turnId !== currentTurn.turn_id;
  });
  const previousTask = findPreviousTask(previousWindow, activeContext);
  const imageCount = getImageCount(currentTurn);
  const hasCurrentImages = imageCount > 0;
  const mediaSubjectText = getTurnMediaSubjectText(currentTurn);
  const hasPetMedia = isPetMedia(mediaSubjectText);
  const hasCommercialMedia = isCommercialMedia(mediaSubjectText);
  const currentOnlyMedia = currentTurn.current_turn_media || currentTurn.currentTurnMedia || {};
  const previousRelevantMedia = currentTurn.previous_relevant_media || currentTurn.previousRelevantMedia || {};
  const hasPreviousRelevantMedia = Number(previousRelevantMedia.asset_count || previousRelevantMedia.image_count || 0) > 0;
  const hasText = Boolean(normalized);
  const isReminder = isReminderIntent(normalized);
  const isList = isListIntent(normalized);
  const isMarketing = isMarketingIntent(normalized);
  const isOcr = isOcrIntent(normalized);
  const isMemory = isMemoryIntent(normalized);
  const isPrice = isPriceReviewIntent(normalized) || (!hasText && hasCurrentImages && previousTask.intent === "price_review" && !hasPetMedia);
  const isProductAdvice = isProductAdviceIntent(normalized) || (hasCurrentImages && hasCommercialMedia && isImageQuestionIntent(normalized));
  const isContextSwitch = Boolean(
    (isReminder || isList || isMarketing || isMemory) &&
    previousTask.intent &&
    previousTask.intent !== "general" &&
    previousTask.intent !== inferIntentName({
      isReminder: isReminder,
      isList: isList,
      isMarketing: isMarketing,
      isMemory: isMemory,
      isPrice: isPrice,
      isOcr: isOcr,
      hasCurrentImages: hasCurrentImages,
      normalized: normalized
    })
  );
  let intent = "general";
  let activeTask = previousTask.intent || "general";
  let mediaScope = "none";
  let targetModules = ["general_llm"];
  let responseStrategy = "answer_now";
  let needsClarification = false;
  let clarificationQuestion = "";
  let shouldUseRecentHistory = previousWindow.length > 0;
  let shouldUsePreviousMedia = false;
  const actions = [];
  const memoryUpdates = detectMemoryUpdates(currentText);

  if (isReminder) {
    intent = "reminder";
    activeTask = "reminder";
    targetModules = ["reminders", "whatsapp_interactive"];
    responseStrategy = "create_utility_then_confirm";
  } else if (isList) {
    intent = "list";
    activeTask = "list";
    targetModules = ["lists", "whatsapp_interactive"];
    responseStrategy = "create_utility_then_confirm";
  } else if (isMemory) {
    intent = "memory";
    activeTask = "memory";
    targetModules = ["memory", "general_llm"];
    responseStrategy = "answer_now";
    actions.push({ type: normalized.includes("como me llamo") || normalized.includes("cual es mi nombre") ? "answer_memory_name" : "update_memory" });
  } else if (isMarketing) {
    intent = "marketing";
    activeTask = "marketing";
    targetModules = hasCurrentImages ? ["vision", "marketing", "general_llm"] : ["marketing", "general_llm"];
    mediaScope = hasCurrentImages ? "all_pending_batch" : "none";
    responseStrategy = hasCurrentImages ? "analyze_then_answer" : "answer_now";
  } else if (hasPetMedia && hasCurrentImages && !isPriceReviewIntent(normalized)) {
    intent = "pet_photo";
    activeTask = "pet_photo";
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
    if (previousTask.intent === "price_review") {
      logIntentLeakagePrevented("price_review", "pet_photo", "pet_media_current_turn");
    }
  } else if (isPrice) {
    intent = imageCount > 1 ? "multi_image_price_review" : "price_review";
    activeTask = "price_review";
    targetModules = ["vision", "general_llm"];
    mediaScope = hasCurrentImages ? "all_pending_batch" : hasPreviousRelevantMedia ? "previous_relevant" : "none";
    shouldUsePreviousMedia = mediaScope === "previous_relevant" || mediaScope === "current_and_previous";
    responseStrategy = mediaScope === "none" ? "ask_clarification" : "analyze_then_answer";
    if (mediaScope === "none") {
      needsClarification = true;
      clarificationQuestion = "Enviame las fotos con los precios o dime cual imagen anterior quieres comparar.";
      logEvent("PRICE_REVIEW_CONTEXT_REQUIRED", {
        reason: "price_intent_without_media",
        hasPreviousRelevantMedia: hasPreviousRelevantMedia
      });
    }
  } else if (isProductAdvice && hasCurrentImages) {
    intent = "product_advice";
    activeTask = "product_advice";
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
  } else if (isOcr && hasCurrentImages) {
    intent = "image_ocr";
    activeTask = "image_ocr";
    targetModules = ["vision"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
  } else if (hasCurrentImages && (isImageQuestionIntent(normalized) || currentTurn.captions && currentTurn.captions.length)) {
    intent = imageCount > 1 ? "multi_image_review" : "image_question";
    activeTask = intent;
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
  } else if (!hasText && hasCurrentImages && previousTask.intent && previousTask.intent !== "general") {
    intent = previousTask.intent === "price_review" && !hasPetMedia ? (imageCount > 1 ? "multi_image_price_review" : "price_review") : hasPetMedia ? "pet_photo" : "image_question";
    activeTask = previousTask.intent;
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
  } else if (hasCurrentImages) {
    intent = hasPetMedia ? "pet_photo" : imageCount > 1 ? "multi_image_review" : "unknown_image_request";
    activeTask = intent;
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    needsClarification = !hasText && previousTask.intent === "general";
    responseStrategy = needsClarification ? "ask_clarification" : "analyze_then_answer";
    clarificationQuestion = needsClarification ? buildImageClarificationQuestion(mediaSubjectText) : "";
  }

  const isContinuation = Boolean(!isContextSwitch && (
    previousTask.intent && previousTask.intent === activeTask && activeTask !== "general" ||
    !hasText && hasCurrentImages && previousTask.intent !== "general" ||
    /\b(eso|esto|esta|este|la segunda|la primera|los precios|lo de antes|y este|y esta|cual conviene|cu[aá]l conviene)\b/i.test(currentText)
  ));

  if (isContinuation && hasCurrentImages && previousTask.intent === "price_review" && !hasPetMedia) {
    intent = imageCount > 1 ? "multi_image_price_review" : "price_review";
    activeTask = "price_review";
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
    needsClarification = false;
    clarificationQuestion = "";
  }
  if (isContinuation && hasCurrentImages && previousTask.intent === "price_review" && hasPetMedia) {
    intent = "pet_photo";
    activeTask = "pet_photo";
    targetModules = ["vision", "general_llm"];
    mediaScope = imageCount > 1 ? "all_pending_batch" : "current_only";
    responseStrategy = "analyze_then_answer";
    logIntentLeakagePrevented("price_review", "pet_photo", "pet_media_continuation_blocked");
  }

  const plan = {
    currentUserGoal: buildCurrentUserGoal(currentText, intent, previousTask),
    normalizedUserRequest: normalized,
    activeTask: activeTask,
    intent: INTENTS.has(intent) ? intent : "unknown",
    isContinuation: isContinuation,
    isContextSwitch: isContextSwitch,
    contextSwitchReason: isContextSwitch ? "La solicitud actual apunta a otro modulo distinto del task previo." : "",
    needsClarification: needsClarification,
    clarificationQuestion: clarificationQuestion,
    shouldUseRecentHistory: shouldUseRecentHistory,
    shouldUsePreviousMedia: shouldUsePreviousMedia,
    mediaScope: mediaScope,
    targetModules: targetModules,
    actions: actions,
    memoryUpdates: memoryUpdates,
    responseStrategy: responseStrategy,
    supervisorModel: clean.supervisorConfig && clean.supervisorConfig.model || "",
    supervisorFallbackModel: clean.supervisorConfig && clean.supervisorConfig.fallbackModel || ""
  };

  return normalizeSupervisorPlan(plan);
}

export function normalizeSupervisorPlan(plan) {
  const clean = plan || {};
  const intent = INTENTS.has(clean.intent) ? clean.intent : "unknown";

  return {
    currentUserGoal: String(clean.currentUserGoal || ""),
    normalizedUserRequest: String(clean.normalizedUserRequest || ""),
    activeTask: String(clean.activeTask || intent || "general"),
    intent: intent,
    isContinuation: Boolean(clean.isContinuation),
    isContextSwitch: Boolean(clean.isContextSwitch),
    contextSwitchReason: String(clean.contextSwitchReason || ""),
    needsClarification: Boolean(clean.needsClarification),
    clarificationQuestion: String(clean.clarificationQuestion || ""),
    shouldUseRecentHistory: Boolean(clean.shouldUseRecentHistory),
    shouldUsePreviousMedia: Boolean(clean.shouldUsePreviousMedia),
    mediaScope: ["none", "current_only", "previous_relevant", "current_and_previous", "all_pending_batch"].includes(clean.mediaScope)
      ? clean.mediaScope
      : "none",
    targetModules: Array.isArray(clean.targetModules) ? clean.targetModules.map(String).filter(Boolean) : [],
    actions: Array.isArray(clean.actions) ? clean.actions : [],
    memoryUpdates: Array.isArray(clean.memoryUpdates) ? clean.memoryUpdates : [],
    responseStrategy: ["answer_now", "analyze_then_answer", "ask_clarification", "create_utility_then_confirm"].includes(clean.responseStrategy)
      ? clean.responseStrategy
      : "answer_now",
    supervisorModel: String(clean.supervisorModel || ""),
    supervisorFallbackModel: String(clean.supervisorFallbackModel || "")
  };
}

export function generateFinalUserResponse(supervisorPlan, moduleResults, recentContext) {
  const plan = normalizeSupervisorPlan(supervisorPlan || {});
  const results = moduleResults || {};
  const composed = composeFinalResponse({
    supervisorPlan: plan,
    specialistResults: results,
    currentUserMessage: recentContext && recentContext.currentUserMessage || plan.currentUserGoal || "",
    currentMediaSummary: results.vision || results.summary || {},
    recentHistorySummary: recentContext && recentContext.recentConversationWindow || [],
    memorySummary: recentContext && recentContext.memorySummary || null
  });

  return composed.text || "";
}

export function formatPriceReviewResponse(summary, plan) {
  const data = summary || {};
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const analyzed = assets.filter(function (asset) {
    return asset && asset.analysis;
  });

  if (!analyzed.length) {
    return "No pude leer bien los precios en las imagenes. Reenvialas con el precio visible y comparo todas.";
  }

  const lines = ["Si, revisé " + analyzed.length + " imagen" + (analyzed.length === 1 ? "" : "es") + "."];
  const prices = [];

  analyzed.forEach(function (asset, index) {
    const extracted = extractPriceFacts(asset.analysis || {});
    if (extracted.price) {
      prices.push(Object.assign({ index: index + 1 }, extracted));
    }
    lines.push("Imagen " + (index + 1) + ": " + formatPriceFacts(extracted));
  });

  const best = chooseBestVisiblePrice(prices);
  if (best) {
    lines.push("La que parece mas conveniente por precio visible es la imagen " + best.index + " (" + best.price + "), siempre que el modelo y la garantia sean comparables.");
  }

  lines.push("Antes de comprar, confirma modelo exacto, garantia, estado/originalidad y si el precio incluye impuestos o envio.");

  if (data.failed_asset_count) {
    lines.push("Nota: " + data.failed_asset_count + " imagen(es) no se pudieron analizar, pero el resto del proceso siguió.");
  }

  return lines.join("\n");
}

function formatImageQuestionResponse(summary) {
  const assets = Array.isArray(summary && summary.assets) ? summary.assets : [];
  const subjects = assets.map(function (asset) {
    const analysis = asset.analysis || {};
    return analysis.main_subject || analysis.product_type || analysis.brand_or_labels || "";
  }).filter(Boolean);
  const visibleTexts = assets.map(function (asset) {
    return asset.analysis && asset.analysis.visible_text || "";
  }).filter(Boolean);

  return [
    subjects.length ? "Veo " + subjects.join(" | ") + "." : "Puedo ayudarte con lo visible en la imagen.",
    visibleTexts.length ? "Texto visible: " + visibleTexts.join(" | ") : "",
    "Si quieres, puedo ayudarte a describirla, sacar un caption o revisar un detalle específico."
  ].filter(Boolean).join("\n");
}

function inferWindowType(inputTypes, counts) {
  if (counts.image || inputTypes.includes("IMAGE")) return "image";
  if (counts.audio || inputTypes.includes("AUDIO")) return "audio";
  if (inputTypes.includes("INTERACTIVE")) return "interactive";
  if (inputTypes.includes("REMINDER")) return "reminder";
  if (inputTypes.includes("LIST")) return "list";
  return "text";
}

function findPreviousTask(window, activeContext) {
  const active = String(activeContext && (activeContext.activeIntent || activeContext.active_intent) || "");
  const entries = Array.isArray(window) ? window.slice().reverse() : [];

  for (const entry of entries) {
    const text = normalizeText(entry.summary || "");
    if (isPriceReviewIntent(text)) return { intent: "price_review", source: "recent_history" };
    if (isReminderIntent(text)) return { intent: "reminder", source: "recent_history" };
    if (isListIntent(text)) return { intent: "list", source: "recent_history" };
    if (isMarketingIntent(text)) return { intent: "marketing", source: "recent_history" };
    if (entry.type === "image" && active && active !== "general") return { intent: active, source: "active_context" };
  }

  return { intent: active && active !== "unknown" ? active : "general", source: active ? "active_context" : "" };
}

function inferIntentName(flags) {
  if (flags.isReminder) return "reminder";
  if (flags.isList) return "list";
  if (flags.isMarketing) return "marketing";
  if (flags.isMemory) return "memory";
  if (flags.isPrice) return "price_review";
  if (flags.isOcr) return "image_ocr";
  if (flags.hasCurrentImages) return "image_question";
  return flags.normalized ? "general" : "unknown";
}

function buildCurrentUserGoal(text, intent, previousTask) {
  if (text) return text.slice(0, 500);
  if (intent === "price_review" || intent === "multi_image_price_review") return "Comparar precios de las imagenes recibidas";
  if (previousTask && previousTask.intent && previousTask.intent !== "general") return "Continuar task previo: " + previousTask.intent;
  return "";
}

function getImageCount(turn) {
  const current = turn.current_turn_media || turn.currentTurnMedia || {};
  return Number(turn.image_count || current.image_count || current.asset_count || 0);
}

function isPriceReviewIntent(text) {
  return /\b(precio|precios|caro|cara|caros|caras|barato|barata|conviene|cotiza|cotizacion|cotizaci[oó]n|vale la pena|cuanto cuesta|cu[aá]l sale mejor|mejor precio)\b/.test(text);
}

function isProductAdviceIntent(text) {
  return /\b(producto|marca|modelo|garantia|garantía|caracteristicas|características|me sirve|sirve para|saludable|comprar|compra|vale la pena|conviene)\b/.test(text);
}

function isImageQuestionIntent(text) {
  return /\b(que tal|como lo ves|vale la pena|que ves|que aparece|analiza|revisa|opina|este producto|esta imagen|esta foto)\b/.test(text);
}

function isOcrIntent(text) {
  return /\b(ocr|extrae|extraer|saca|lee|leer|transcribe|texto visible|letras)\b/.test(text);
}

function isReminderIntent(text) {
  return /\b(recuerdame|recordarme|recordatorio|recordatorios|avisame|hazme acuerdo|acuerdame)\b/.test(text);
}

function isListIntent(text) {
  if (isReminderIntent(text) && !/\blista\b/.test(text)) return false;
  return /\b(lista|compras|super|supermercado|anota|agrega|quita|elimina|pendientes)\b/.test(text);
}

function isMarketingIntent(text) {
  if (/\b(no quiero|sin)\s+(post|posts|marketing|campana|campanas|contenido)\b/.test(text)) return false;
  return /\b(post|posts|copy|caption|instagram|facebook|tiktok|campana|campanas|anuncio|publicidad|calendario de contenido|contenido para redes)\b/.test(text);
}

function isMemoryIntent(text) {
  return /\b(me llamo|mi nombre es|llamame|como me llamo|cual es mi nombre|prefiero que respondas|me gusta que respondas)\b/.test(text);
}

function detectMemoryUpdates(text) {
  const updates = [];
  const clean = String(text || "").trim();
  const nameMatch = clean.match(/\b(?:me llamo|mi nombre es|llamame)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'-]{0,60})/i);

  if (nameMatch) {
    updates.push({
      type: "user_name",
      value: nameMatch[1].replace(/[.!,;:].*$/, "").trim()
    });
  }

  if (/\bprefiero que respondas\b/i.test(clean)) {
    updates.push({
      type: "response_preference",
      value: clean.slice(0, 240)
    });
  }

  return updates;
}

function extractPlainText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(function (line) {
      return line
        .replace(/^\[\d+\]\s+\w+:\s*/i, "")
        .replace(/^fileId=[^:]+:\s*/i, "")
        .replace(/^\[Audio transcrito\]:\s*/i, "")
        .replace(/^\[Texto adicional\]:\s*/i, "")
        .trim();
    })
    .filter(function (line) {
      return line && !/\[IMAGE uploaded/i.test(line);
    })
    .join("\n")
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPriceFacts(analysis) {
  const text = [
    analysis.main_subject,
    analysis.product_type,
    analysis.brand_or_labels,
    analysis.visible_text,
    analysis.marketing_notes
  ].filter(Boolean).join(" ");
  const priceMatch = text.match(/(?:US\$|\$|USD\s*)\s?\d+(?:[.,]\d{1,2})?/i) || text.match(/\b\d+(?:[.,]\d{1,2})?\s?(?:usd|dolares|d[oó]lares)\b/i);

  return {
    product: analysis.product_type || analysis.main_subject || "producto",
    brand: analysis.brand_or_labels || "",
    model: extractModel(text),
    price: priceMatch ? priceMatch[0].replace(/\s+/g, " ").trim() : "",
    currency: priceMatch ? inferCurrency(priceMatch[0]) : "",
    store: extractStore(text),
    notes: analysis.visible_text || analysis.marketing_notes || "",
    confidence: Number(analysis.confidence || 0)
  };
}

function formatPriceFacts(facts) {
  const parts = [
    facts.product || "producto",
    facts.brand ? "marca/label: " + facts.brand : "",
    facts.model ? "modelo: " + facts.model : "",
    facts.price ? "precio visible: " + facts.price : "no veo precio claro",
    facts.store ? "tienda: " + facts.store : "",
    facts.confidence ? "confianza: " + facts.confidence : ""
  ].filter(Boolean);

  return parts.join("; ") + ".";
}

function chooseBestVisiblePrice(prices) {
  const parsed = prices.map(function (item) {
    const value = Number(String(item.price || "").replace(/[^\d.,]/g, "").replace(",", "."));
    return Object.assign({}, item, { numericPrice: value });
  }).filter(function (item) {
    return Number.isFinite(item.numericPrice) && item.numericPrice > 0;
  });

  if (!parsed.length) return null;
  return parsed.sort(function (a, b) { return a.numericPrice - b.numericPrice; })[0];
}

function extractModel(text) {
  const match = String(text || "").match(/\b(modelo|model)\s*[:#-]?\s*([A-Za-z0-9._-]{2,24})/i);
  return match ? match[2] : "";
}

function extractStore(text) {
  const match = String(text || "").match(/\b(tienda|store)\s*[:#-]?\s*([A-Za-z0-9 ._-]{2,40})/i);
  return match ? match[2].trim() : "";
}

function inferCurrency(text) {
  const clean = String(text || "").toLowerCase();
  if (clean.includes("usd") || clean.includes("$")) return "USD";
  if (clean.includes("dolar")) return "USD";
  return "";
}

function getTurnMediaSubjectText(turn) {
  const pieces = [];
  const batch = turn && turn.media_batch || {};
  const summary = turn && turn.media_batch_summary || {};
  const assets = []
    .concat(Array.isArray(batch.assets) ? batch.assets : [])
    .concat(Array.isArray(summary.assets) ? summary.assets : []);

  for (const asset of assets) {
    const analysis = asset.analysis || asset;
    pieces.push(analysis.main_subject, analysis.product_type, analysis.visible_text, analysis.brand_or_labels, analysis.marketing_notes);
    if (Array.isArray(analysis.objects_detected)) pieces.push(analysis.objects_detected.join(" "));
  }

  pieces.push(summary.summary, summary.main_subject, summary.product_type);
  return pieces.filter(Boolean).join(" ");
}

function isPetMedia(text) {
  return /\b(gato|gatito|gata|perro|perrito|mascota|animal)\b/i.test(String(text || ""));
}

function isCommercialMedia(text) {
  return /\b(producto|empaque|caja|marca|precio|tienda|pasta|dental|parlante|audifono|audífono|cargador|jbl|sony|anker)\b/i.test(String(text || "")) && !isPetMedia(text);
}

function buildImageClarificationQuestion(mediaSubjectText) {
  if (isPetMedia(mediaSubjectText)) {
    return "Veo una mascota en la foto. ¿Quieres que haga una descripción, un caption o una edición de la imagen?";
  }
  return "Veo la imagen. ¿Quieres que la describa, extraiga texto o revise algún detalle específico?";
}

function logIntentLeakagePrevented(fromIntent, toIntent, reason) {
  console.log("INTENT_LEAKAGE_PREVENTED:", JSON.stringify({
    fromIntent: fromIntent,
    toIntent: toIntent,
    reason: reason
  }));
  logEvent("INTENT_LEAKAGE_PREVENTED", {
    fromIntent: fromIntent,
    toIntent: toIntent,
    reason: reason
  });
}
