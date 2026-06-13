import { redactForLog } from "./logger.js";

const MAX_CONVERSATION_LOG = 30;
const MAX_KEYWORDS = 12;

export function getCoreFeatureFlags(env) {
  return {
    debugLogs: parseBooleanEnv(env && env.DEBUG_LOGS, false),
    saveConversationLogs: parseBooleanEnv(env && env.SAVE_CONVERSATION_LOGS, false),
    enableUserStyleProfile: parseBooleanEnv(env && env.ENABLE_USER_STYLE_PROFILE, false),
    enableCustomerMemory: parseBooleanEnv(env && env.ENABLE_CUSTOMER_MEMORY, false),
    enableReminders: parseBooleanEnv(env && env.ENABLE_REMINDERS, false),
    enableLists: parseBooleanEnv(env && env.ENABLE_LISTS, false),
    enableWhatsAppInteractive: parseBooleanEnv(env && env.ENABLE_WHATSAPP_INTERACTIVE, false),
    enableTemplateModule: parseBooleanEnv(env && env.ENABLE_TEMPLATE_MODULE, false)
  };
}

export function updateConversationMemory(data, userTurn, options) {
  const flags = options && options.flags || {};
  const next = Object.assign({}, data || {});
  const previousLog = Array.isArray(next.conversationLog) ? next.conversationLog : [];
  const safeTurn = buildConversationLogEntry(userTurn);

  if (flags.saveConversationLogs) {
    next.conversationLog = previousLog.concat([safeTurn]).slice(-MAX_CONVERSATION_LOG);
  } else {
    next.conversationLog = previousLog;
  }

  next.conversationSummary = buildConversationSummary(
    flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-6)
  );
  next.utilityMemory = buildUtilityMemory(options && options.utilityState || next.coreUtilityState || {});

  if (flags.enableUserStyleProfile) {
    next.userStyleProfile = buildUserStyleProfile(
      flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-6),
      next.userStyleProfile
    );
  }

  if (flags.enableCustomerMemory) {
    next.customerMemory = buildCustomerMemory(
      flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-6),
      next.customerMemory
    );
  }

  return next;
}

export function buildConversationLogEntry(userTurn) {
  const turn = userTurn || {};
  const text = sanitizeMemoryText(turn.current_turn_text || "");

  return redactForLog({
    turnId: turn.turn_id || "",
    traceId: turn.trace_id || "",
    at: turn.created_at || new Date().toISOString(),
    inputTypes: turn.input_types || [],
    counts: {
      text: turn.text_count || 0,
      audio: turn.audio_count || 0,
      image: turn.image_count || 0,
      video: turn.video_count || 0,
      file: turn.file_count || 0
    },
    contextPolicy: turn.context_policy || "current_turn_only",
    textPreview: text.slice(0, 1000),
    captions: (turn.captions || []).map(sanitizeMemoryText).slice(0, 8),
    audioTranscripts: (turn.audio_transcripts || []).map(function (item) {
      return sanitizeMemoryText(item).slice(0, 600);
    }).slice(0, 4),
    media: {
      fileIds: turn.media_batch && turn.media_batch.fileIds || [],
      assetCount: turn.media_batch && turn.media_batch.assetCount || 0,
      failedAssetCount: turn.media_batch && turn.media_batch.failedAssetCount || 0
    }
  });
}

export function buildConversationSummary(conversationLog) {
  const turns = Array.isArray(conversationLog) ? conversationLog : [];
  const recent = turns.slice(-6);
  const keywords = extractKeywords(recent.map(function (turn) {
    return turn.textPreview || "";
  }).join(" "));

  return {
    turn_count: turns.length,
    recent_turn_ids: recent.map(function (turn) { return turn.turnId; }).filter(Boolean),
    input_types_seen: Array.from(new Set(recent.flatMap(function (turn) {
      return turn.inputTypes || [];
    }))),
    last_context_policy: recent.length ? recent[recent.length - 1].contextPolicy : "",
    keywords: keywords,
    summary: buildShortSummary(recent, keywords),
    updated_at: new Date().toISOString()
  };
}

export function buildUserStyleProfile(conversationLog, previousProfile) {
  const turns = Array.isArray(conversationLog) ? conversationLog : [];
  const text = turns.map(function (turn) {
    return [turn.textPreview || ""].concat(turn.audioTranscripts || []).join(" ");
  }).join(" ");
  const lower = text.toLowerCase();
  const questionCount = (text.match(/\?/g) || []).length;
  const words = text.split(/\s+/).filter(Boolean);
  const averageWords = turns.length ? Math.round(words.length / turns.length) : 0;
  const language = detectLanguage(text);
  const tone = lower.match(/\b(por favor|gracias|perfecto|listo|super|súper)\b/)
    ? "friendly"
    : lower.match(/\b(urgente|ya|rapido|rápido)\b/) ? "direct" : "neutral";
  const detailLevel = averageWords > 70 ? "detailed" : averageWords < 20 ? "brief" : "medium";

  return {
    tone: tone,
    language: language,
    detail_level: detailLevel,
    prefers_short_answers: detailLevel === "brief",
    prefers_long_answers: detailLevel === "detailed",
    frequent_vocabulary: extractKeywords(text),
    typical_intent: inferTypicalIntent(lower),
    question_ratio: turns.length ? Number((questionCount / turns.length).toFixed(2)) : 0,
    source: "heuristic_v1",
    updated_at: new Date().toISOString(),
    previous_updated_at: previousProfile && previousProfile.updated_at || ""
  };
}

export function buildCustomerMemory(conversationLog, previousMemory) {
  const turns = Array.isArray(conversationLog) ? conversationLog : [];
  const text = turns.map(function (turn) { return turn.textPreview || ""; }).join(" ");
  const keywords = extractKeywords(text);

  return {
    known_business_terms: keywords.filter(function (word) {
      return !["hazme", "quiero", "necesito", "para", "con"].includes(word);
    }).slice(0, MAX_KEYWORDS),
    preferences: previousMemory && previousMemory.preferences || {},
    open_questions: inferOpenQuestions(text),
    source: "safe_optional_memory_v1",
    updated_at: new Date().toISOString()
  };
}

export function buildUtilityMemory(utilityState) {
  const clean = utilityState && typeof utilityState === "object" ? utilityState : {};
  const reminders = Array.isArray(clean.reminders) ? clean.reminders : [];
  const lists = clean.lists && typeof clean.lists === "object" ? clean.lists : {};

  return {
    reminder_count: reminders.filter(function (item) {
      return !["cancelled", "done"].includes(item.status);
    }).length,
    list_names: Object.values(lists).map(function (list) {
      return list.name || "";
    }).filter(Boolean).slice(0, 20),
    updated_at: new Date().toISOString()
  };
}

export function sanitizeMemoryText(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/\b(?:\+?\d[\s().-]*){8,}\b/g, "[PHONE_REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[SECRET_REDACTED]")
    .slice(0, 4000);
}

function parseBooleanEnv(value, fallback) {
  if (value === true || value === false) return value;
  const clean = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;
  return fallback;
}

function extractKeywords(text) {
  const stopwords = new Set([
    "para", "como", "esta", "este", "esto", "quiero", "necesito", "hazme",
    "hacer", "tengo", "con", "que", "los", "las", "una", "uno", "por",
    "the", "and", "for", "you", "que", "del", "sin", "mas", "más"
  ]);
  const counts = new Map();

  for (const raw of String(text || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9_]{4,}/g) || []) {
    if (stopwords.has(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort(function (a, b) { return b[1] - a[1] || a[0].localeCompare(b[0]); })
    .slice(0, MAX_KEYWORDS)
    .map(function (entry) { return entry[0]; });
}

function buildShortSummary(turns, keywords) {
  if (!turns.length) return "";
  const last = turns[turns.length - 1];
  const pieces = [
    "Recent turns: " + turns.length,
    "last inputs: " + (last.inputTypes || []).join(","),
    keywords.length ? "keywords: " + keywords.slice(0, 6).join(", ") : ""
  ].filter(Boolean);

  return pieces.join(" | ");
}

function detectLanguage(text) {
  const lower = String(text || "").toLowerCase();
  const words = new Set(lower.normalize("NFD").replace(/[\u0300-\u036f]/g, "").match(/[a-z0-9_]+/g) || []);
  const spanishHits = ["quiero", "hazme", "necesito", "imagen", "audio", "publicar", "gracias"].filter(function (word) {
    return words.has(word);
  }).length;
  const englishHits = ["need", "please", "make", "image", "post", "thanks"].filter(function (word) {
    return words.has(word);
  }).length;

  if (spanishHits > englishHits) return "es";
  if (englishHits > spanishHits) return "en";
  return "unknown";
}

function inferTypicalIntent(lowerText) {
  if (lowerText.includes("pedido") || lowerText.includes("orden") || lowerText.includes("comprar")) return "orders";
  if (lowerText.includes("recordar") || lowerText.includes("agenda") || lowerText.includes("seguimiento")) return "reminders_or_follow_up";
  if (lowerText.includes("soporte") || lowerText.includes("problema") || lowerText.includes("ayuda")) return "support";
  if (lowerText.includes("post") || lowerText.includes("copy") || lowerText.includes("imagen") || lowerText.includes("calendario")) return "marketing";
  return "general_whatsapp_assistant";
}

function inferOpenQuestions(text) {
  const questions = String(text || "").split(/\n+/).filter(function (line) {
    return line.includes("?");
  });

  return questions.slice(-5).map(function (line) {
    return sanitizeMemoryText(line).slice(0, 300);
  });
}
