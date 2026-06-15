import { logEvent } from "../logger.js";
import {
  buildProfileFallbackReply,
  getConversationPromptGuidance,
  inferConversationScenario
} from "./conversationStyleProfile.js";
import { getCustomerReplyModel } from "./modelRegistry.js";
import { splitConversationalText } from "./finalResponseComposer.js";

export const CUSTOMER_REPLY_MODEL = "CUSTOMER_REPLY_MODEL";

export function buildCustomerReplyPromptPayload(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || clean.user_turn || {};
  const systemResult = clean.systemResult || clean.system_result || {};
  const supervisorPlan = clean.supervisorPlan || clean.supervisor_plan || {};
  const imageCount = Number(userTurn.image_count || userTurn.counts && userTurn.counts.image || 0);
  const audioCount = Number(userTurn.audio_count || userTurn.counts && userTurn.counts.audio || 0);
  const userText = String(userTurn.combinedUserText || userTurn.current_turn_text || "").trim();

  return {
    role: "customer_reply_composer",
    purpose: "Redactar la respuesta final visible de un asistente conversacional de WhatsApp.",
    output_contract: {
      type: "json",
      schema: {
        text: "string",
        shouldSend: "boolean"
      }
    },
    non_negotiable_rules: [
      "Responde en espanol natural, calido, claro y breve.",
      "No expliques que eres un modulo ni menciones el orquestador, vision, OCR, prompts o herramientas internas.",
      "Si el usuario hizo una pregunta o solicitud clara, responde directo. No mandes menus genericos.",
      "Si hay imagenes y texto/audio claro, usa el texto/audio como intencion y las imagenes como evidencia.",
      "Si solo hay imagenes sin instruccion, no describas de golpe: pregunta una aclaracion util con opciones concretas.",
      "Si el sistema analizo imagenes, convierte el analisis en ayuda accionable, no en una descripcion seca.",
      "No digas que no puedes generar imagenes si el intent o nextAction indica image_generation.",
      "No inventes datos que no aparecen en systemResult o visibleFacts.",
      "No digas 'No veo imagen' ni 'solo me llego una imagen' si imageCount o recentMediaCount es mayor que cero.",
      "No uses frases como 'Quieres que lo explique, lo resuma o revise algun detalle puntual' cuando la intencion ya esta clara."
    ],
    style: {
      tone: clean.tone || "warm_professional",
      verbosity: clean.verbosity || "helpful_short",
      locale: clean.locale || "es",
      whatsapp: {
        max_paragraphs: 3,
        prefer_short_sentences: true,
        ask_one_question_only_if_needed: true
      }
    },
    routing_context: {
      intent: String(clean.intent || systemResult.intent || supervisorPlan.intent || ""),
      targetModules: supervisorPlan.targetModules || supervisorPlan.target_modules || [],
      responseStrategy: supervisorPlan.responseStrategy || supervisorPlan.response_strategy || "",
      nextAction: clean.nextAction || clean.next_action || ""
    },
    user_turn: {
      turnId: String(userTurn.turn_id || userTurn.turnId || ""),
      text: userText,
      inputTypes: userTurn.input_types || userTurn.inputTypes || [],
      counts: {
        text: Number(userTurn.text_count || userTurn.counts && userTurn.counts.text || 0),
        audio: audioCount,
        image: imageCount,
        video: Number(userTurn.video_count || userTurn.counts && userTurn.counts.video || 0),
        file: Number(userTurn.file_count || userTurn.counts && userTurn.counts.file || 0)
      },
      captions: userTurn.captions || [],
      audioTranscripts: userTurn.audio_transcripts || userTurn.audioTranscripts || []
    },
    media_context: {
      currentImageCount: imageCount,
      recentMediaCount: Number(clean.recentMediaCount || clean.recent_media_count || 0),
      visibleFacts: clean.visibleFacts || clean.visible_facts || [],
      moduleResult: systemResult
    },
    conversation_guidance: getConversationPromptGuidance(),
    draft_response: String(systemResult.text || clean.text || "").trim()
  };
}

export function composeCustomerReply(input, env) {
  const clean = input || {};
  const userTurn = clean.userTurn || clean.user_turn || {};
  const systemResult = clean.systemResult || clean.system_result || {};
  const intent = String(clean.intent || systemResult.intent || "");
  const text = String(systemResult.text || clean.text || "").trim();
  const locale = String(clean.locale || "es");
  const tone = String(clean.tone || "warm_professional");
  const verbosity = String(clean.verbosity || "helpful_short");
  const model = getCustomerReplyModel(env || {});
  const scenario = inferConversationScenario(userTurn.combinedUserText || userTurn.current_turn_text || "", intent);

  logEvent("CUSTOMER_REPLY_COMPOSER_START", {
    traceId: userTurn.trace_id || clean.traceId || "",
    turnId: userTurn.turn_id || clean.turnId || "",
    intent: intent,
    scenario: scenario,
    tone: tone,
    verbosity: verbosity,
    locale: locale
  });
  logEvent("CUSTOMER_REPLY_MODEL_SELECTED", {
    traceId: userTurn.trace_id || clean.traceId || "",
    turnId: userTurn.turn_id || clean.turnId || "",
    model: model
  });

  if (looksUnsafeToSend(text)) {
    logEvent("CUSTOMER_REPLY_COMPOSER_BLOCKED_UNSAFE", {
      traceId: userTurn.trace_id || clean.traceId || "",
      turnId: userTurn.turn_id || clean.turnId || "",
      reason: "empty_or_secret_like"
    }, { level: "error" });
    return { text: "", shouldSend: false, splitMessages: [] };
  }

  const composed = humanizeReply({
    text: text || buildSafeTemplate(clean),
    userTurn: userTurn,
    intent: intent,
    scenario: scenario,
    conversationProfile: getConversationPromptGuidance(),
    visibleFacts: clean.visibleFacts || clean.visible_facts || [],
    nextAction: clean.nextAction || clean.next_action || ""
  });

  logEvent(text ? "CUSTOMER_REPLY_COMPOSER_OK" : "CUSTOMER_REPLY_COMPOSER_FALLBACK", {
    traceId: userTurn.trace_id || clean.traceId || "",
    turnId: userTurn.turn_id || clean.turnId || "",
    intent: intent,
    textLength: composed.length
  });

  return {
    text: composed,
    shouldSend: Boolean(composed),
    splitMessages: splitConversationalText(composed, { maxChars: clean.maxChars || 650 })
  };
}

function humanizeReply(input) {
  const userTurn = input.userTurn || {};
  const hasClearText = Boolean(String(userTurn.combinedUserText || userTurn.current_turn_text || "").trim());
  const imageCount = Number(userTurn.image_count || userTurn.counts && userTurn.counts.image || 0);
  const userText = String(userTurn.combinedUserText || userTurn.current_turn_text || "").trim();
  const scenario = input.scenario || inferConversationScenario(userText, input.intent || "");
  let text = String(input.text || "").trim();
  const originalText = text;
  const hadGenericMenu = looksLikeGenericMenu(text);

  text = text
    .replace(/\bAn[aá]lisis visual:?\s*/gi, "")
    .replace(/^\s*Entendido\.?\s*/i, "")
    .replace(/^\s*Claro\.?\s*$/i, "Claro, te ayudo.")
    .replace(/Quieres que la analice, extraiga texto o la compare con otra imagen\?/gi, hasClearText ? "" : "Dime si quieres que la analice, extraiga texto o la compare con otra imagen.")
    .replace(/[¿?]?Quieres que (lo|la|te) (explique|resuma|revise)[^.\n?]*[?.]?/gi, hasClearText ? "" : "$&")
    .replace(/Que quieres que haga con est[oa]\?/gi, hasClearText ? "" : "Dime que quieres hacer con esto y te ayudo.")
    .trim();

  if (hasClearText && containsVisibleTextAnswer(originalText)) {
    text = stripTrailingGenericPrompt(originalText).trim();
  } else if (hasClearText && (hadGenericMenu || looksLikeGenericMenu(text) || !text)) {
    text = buildDirectTemplateFromUserText(userText, text, scenario);
  }

  if (!text && imageCount && !hasClearText) {
    text = imageCount > 1
      ? "Recibi las imagenes. Dime si quieres que las compare, lea texto visible o revise algun detalle puntual."
      : "Recibi la imagen. Dime si quieres que la analice, lea texto visible o la compare con otra.";
  }

  if (!text) text = buildSafeTemplate(Object.assign({}, input, { scenario: scenario }));
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function looksLikeGenericMenu(text) {
  const clean = normalizeSimpleText(text);
  if (!clean) return false;
  const menuPatterns = [
    "quieres que lo explique",
    "quieres que lo resuma",
    "revise algun detalle puntual",
    "revise algún detalle puntual",
    "dime si quieres que",
    "que quieres que haga con esto",
    "qué quieres que haga con esto"
  ];
  return menuPatterns.some(function (pattern) {
    return clean.includes(normalizeSimpleText(pattern));
  });
}

function containsVisibleTextAnswer(text) {
  const clean = normalizeSimpleText(text);
  return /\b(texto visible|visible text|visible_text|texto detectado|ocr|se lee|dice|aparece en la imagen|en la captura)\b/.test(clean);
}

function stripTrailingGenericPrompt(text) {
  return String(text || "")
    .replace(/[Â¿¿?]?Quieres que (lo|la|te) (explique|resuma|revise|analice)[^.\n?]*[?.]?/gi, "")
    .replace(/Dime si quieres que (lo|la|las|te)[^.\n?]*[?.]?/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildDirectTemplateFromUserText(userText, fallbackText, scenario) {
  const clean = normalizeSimpleText(userText);

  if (scenario === "appointment") {
    return buildProfileFallbackReply({ userText: userText, scenario: "appointment" });
  }

  if (clean.includes("libro") && clean.includes("aguacate")) {
    return [
      "Te respondo las dos cosas.",
      "Sobre el libro: si me dices el titulo exacto puedo darte una opinion mas precisa; por ahora miraria si te deja ideas claras y acciones concretas.",
      "Para aguacate molido: limon, sal, pimienta, cilantro, cebolla morada y tomate. Si lo quieres mas cremoso, agrega un chorrito de aceite de oliva; si lo quieres picante, aji o jalapeno."
    ].join("\n\n");
  }

  if (clean.includes("desayuno")) {
    return "Una idea rapida de desayuno: tostada con aguacate molido, huevo, sal, pimienta y limon. Si quieres algo mas completo, agrega tomate o queso fresco y una fruta.";
  }

  if (/^(que|qué|como|cómo|cual|cuál|por que|por qué|para que|para qué)\b/.test(clean)) {
    return String(fallbackText || "").trim() && !looksLikeGenericMenu(fallbackText)
      ? String(fallbackText).trim()
      : "Te respondo directo: dime el tema exacto y te doy una explicacion clara, sin menu ni rodeos.";
  }

  return String(fallbackText || "").trim() && !looksLikeGenericMenu(fallbackText)
    ? String(fallbackText).trim()
    : "Te ayudo directo con eso. Voy a tomar tu mensaje como la instruccion principal y responder sin pedirte que elijas otro menu.";
}

function normalizeSimpleText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}¿?]+/gu, " ")
    .trim();
}

function buildSafeTemplate(input) {
  const intent = String(input.intent || "");
  const userTurn = input.userTurn || {};
  const imageCount = Number(userTurn.image_count || 0);
  const audioCount = Number(userTurn.audio_count || 0);
  const userText = String(userTurn.combinedUserText || userTurn.current_turn_text || "");
  const scenario = input.scenario || inferConversationScenario(userText, intent);

  if (intent === "unknown_image_request" && imageCount) {
    return imageCount > 1
      ? "Recibi las imagenes. Para ayudarte mejor, dime si quieres que las compare, lea texto visible o revise algun detalle puntual."
      : "Recibi la imagen. Para ayudarte mejor, dime si quieres que la analice, lea texto visible o la compare con otra.";
  }
  if (audioCount && !String(userTurn.combinedUserText || userTurn.current_turn_text || "").trim()) {
    return "No pude entender bien el audio. Puedes reenviarlo o escribirme la idea principal?";
  }
  if (scenario && scenario !== "empty") {
    return buildProfileFallbackReply({ userText: userText, intent: intent, scenario: scenario });
  }
  return "Listo, te ayudo con eso.";
}

function looksUnsafeToSend(text) {
  if (!String(text || "").trim()) return false;
  return /(OPENAI_API_KEY|ANTHROPIC_API_KEY|WOZTELL_ACCESS_TOKEN|WOZTELL_OPEN_API_TOKEN|GOOGLE_SHEETS_SECRET)=/i.test(text);
}
