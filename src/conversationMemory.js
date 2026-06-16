import { redactForLog } from "./logger.js";

const MAX_CONVERSATION_LOG = 20;
const MAX_KEYWORDS = 12;
const MAX_IMPORTANT_FACTS = 20;

export function getCoreFeatureFlags(env) {
  return {
    debugLogs: parseBooleanEnv(env && env.DEBUG_LOGS, true),
    saveConversationLogs: parseBooleanEnv(env && env.SAVE_CONVERSATION_LOGS, true),
    enableUserStyleProfile: parseBooleanEnv(env && env.ENABLE_USER_STYLE_PROFILE, true),
    enableCustomerMemory: parseBooleanEnv(env && env.ENABLE_CUSTOMER_MEMORY, true),
    enableReminders: parseBooleanEnv(env && env.ENABLE_REMINDERS, true),
    enableLists: parseBooleanEnv(env && env.ENABLE_LISTS, true),
    enableWhatsAppInteractive: parseBooleanEnv(env && env.ENABLE_WHATSAPP_INTERACTIVE, true),
    enableTemplateModule: parseBooleanEnv(env && env.ENABLE_TEMPLATE_MODULE, true),
    coreUtilitiesSandbox: parseBooleanEnv(env && env.CORE_UTILITIES_SANDBOX, true),
    remindersDeliveryMode: normalizeMode(env && env.REMINDERS_DELIVERY_MODE, "mock"),
    interactiveDeliveryMode: normalizeMode(env && env.INTERACTIVE_DELIVERY_MODE, "safe"),
    memoryRetentionMode: normalizeMode(env && env.MEMORY_RETENTION_MODE, "summarized"),
    logCaptureMode: normalizeMode(env && env.LOG_CAPTURE_MODE, "console_and_file")
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
    flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-MAX_CONVERSATION_LOG)
  );
  next.utilityMemory = buildUtilityMemory(options && options.utilityState || next.coreUtilityState || {});

  if (flags.enableUserStyleProfile) {
    next.userStyleProfile = buildUserStyleProfile(
      flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-MAX_CONVERSATION_LOG),
      next.userStyleProfile
    );
  }

  if (flags.enableCustomerMemory) {
    next.customerMemory = buildCustomerMemory(
      flags.saveConversationLogs ? next.conversationLog : previousLog.concat([safeTurn]).slice(-MAX_CONVERSATION_LOG),
      next.customerMemory,
      userTurn
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
  const recent = turns.slice(-MAX_CONVERSATION_LOG);
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

export function buildCustomerMemory(conversationLog, previousMemory, userTurn) {
  const turns = Array.isArray(conversationLog) ? conversationLog : [];
  const text = turns.map(function (turn) { return turn.textPreview || ""; }).join(" ");
  const keywords = extractKeywords(text);
  const previous = previousMemory && typeof previousMemory === "object" ? previousMemory : {};
  const name = extractUserName(text) || previous.name || "";
  const responsePreference = extractResponsePreference(text) || previous.response_preference || "";
  const importantFacts = mergeImportantFacts(previous.important_facts || previous.importantFacts || [], extractImportantFactsFromTurn(userTurn));
  const lastAudioSummary = extractLatestAudioSummary(turns) || previous.last_audio_summary || "";

  return {
    name: name,
    language: detectLanguage(text) !== "unknown" ? detectLanguage(text) : previous.language || "unknown",
    response_preference: responsePreference,
    shopping_preferences: previous.shopping_preferences || {},
    lists_note: previous.lists_note || "",
    reminders_note: previous.reminders_note || "",
    useful_notes: previous.useful_notes || [],
    style_preference: responsePreference || previous.style_preference || "",
    known_business_terms: keywords.filter(function (word) {
      return !["hazme", "quiero", "necesito", "para", "con"].includes(word);
    }).slice(0, MAX_KEYWORDS),
    preferences: previous.preferences || {},
    important_facts: importantFacts,
    compact_data_memory: importantFacts.map(function (fact) {
      return fact.label + ": " + fact.value;
    }).slice(-MAX_IMPORTANT_FACTS),
    last_audio_summary: lastAudioSummary,
    open_questions: inferOpenQuestions(text),
    source: "safe_optional_memory_v2",
    updated_at: new Date().toISOString()
  };
}

function extractLatestAudioSummary(turns) {
  const entries = Array.isArray(turns) ? turns.slice().reverse() : [];
  for (const turn of entries) {
    const transcripts = Array.isArray(turn && turn.audioTranscripts) ? turn.audioTranscripts : [];
    const text = transcripts.map(String).join(" ").replace(/\s+/g, " ").trim();
    if (text) return summarizeAudioForMemory(text);
  }
  return "";
}

function summarizeAudioForMemory(text) {
  const clean = sanitizeFactText(text);
  const action = clean.match(/\b(llamar|comprar|pagar|hacer|enviar|revisar|mandar|escribir|actualizar)\b[^.?!]{0,180}/i);
  const reminder = clean.match(/\b(recordatorio|recuerdame|hazme acuerdo|avisame)\b[^.?!]{0,220}/i);
  const picked = action && action[0] || reminder && reminder[0] || clean;
  return picked.replace(/\s+/g, " ").slice(0, 240);
}

export function extractImportantFactsFromTurn(userTurn) {
  const turn = userTurn || {};
  const sources = [];
  if (turn.current_turn_text) sources.push({ source: "text", text: turn.current_turn_text });
  for (const transcript of turn.audio_transcripts || []) {
    if (transcript) sources.push({ source: "audio", text: transcript });
  }
  for (const caption of turn.captions || []) {
    if (caption) sources.push({ source: "image_caption", text: caption });
  }
  const facts = [];
  for (const item of sources) {
    facts.push.apply(facts, extractImportantFactsFromText(item.text, {
      source: item.source,
      turnId: turn.turn_id || "",
      traceId: turn.trace_id || ""
    }));
  }
  return facts;
}

function mergeImportantFacts(previousFacts, newFacts) {
  const merged = [];
  const seen = new Set();
  const source = []
    .concat(Array.isArray(previousFacts) ? previousFacts : [])
    .concat(Array.isArray(newFacts) ? newFacts : []);

  for (const raw of source) {
    const fact = normalizeImportantFact(raw);
    if (!fact) continue;
    const key = fact.label.toLowerCase() + ":" + fact.value.toLowerCase();
    if (seen.has(key)) {
      const existing = merged.find(function (item) {
        return item.label.toLowerCase() + ":" + item.value.toLowerCase() === key;
      });
      if (existing) existing.updated_at = fact.updated_at;
      continue;
    }
    seen.add(key);
    merged.push(fact);
  }

  return merged.slice(-MAX_IMPORTANT_FACTS);
}

function normalizeImportantFact(raw) {
  const label = String(raw && (raw.label || raw.type) || "").trim();
  const value = sanitizeFactText(raw && raw.value || "").trim();
  if (!label || !value) return null;
  return {
    label: label.slice(0, 60),
    value: value.slice(0, 240),
    source: String(raw.source || "text").slice(0, 40),
    turn_id: String(raw.turn_id || raw.turnId || "").slice(0, 80),
    trace_id: String(raw.trace_id || raw.traceId || "").slice(0, 80),
    updated_at: String(raw.updated_at || raw.updatedAt || new Date().toISOString())
  };
}

function extractImportantFactsFromText(text, meta) {
  const raw = String(text || "");
  const clean = sanitizeFactText(raw);
  const facts = [];
  const lower = normalizeForFactMatch(clean);
  const base = {
    source: meta && meta.source || "text",
    turn_id: meta && meta.turnId || "",
    trace_id: meta && meta.traceId || "",
    updated_at: new Date().toISOString()
  };

  addMatches(facts, clean, /\b(?:cedula|c[eé]dula|dni|documento)\s*(?:numero|n[uú]mero|#|:)?\s*([0-9][0-9.\-\s]{5,18}[0-9])\b/gi, "cedula", base);
  addMatches(facts, clean, /\b([0-9]{8,13})\b/g, "numero_identificacion", base);
  addMatches(facts, clean, /([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/gi, "email", base);
  addMatches(facts, clean, /\b(?:edad|tiene)\s*(?:de\s*)?(\d{1,3})\s*a[nñ]os\b/gi, "edad", base);
  addMatches(facts, clean, /\b(\d{1,3})\s*a[nñ]os\b/gi, "edad", base);
  addMatches(facts, clean, /\b(?:plan|paquete)\s*(?:de\s*)?(\$?\s*\d+(?:[.,]\d{1,2})?\s*(?:d[oó]lares|usd)?)\b/gi, "plan", base);
  addMatches(facts, clean, /\b(?:se llama|cliente|datos de|los de)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){1,3})\b/g, "nombre_cliente", base);

  const platforms = ["google maps", "instagram", "facebook", "whatsapp", "tiktok", "messenger"];
  const foundPlatforms = platforms.filter(function (platform) { return lower.includes(platform); });
  if (foundPlatforms.length) {
    facts.push(Object.assign({}, base, {
      label: "canales_o_plataformas",
      value: foundPlatforms.join(", ")
    }));
  }

  if (/\b(actualizar|guardar|verificar|datos|cliente|lista)\b/i.test(clean) && clean.length >= 12) {
    facts.push(Object.assign({}, base, {
      label: "nota_contexto",
      value: clean.replace(/\s+/g, " ").slice(0, 240)
    }));
  }

  return facts;
}

function addMatches(facts, text, pattern, label, base) {
  let match;
  while ((match = pattern.exec(text))) {
    const value = sanitizeFactText(match[1] || "").trim();
    if (!value) continue;
    facts.push(Object.assign({}, base, {
      label: label,
      value: value
    }));
  }
}

function sanitizeFactText(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[SECRET_REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}

function normalizeForFactMatch(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function buildUtilityMemory(utilityState) {
  const clean = utilityState && typeof utilityState === "object" ? utilityState : {};
  const reminders = Array.isArray(clean.reminders) ? clean.reminders : [];
  const lists = clean.lists && typeof clean.lists === "object" ? clean.lists : {};
  const tasks = Array.isArray(clean.tasks) ? clean.tasks : [];
  const leads = Array.isArray(clean.leads) ? clean.leads : [];
  const clients = Array.isArray(clean.clients) ? clean.clients : [];

  return {
    reminder_count: reminders.filter(function (item) {
      return !["cancelled", "done"].includes(item.status);
    }).length,
    open_task_count: tasks.filter(function (item) { return item.status === "open"; }).length,
    paused_task_count: tasks.filter(function (item) { return item.status === "paused"; }).length,
    lead_count: leads.length,
    client_count: clients.length,
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

function normalizeMode(value, fallback) {
  const clean = String(value || "").trim().toLowerCase();
  return clean || fallback;
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

function extractUserName(text) {
  const match = String(text || "").match(/\b(?:me llamo|mi nombre es|llamame)\s+([A-Za-zÁÉÍÓÚÜÑáéíóúüñ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ\s.'-]{0,60})/i);
  if (!match) return "";
  return sanitizeMemoryText(match[1])
    .replace(/[.!,;:].*$/, "")
    .trim()
    .slice(0, 80);
}

function extractResponsePreference(text) {
  const match = String(text || "").match(/\bprefiero que respondas\s+([^.\n]{3,180})/i);
  return match ? sanitizeMemoryText(match[1]).trim().slice(0, 180) : "";
}
