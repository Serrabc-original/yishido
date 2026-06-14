import { logEvent } from "../logger.js";
import { getCustomerReplyModel } from "./modelRegistry.js";
import { splitConversationalText } from "./finalResponseComposer.js";

export const CUSTOMER_REPLY_MODEL = "CUSTOMER_REPLY_MODEL";

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

  logEvent("CUSTOMER_REPLY_COMPOSER_START", {
    traceId: userTurn.trace_id || clean.traceId || "",
    turnId: userTurn.turn_id || clean.turnId || "",
    intent: intent,
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
  let text = String(input.text || "").trim();

  text = text
    .replace(/\bAn[aá]lisis visual:?\s*/gi, "")
    .replace(/^\s*Entendido\.?\s*/i, "")
    .replace(/^\s*Claro\.?\s*$/i, "Claro, te ayudo.")
    .replace(/Quieres que la analice, extraiga texto o la compare con otra imagen\?/gi, hasClearText ? "" : "Dime si quieres que la analice, extraiga texto o la compare con otra imagen.")
    .replace(/Que quieres que haga con est[oa]\?/gi, hasClearText ? "" : "Dime que quieres hacer con esto y te ayudo.")
    .trim();

  if (!text && imageCount && !hasClearText) {
    text = "Recibi la imagen. Dime si quieres que la analice, lea texto visible o la compare con otra.";
  }

  if (!text) text = buildSafeTemplate(input);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

function buildSafeTemplate(input) {
  const intent = String(input.intent || "");
  const userTurn = input.userTurn || {};
  const imageCount = Number(userTurn.image_count || 0);
  const audioCount = Number(userTurn.audio_count || 0);

  if (intent === "unknown_image_request" && imageCount) {
    return "Recibi la imagen. Para ayudarte mejor, dime si quieres que la analice, lea texto visible o la compare con otra.";
  }
  if (audioCount && !String(userTurn.combinedUserText || userTurn.current_turn_text || "").trim()) {
    return "No pude entender bien el audio. Puedes reenviarlo o escribirme la idea principal?";
  }
  return "Listo, te ayudo con eso.";
}

function looksUnsafeToSend(text) {
  if (!String(text || "").trim()) return false;
  return /(OPENAI_API_KEY|ANTHROPIC_API_KEY|WOZTELL_ACCESS_TOKEN|WOZTELL_OPEN_API_TOKEN|GOOGLE_SHEETS_SECRET)=/i.test(text);
}

