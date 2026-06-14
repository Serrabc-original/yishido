import { logEvent } from "../logger.js";
import { buildResponsePlan } from "../contracts/assistantContracts.js";

const GENERIC_FALLBACK_PATTERNS = [
  /entendido\.?\s*¿?que necesitas que haga con esto\??/i,
  /entendido\.?\s*¿?qué necesitas que haga con esto\??/i,
  /¿?que quieres que haga con esta imagen\??/i,
  /¿?qué quieres que haga con esta imagen\??/i
];

const PURCHASE_ADVICE_PATTERN = /\b(modelo exacto|garantia|garant[ií]a|condiciones antes de decidir|antes de comprar|precio visible|caro|barato)\b/i;
const PET_PATTERN = /\b(gato|gatito|gata|perro|perrito|mascota|animal)\b/i;
const PRODUCT_PATTERN = /\b(producto|empaque|caja|marca|precio|tienda|pasta|dental|parlante|audifono|audífono|cargador|jbl|sony|anker)\b/i;

export function composeFinalResponse(input) {
  const clean = input || {};
  const supervisorPlan = clean.supervisorPlan || {};
  const specialistResults = clean.specialistResults || {};
  const currentUserMessage = String(clean.currentUserMessage || "");
  const mediaSummary = clean.currentMediaSummary || {};
  const draft = String(clean.draftResponse || buildDraftResponse(clean)).trim();
  const sanity = clean.sanityCheck || validateSpecialistOutputAgainstIntent({
    supervisorPlan: supervisorPlan,
    specialistResults: specialistResults,
    currentUserMessage: currentUserMessage,
    currentMediaSummary: mediaSummary,
    responseText: draft
  });

  if (sanity.ok && draft) {
    return {
      text: draft,
      repaired: false,
      responsePlan: composeResponsePlan({
        text: draft,
        supervisorPlan: supervisorPlan,
        trace: clean.trace || {}
      }),
      sanityCheck: sanity
    };
  }

  const repaired = repairFinalResponse({
    supervisorPlan: supervisorPlan,
    specialistResults: specialistResults,
    currentUserMessage: currentUserMessage,
    currentMediaSummary: mediaSummary,
    failedDraft: draft,
    failureReasons: sanity.reasons || []
  });

  const repairedSanity = validateSpecialistOutputAgainstIntent({
    supervisorPlan: supervisorPlan,
    specialistResults: specialistResults,
    currentUserMessage: currentUserMessage,
    currentMediaSummary: mediaSummary,
    responseText: repaired
  });

  if (repairedSanity.ok && repaired) {
    logEvent("FINAL_RESPONSE_REPAIRED", {
      intent: supervisorPlan.intent || "",
      reasons: sanity.reasons || []
    });
    return {
      text: repaired,
      repaired: true,
      responsePlan: composeResponsePlan({
        text: repaired,
        supervisorPlan: supervisorPlan,
        trace: clean.trace || {}
      }),
      sanityCheck: repairedSanity
    };
  }

  logEvent("FINAL_RESPONSE_REPAIR_FAILED", {
    intent: supervisorPlan.intent || "",
    reasons: repairedSanity.reasons || sanity.reasons || []
  }, { level: "error" });

  return {
    text: buildSpecificClarification(currentUserMessage, mediaSummary),
    repaired: true,
    responsePlan: composeResponsePlan({
      text: buildSpecificClarification(currentUserMessage, mediaSummary),
      supervisorPlan: supervisorPlan,
      trace: clean.trace || {}
    }),
    sanityCheck: repairedSanity
  };
}

export function composeResponsePlan(input) {
  const clean = input || {};
  const text = String(clean.text || "").trim();
  const plan = clean.supervisorPlan || {};

  return buildResponsePlan({
    text: text,
    requiresTemplate: Boolean(clean.requiresTemplate),
    interactive: clean.interactive || null,
    traceId: clean.traceId || clean.trace && clean.trace.traceId || "",
    turnId: clean.turnId || clean.trace && clean.trace.turnId || "",
    doName: clean.doName || clean.trace && clean.trace.doName || "",
    messages: splitConversationalText(text, {
      maxChars: clean.maxChars || 650
    }).map(function (part) {
      return {
        type: "TEXT",
        text: part
      };
    }),
    supervisor: {
      intent: plan.intent || "",
      mediaScope: plan.mediaScope || ""
    }
  });
}

export function validateSpecialistOutputAgainstIntent(input) {
  const clean = input || {};
  const plan = clean.supervisorPlan || {};
  const text = String(clean.responseText || clean.specialistResults && clean.specialistResults.text || "");
  const message = String(clean.currentUserMessage || "");
  const mediaSummary = clean.currentMediaSummary || {};
  const reasons = [];
  const subjectText = getMediaSubjectText(mediaSummary, clean.specialistResults || {});
  const clearQuestion = hasClearQuestion(message);
  const petMedia = isPetMedia(subjectText);
  const productMedia = isProductMedia(subjectText);
  const priceIntent = isPriceIntent(plan.intent);

  logEvent("FINAL_RESPONSE_SANITY_CHECK_START", {
    intent: plan.intent || "",
    textLength: text.length,
    petMedia: petMedia,
    productMedia: productMedia,
    clearQuestion: clearQuestion
  });

  if (petMedia && PURCHASE_ADVICE_PATTERN.test(text) && !priceIntent) {
    reasons.push("purchase_advice_on_pet_or_noncommercial_media");
  }

  if (petMedia && priceIntent && !hasCommercialPriceContext(message)) {
    reasons.push("price_intent_on_pet_without_commercial_context");
  }

  if (clearQuestion && isGenericFallback(text)) {
    reasons.push("generic_fallback_for_clear_question");
  }

  if (text && !answersUserQuestion(text, message, plan, mediaSummary)) {
    reasons.push("response_does_not_answer_user");
  }

  if (plan.mediaScope === "previous_relevant" && !referencesPreviousMedia(message)) {
    reasons.push("previous_media_used_without_reference");
  }

  if (priceIntent && !productMedia && petMedia) {
    reasons.push("specialist_result_out_of_context");
  }

  const ok = reasons.length === 0;
  logEvent(ok ? "FINAL_RESPONSE_SANITY_CHECK_OK" : "FINAL_RESPONSE_SANITY_CHECK_FAILED", {
    intent: plan.intent || "",
    reasons: reasons
  }, ok ? {} : { level: "error" });

  if (!ok && reasons.some(function (reason) {
    return reason.includes("pet") || reason.includes("out_of_context");
  })) {
    logEvent("SPECIALIST_REJECTED_BY_SANITY_CHECK", {
      intent: plan.intent || "",
      reasons: reasons
    }, { level: "error" });
  }

  return {
    ok: ok,
    reasons: reasons
  };
}

export function composeGeneralTextAnswer(text) {
  const normalized = normalizeText(text);

  if (isGreeting(normalized)) {
    return "Hola, Mateo. Estoy listo. Puedes mandarme texto, audios, fotos o capturas y te ayudo a analizarlas, comparar precios, hacer listas o dejar recordatorios.";
  }

  if (asksCapabilities(normalized)) {
    return "Puedo responder preguntas, explicar temas rapido, revisar imagenes, comparar precios, leer texto visible en fotos, entender audios transcritos, crear listas y preparar recordatorios. Tambien puedo ayudarte con contenido para redes, pero solo cuando me lo pidas claramente.";
  }

  if (asksGenericHelp(normalized)) {
    return "Claro. Mandame el texto, foto o audio y dime que quieres lograr: explicarlo, resumirlo, comparar opciones, sacar una lista o dejar un recordatorio.";
  }

  if (!hasClearQuestion(text)) return "";

  if (/\bmotor(es)?\s+de\s+induccion\b/.test(normalized)) {
    return [
      "Si, te explico simple.",
      "Un motor de induccion funciona usando electricidad para crear un campo magnetico giratorio en el estator. Ese campo induce corriente en el rotor y eso genera movimiento.",
      "En simple: no necesita escobillas; el rotor gira porque el campo magnetico lo arrastra."
    ].join("\n\n");
  }

  if (/\bmotor(es)?\s+(a\s+)?induccion\b/.test(normalized) || /\bmotor(es)?\s+(a\s+)?induccion\b/.test(normalized.replace(/ó/g, "o"))) {
    return [
      "Sí, te explico simple.",
      "Un motor de inducción funciona usando electricidad para crear un campo magnético giratorio en el estator. Ese campo induce corriente en el rotor y eso genera movimiento.",
      "En simple: no necesita escobillas; el rotor gira porque el campo magnético lo arrastra. Para hacerlo necesitas estator con bobinas, rotor, núcleo laminado, carcasa, eje, rodamientos y una alimentación de corriente alterna."
    ].join("\n\n");
  }

  if (/^como se hace|^como funciona|^que es|^por que|^para que/i.test(normalized)) {
    return "Te respondo directo: la idea es entender primero el principio, luego las partes y finalmente el armado o uso. Si me dices el nivel que quieres, básico o técnico, te lo explico paso a paso.";
  }

  return "";
}

export function splitConversationalText(text, options) {
  const clean = String(text || "").trim();
  const maxChars = Number(options && options.maxChars || 650);
  if (!clean || clean.length <= maxChars) return clean ? [clean] : [];

  const paragraphs = clean.split(/\n{2,}/).map(function (item) { return item.trim(); }).filter(Boolean);
  const parts = [];
  let current = "";

  for (const paragraph of paragraphs.length ? paragraphs : [clean]) {
    const sentences = paragraph.split(/(?<=[.!?])\s+/).filter(Boolean);
    for (const sentence of sentences) {
      const candidate = current ? current + " " + sentence : sentence;
      if (candidate.length <= maxChars || !current) {
        current = candidate;
      } else {
        parts.push(current.trim());
        current = sentence;
      }
    }
    if (current && current.length > maxChars * 0.7) {
      parts.push(current.trim());
      current = "";
    }
  }

  if (current) parts.push(current.trim());
  return parts.slice(0, 4);
}

export function shouldSendFastAck(input) {
  const clean = input || {};
  const plan = clean.supervisorPlan || {};
  const turn = clean.userTurn || {};
  const env = clean.env || {};
  const enabled = String(env.FAST_ACK_ENABLED || "true").toLowerCase() !== "false";
  const imageCount = Number(turn.image_count || 0);
  const audioCount = Number(turn.audio_count || 0);
  const complex = imageCount > 1 ||
    audioCount > 0 && String(turn.current_turn_text || "").length > 240 ||
    isPriceIntent(plan.intent) ||
    plan.intent === "multi_image_review" ||
    (plan.targetModules || []).includes("image_generation");
  const shouldSend = Boolean(enabled && complex);

  logEvent("FAST_ACK_DECISION", {
    intent: plan.intent || "",
    imageCount: imageCount,
    audioCount: audioCount,
    shouldSend: shouldSend
  });

  return shouldSend;
}

export function buildFastAckText(supervisorPlan, userTurn) {
  const plan = supervisorPlan || {};
  const imageCount = Number(userTurn && userTurn.image_count || 0);

  if (isPriceIntent(plan.intent)) return "Perfecto, estoy revisando los precios.";
  if (imageCount > 1) return "Dame un momento, voy a comparar las imágenes.";
  if ((plan.targetModules || []).includes("image_generation")) return "Ya lo estoy procesando.";
  return "Listo, lo reviso y te digo.";
}

function buildDraftResponse(input) {
  const plan = input.supervisorPlan || {};
  const results = input.specialistResults || {};
  const message = String(input.currentUserMessage || "");
  const mediaSummary = input.currentMediaSummary || {};

  if (results.text) return results.text;

  if (plan.intent === "price_review" || plan.intent === "multi_image_price_review") {
    return formatPriceReview(results.vision || mediaSummary);
  }

  if (plan.intent === "product_advice") {
    return formatProductAdvice(results.vision || mediaSummary, message);
  }

  if (plan.intent === "pet_photo" || isPetMedia(getMediaSubjectText(mediaSummary, results))) {
    return formatPetPhotoResponse(results.vision || mediaSummary, message);
  }

  if (plan.intent === "image_question" || plan.intent === "multi_image_review" || plan.intent === "unknown_image_request") {
    return formatImageResponse(results.vision || mediaSummary, message);
  }

  return composeGeneralTextAnswer(message);
}

function repairFinalResponse(input) {
  const subjectText = getMediaSubjectText(input.currentMediaSummary, input.specialistResults);
  const message = String(input.currentUserMessage || "");

  if (isPetMedia(subjectText)) {
    return formatPetPhotoResponse(input.specialistResults.vision || input.currentMediaSummary || {}, message);
  }

  if (hasClearQuestion(message)) {
    return composeGeneralTextAnswer(message) || buildSpecificClarification(message, input.currentMediaSummary);
  }

  return buildSpecificClarification(message, input.currentMediaSummary);
}

function formatPetPhotoResponse(summary, message) {
  const subject = firstSubject(summary) || "un gatito";
  const normalized = normalizeText(message);

  if (/\bque tal|como lo ves|opina\b/.test(normalized)) {
    return "Está buenísima la foto: se ve " + subject + " relajado y gracioso por la postura. Si la quieres usar para Instagram, yo haría un caption tierno o divertido.";
  }

  return "Veo " + subject + " en una escena tranquila. Si quieres, puedo ayudarte a describir la foto, hacer un caption tierno o pensar una edición con un estilo específico.";
}

function formatImageResponse(summary, message) {
  const subject = firstSubject(summary);
  const visible = collectVisibleText(summary).join(" | ");

  if (subject) {
    return [
      "Veo " + subject + ".",
      visible ? "Texto visible: " + visible : "",
      hasClearQuestion(message) ? "Con lo que se ve en la imagen, esa es la parte mas relevante para responderte." : "Quieres que la analice, extraiga texto o la compare con otra imagen?"
    ].filter(Boolean).join("\n");
  }

  return buildSpecificClarification(message, summary);
}

function formatProductAdvice(summary, message) {
  const visible = collectVisibleText(summary).join(" | ");
  const normalized = normalizeText(message);

  if (/\bsarro|tartar\b/.test(normalized)) {
    return [
      "Por la foto solo puedo confirmar lo visible del empaque.",
      "Para sarro buscaría que diga \"control de sarro\" o \"tartar control\". " + (visible ? "Si en el empaque no aparece eso claramente, " : "") + "puede servir como pasta diaria, pero no la elegiría específicamente para sarro."
    ].join(" ");
  }

  return [
    "Por lo visible, parece un producto de consumo.",
    visible ? "Texto visible: " + visible : "",
    "Si quieres evaluarlo, revisaría uso indicado, ingredientes/características y advertencias del empaque."
  ].filter(Boolean).join("\n");
}

function formatPriceReview(summary) {
  const assets = Array.isArray(summary && summary.assets) ? summary.assets : [];
  const analyzed = assets.filter(function (asset) { return asset && asset.analysis; });
  const failedCount = Number(summary && summary.failed_asset_count || assets.filter(function (asset) {
    return asset && asset.status === "analysis_failed";
  }).length || 0);
  if (!analyzed.length) return "No pude leer un precio claro. Enviame una foto donde el precio se vea completo y lo reviso.";

  const lines = ["Sí, revisé " + analyzed.length + " imagen" + (analyzed.length === 1 ? "" : "es") + "."];
  const priced = [];
  analyzed.forEach(function (asset, index) {
    const analysis = asset.analysis || {};
    const price = extractPrice([analysis.visible_text, analysis.marketing_notes, analysis.main_subject].join(" "));
    if (price) {
      priced.push({
        index: index + 1,
        product: analysis.product_type || analysis.main_subject || "producto",
        amount: parsePriceAmount(price)
      });
    }
    lines.push("Imagen " + (index + 1) + ": " + (analysis.product_type || analysis.main_subject || "producto") + (price ? " - precio visible: " + price : " - no veo precio claro") + ".");
  });
  const validPrices = priced.filter(function (item) { return Number.isFinite(item.amount); });
  if (validPrices.length > 1) {
    validPrices.sort(function (a, b) { return a.amount - b.amount; });
    lines.push("Con solo el precio visible, la imagen " + validPrices[0].index + " parece mas conveniente; confirma modelo, estado y garantia antes de decidir.");
  }
  if (failedCount) {
    lines.push("Ojo: " + failedCount + " imagen" + (failedCount === 1 ? "" : "es") + " no se pudo analizar, pero segui con las demas.");
  }
  lines.push("Para decir si esta caro con seguridad faltaria comparar modelo exacto, estado, tienda y garantia.");
  return lines.join("\n");
}

function buildSpecificClarification(message, mediaSummary) {
  const subject = firstSubject(mediaSummary);
  if (subject) {
    return "Veo " + subject + ". Quieres que la analice, extraiga texto o la compare con otra imagen?";
  }
  return hasClearQuestion(message)
    ? "Quiero responderte bien, pero me falta un dato especifico. Te refieres al funcionamiento, al armado o a los materiales?"
    : "Quieres que lo analice, extraiga texto o lo convierta en una lista?";
}

function isGenericFallback(text) {
  return GENERIC_FALLBACK_PATTERNS.some(function (pattern) {
    return pattern.test(String(text || ""));
  });
}

function answersUserQuestion(responseText, message, plan, mediaSummary) {
  if (!hasClearQuestion(message)) return true;
  if (isGenericFallback(responseText)) return false;
  const normalizedResponse = normalizeText(responseText);
  const normalizedMessage = normalizeText(message);
  if (/\bmotor(es)?\s+de\s+induccion\b/.test(normalizedMessage)) return normalizedResponse.includes("campo magnetico") || normalizedResponse.includes("estator");
  if (/\bmotor(es)?\s+(a\s+)?induccion\b/.test(normalizedMessage)) return normalizedResponse.includes("campo magnetico") || normalizedResponse.includes("estator");
  if (/\bsarro|tartar\b/.test(normalizedMessage)) return normalizedResponse.includes("sarro") || normalizedResponse.includes("tartar");
  if ((plan.intent || "").includes("image") && firstSubject(mediaSummary)) return normalizedResponse.length > 20;
  return normalizedResponse.length > 25;
}

function hasClearQuestion(text) {
  const normalized = normalizeText(text);
  return String(text || "").includes("?") ||
    /\b(como|cómo|que|qué|por que|por qué|para que|para qué|me sirve|sirve para|cuanto|cuánto|cual|cuál)\b/.test(normalized);
}

function isGreeting(normalized) {
  return /^(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches|hey|hello)\b/.test(normalized);
}

function asksCapabilities(normalized) {
  return /\b(que puedes hacer|para que sirves|ayuda|comandos|help)\b/.test(normalized);
}

function asksGenericHelp(normalized) {
  return /\b(ayudame con esto|me ayudas con esto|puedes ayudarme con esto)\b/.test(normalized);
}

function hasCommercialPriceContext(text) {
  return /\b(precio|caro|barato|comprar|compra|vale la pena|conviene|producto|modelo|marca|garantia|garantía)\b/i.test(String(text || ""));
}

function referencesPreviousMedia(text) {
  return /\b(anterior|lo de antes|esa imagen|esta imagen|primera|segunda|tercera|los precios)\b/i.test(String(text || ""));
}

function isPriceIntent(intent) {
  return ["price_review", "multi_image_price_review"].includes(String(intent || ""));
}

function isPetMedia(text) {
  return PET_PATTERN.test(String(text || ""));
}

function isProductMedia(text) {
  return PRODUCT_PATTERN.test(String(text || "")) && !isPetMedia(text);
}

function getMediaSubjectText(mediaSummary, specialistResults) {
  const pieces = [];
  const summary = specialistResults && specialistResults.vision || mediaSummary || {};
  const assets = Array.isArray(summary.assets) ? summary.assets : [];

  for (const asset of assets) {
    const analysis = asset.analysis || asset;
    pieces.push(analysis.main_subject, analysis.product_type, analysis.visible_text, analysis.brand_or_labels, analysis.marketing_notes);
    if (Array.isArray(analysis.objects_detected)) pieces.push(analysis.objects_detected.join(" "));
  }

  pieces.push(summary.main_subject, summary.product_type, summary.visible_text, summary.summary);
  return pieces.filter(Boolean).join(" ");
}

function firstSubject(summary) {
  const assets = Array.isArray(summary && summary.assets) ? summary.assets : [];
  for (const asset of assets) {
    const analysis = asset.analysis || asset;
    const subject = analysis.main_subject || analysis.product_type || "";
    if (subject) return subject;
  }
  return summary && (summary.main_subject || summary.product_type || summary.summary) || "";
}

function collectVisibleText(summary) {
  const assets = Array.isArray(summary && summary.assets) ? summary.assets : [];
  return assets.map(function (asset) {
    return asset.analysis && asset.analysis.visible_text || asset.visible_text || "";
  }).filter(Boolean);
}

function extractPrice(text) {
  const match = String(text || "").match(/(?:US\$|\$|USD\s*)\s?\d+(?:[.,]\d{1,2})?/i);
  return match ? match[0] : "";
}

function parsePriceAmount(price) {
  const match = String(price || "").match(/\d+(?:[.,]\d{1,2})?/);
  return match ? Number(match[0].replace(",", ".")) : NaN;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
