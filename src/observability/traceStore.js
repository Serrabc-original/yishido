import { redactForLog } from "../logger.js";

const DEFAULT_MAX_TRACE_EVENTS = 160;
const DEFAULT_SNAPSHOT_LIMIT = 20;
const MAX_STRING_LENGTH = 280;
const MAX_DETAILS_JSON_LENGTH = 1400;
const MAX_ARRAY_ITEMS = 20;
const MAX_OBJECT_KEYS = 40;

const RAW_PAYLOAD_KEYS = new Set([
  "payload",
  "rawpayload",
  "raw_payload",
  "headers",
  "authorization",
  "cookie",
  "cookies",
  "body",
  "bytes",
  "buffer",
  "arraybuffer",
  "blob",
  "filecontent",
  "file_content",
  "imagedata",
  "image_data",
  "audiodata",
  "audio_data"
]);

const URL_KEYS = new Set([
  "url",
  "imageurl",
  "image_url",
  "audiourl",
  "audio_url",
  "fileurl",
  "file_url",
  "mediaurl",
  "media_url",
  "downloadurl",
  "download_url"
]);

export function appendTraceEvent(data, event, details, options) {
  const cleanData = data || {};
  const cleanOptions = options || {};
  const maxEvents = normalizePositiveInteger(cleanOptions.maxEvents, DEFAULT_MAX_TRACE_EVENTS);
  const current = normalizeTraceEvents(cleanData.traceEvents || cleanData.trace_events || [], {
    maxEvents: maxEvents
  });
  const nextEvent = buildTraceEvent(event, details, cleanOptions);

  return Object.assign({}, cleanData, {
    traceEvents: current.concat([nextEvent]).slice(-maxEvents)
  });
}

export function buildTraceEvent(event, details, options) {
  const cleanOptions = options || {};
  const safeDetails = compactDetails(redactForLog(details || {}));
  const eventName = normalizeEventName(event);
  const level = normalizeLevel(cleanOptions.level || safeDetails.level || inferLevel(eventName));
  const traceId = String(cleanOptions.traceId || safeDetails.traceId || "");
  const turnId = String(cleanOptions.turnId || safeDetails.turnId || safeDetails.turn_id || "");
  const doName = String(cleanOptions.doName || safeDetails.doName || "");

  return {
    ts: String(cleanOptions.ts || new Date().toISOString()),
    level: level,
    event: eventName,
    traceId: traceId,
    turnId: turnId,
    doName: doName,
    category: categorizeTraceEvent(eventName, level),
    summary: buildTraceSummary(eventName, safeDetails),
    details: safeDetails
  };
}

export function normalizeTraceEvents(events, options) {
  const cleanOptions = options || {};
  const maxEvents = normalizePositiveInteger(cleanOptions.maxEvents, DEFAULT_MAX_TRACE_EVENTS);

  return (Array.isArray(events) ? events : [])
    .map(function (event) {
      return normalizeTraceEvent(event);
    })
    .filter(Boolean)
    .slice(-maxEvents);
}

export function buildTraceSnapshot(data, options) {
  const cleanOptions = options || {};
  const limit = normalizePositiveInteger(cleanOptions.limit, DEFAULT_SNAPSHOT_LIMIT);
  const traceId = String(cleanOptions.traceId || "").trim();
  const turnId = String(cleanOptions.turnId || "").trim();
  const events = normalizeTraceEvents(data && (data.traceEvents || data.trace_events) || []);
  const filtered = events.filter(function (event) {
    if (traceId && event.traceId !== traceId) return false;
    if (turnId && event.turnId !== turnId) return false;
    return true;
  });
  const selected = filtered.slice(-limit);

  return {
    status: "ok",
    totalStored: events.length,
    returned: selected.length,
    traceId: traceId,
    turnId: turnId,
    currentTraceId: String(data && data.currentTraceId || ""),
    currentTurnId: String(data && data.currentTurnId || ""),
    health: summarizeTraceHealth(filtered.length ? filtered : events),
    events: selected
  };
}

export function summarizeTraceHealth(events) {
  const safeEvents = normalizeTraceEvents(events || [], {
    maxEvents: DEFAULT_MAX_TRACE_EVENTS
  });
  const health = {
    status: "ok",
    errors: 0,
    fallbacks: 0,
    openAiFailures: 0,
    woztellFailures: 0,
    imageFailures: 0,
    audioTimeouts: 0,
    turnsDone: 0,
    latestError: null
  };

  for (const event of safeEvents) {
    const name = event.event || "";
    const upper = name.toUpperCase();
    const message = event.summary || name;
    const isError = event.level === "error" || upper.includes("ERROR") || upper.includes("FAILED");

    if (isError) {
      health.errors += 1;
      health.latestError = {
        ts: event.ts,
        event: name,
        traceId: event.traceId,
        turnId: event.turnId,
        message: String(message || "").slice(0, 240)
      };
    }
    if (upper.includes("FALLBACK")) health.fallbacks += 1;
    if (upper.includes("OPENAI") && (upper.includes("FAILED") || upper.includes("ERROR"))) health.openAiFailures += 1;
    if (upper.includes("WOZTELL") && (upper.includes("FAILED") || upper.includes("ERROR"))) health.woztellFailures += 1;
    if (upper.includes("IMAGE") && (upper.includes("FAILED") || upper.includes("ERROR"))) health.imageFailures += 1;
    if (upper.includes("AUDIO_TIMEOUT") || upper.includes("TURN_AUDIO_TIMEOUT")) health.audioTimeouts += 1;
    if (upper === "TURN_PROCESSING_DONE" || upper === "USER_RESPONSE_SENT") health.turnsDone += 1;
  }

  if (health.errors || health.fallbacks || health.audioTimeouts || health.imageFailures) {
    health.status = "needs_review";
  }

  return health;
}

export function buildProductHealthSnapshot(data, env) {
  const clean = data || {};
  const traceSnapshot = buildTraceSnapshot(clean, { limit: 8 });
  const coreUtilityState = clean.coreUtilityState || {};
  const campaignState = clean.campaignState || {};
  const memoryPolicy = clean.memoryPolicy || {};
  const longTerm = memoryPolicy.longTerm || {};
  const pendingMessages = Array.isArray(clean.pendingMessages) ? clean.pendingMessages : [];
  const recentMediaAssets = Array.isArray(clean.recentMediaAssets) ? clean.recentMediaAssets : [];
  const campaignAssets = Array.isArray(campaignState.campaign_assets) ? campaignState.campaign_assets : [];

  return {
    status: traceSnapshot.health.status,
    version: "whatsapp-ai-agent-core-v3",
    buildLabel: String(env && env.BUILD_LABEL || ""),
    processing: Boolean(clean.processing),
    pendingMessages: pendingMessages.length,
    hasMedia: Boolean(clean.hasMedia),
    currentTraceId: String(clean.currentTraceId || ""),
    currentTurnId: String(clean.currentTurnId || ""),
    recentMediaAssets: recentMediaAssets.length,
    campaignAssets: campaignAssets.length,
    shortTermTurns: Array.isArray(clean.conversationLog) ? clean.conversationLog.length : 0,
    longTermMemory: longTerm.enabled ? longTerm.mode || "enabled" : "disabled",
    lists: countObjectKeys(coreUtilityState.lists || coreUtilityState.listsState && coreUtilityState.listsState.lists),
    reminders: Array.isArray(coreUtilityState.reminders) ? coreUtilityState.reminders.length : 0,
    tasks: Array.isArray(coreUtilityState.tasks) ? coreUtilityState.tasks.length : 0,
    trace: traceSnapshot
  };
}

export function formatTraceSnapshotForWhatsApp(snapshot) {
  const clean = snapshot || {};
  const health = clean.health || {};
  const events = Array.isArray(clean.events) ? clean.events : [];
  const lines = [
    "Debug logs de esta conversacion",
    "estado: " + String(health.status || "ok"),
    "eventos guardados: " + String(clean.totalStored || 0),
    "errores: " + String(health.errors || 0) + " | fallbacks: " + String(health.fallbacks || 0),
    "trace actual: " + shortId(clean.currentTraceId || clean.traceId || "")
  ];

  if (!events.length) {
    lines.push("Sin eventos guardados todavia.");
    return lines.join("\n");
  }

  lines.push("ultimos eventos:");
  for (const event of events) {
    lines.push(formatTraceLine(event));
  }

  return lines.join("\n");
}

export function formatProductHealthForWhatsApp(snapshot) {
  const clean = snapshot || {};
  const traceHealth = clean.trace && clean.trace.health || {};
  const lines = [
    "Estado del asistente",
    "estado: " + String(clean.status || "ok"),
    "procesando: " + yesNo(clean.processing),
    "mensajes pendientes: " + String(clean.pendingMessages || 0),
    "trace actual: " + shortId(clean.currentTraceId || ""),
    "errores recientes: " + String(traceHealth.errors || 0),
    "fallbacks recientes: " + String(traceHealth.fallbacks || 0),
    "media reciente: " + String(clean.recentMediaAssets || 0),
    "assets de campana: " + String(clean.campaignAssets || 0),
    "memoria corta: " + String(clean.shortTermTurns || 0) + " turnos",
    "memoria larga: " + String(clean.longTermMemory || "disabled"),
    "listas: " + String(clean.lists || 0) + " | recordatorios: " + String(clean.reminders || 0) + " | tareas: " + String(clean.tasks || 0)
  ];

  if (traceHealth.latestError) {
    lines.push("ultimo error: " + traceHealth.latestError.event + " " + shortId(traceHealth.latestError.traceId || ""));
  }

  return lines.join("\n");
}

function normalizeTraceEvent(event) {
  if (!event || typeof event !== "object") return null;
  const safeDetails = compactDetails(redactForLog(event.details || {}));
  const eventName = normalizeEventName(event.event || safeDetails.event || "");
  if (!eventName) return null;
  const level = normalizeLevel(event.level || safeDetails.level || inferLevel(eventName));

  return {
    ts: String(event.ts || event.timestamp || new Date().toISOString()),
    level: level,
    event: eventName,
    traceId: String(event.traceId || safeDetails.traceId || ""),
    turnId: String(event.turnId || safeDetails.turnId || safeDetails.turn_id || ""),
    doName: String(event.doName || safeDetails.doName || ""),
    category: String(event.category || categorizeTraceEvent(eventName, level)),
    summary: String(event.summary || buildTraceSummary(eventName, safeDetails)).slice(0, 240),
    details: safeDetails
  };
}

function compactDetails(details) {
  const compacted = sanitizeValue(details, "", 0);
  const json = safeStringify(compacted);

  if (json.length <= MAX_DETAILS_JSON_LENGTH) return compacted;

  return {
    preview: json.slice(0, MAX_DETAILS_JSON_LENGTH),
    truncated: true
  };
}

function sanitizeValue(value, key, depth) {
  const cleanKey = String(key || "").replace(/[^a-zA-Z0-9_]/g, "").toLowerCase();

  if (isSecretLikeKey(cleanKey)) return "[REDACTED]";
  if (RAW_PAYLOAD_KEYS.has(cleanKey)) return "[OMITTED_RAW_PAYLOAD]";

  if (value === null || value === undefined) return value;
  if (depth > 4) return "[MAX_DEPTH]";

  if (typeof value === "string") {
    if (URL_KEYS.has(cleanKey) || looksLikeUrl(value)) {
      return previewUrl(value);
    }
    return truncateString(replaceUrlSubstrings(value), MAX_STRING_LENGTH);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY_ITEMS).map(function (item) {
      return sanitizeValue(item, key, depth + 1);
    });
    if (value.length > MAX_ARRAY_ITEMS) {
      out.push({ truncatedItems: value.length - MAX_ARRAY_ITEMS });
    }
    return out;
  }

  if (typeof value === "object") {
    const out = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [entryKey, item] of entries) {
      out[entryKey] = sanitizeValue(item, entryKey, depth + 1);
    }
    if (Object.keys(value).length > MAX_OBJECT_KEYS) {
      out.truncatedKeys = Object.keys(value).length - MAX_OBJECT_KEYS;
    }
    return out;
  }

  return String(value);
}

function buildTraceSummary(eventName, details) {
  const parts = [];
  const keys = [
    "reason",
    "intent",
    "routeIntent",
    "targetModule",
    "messageCount",
    "pendingCount",
    "assetCount",
    "failedAssetCount",
    "contextPolicy",
    "status",
    "mode"
  ];

  for (const key of keys) {
    const value = details && details[key];
    if (value !== undefined && value !== null && value !== "") {
      parts.push(key + "=" + shortValue(value));
    }
  }

  if (!parts.length && details && details.errorMessage) {
    parts.push("error=" + shortValue(details.errorMessage));
  }

  if (!parts.length) return eventName;

  return parts.join(" ").slice(0, 240);
}

function categorizeTraceEvent(eventName, level) {
  const upper = String(eventName || "").toUpperCase();

  if (level === "error" || upper.includes("ERROR") || upper.includes("FAILED")) return "error";
  if (upper.includes("DEDUP")) return "dedupe";
  if (upper.includes("MEDIA") || upper.includes("IMAGE") || upper.includes("AUDIO")) return "media";
  if (upper.includes("MEMORY")) return "memory";
  if (upper.includes("INTENT") || upper.includes("PLAN") || upper.includes("ROUT")) return "routing";
  if (upper.includes("SEND") || upper.includes("RESPONSE") || upper.includes("DONE")) return "response";
  if (upper.includes("TURN") || upper.includes("WEBHOOK") || upper.includes("INBOUND")) return "turn";

  return "system";
}

function inferLevel(eventName) {
  const upper = String(eventName || "").toUpperCase();
  return upper.includes("ERROR") || upper.includes("FAILED") ? "error" : "info";
}

function normalizeLevel(value) {
  const clean = String(value || "info").toLowerCase();
  return clean === "error" || clean === "warn" || clean === "debug" ? clean : "info";
}

function normalizeEventName(value) {
  return String(value || "EVENT")
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 80);
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function countObjectKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).length : 0;
}

function isSecretLikeKey(key) {
  return key.includes("token") ||
    key.includes("secret") ||
    key.includes("apikey") ||
    key.includes("api_key") ||
    key.includes("authorization");
}

function looksLikeUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function replaceUrlSubstrings(value) {
  return String(value || "").replace(/https?:\/\/[^\s)]+/gi, function (match) {
    return previewUrl(match);
  });
}

function previewUrl(value) {
  const text = String(value || "");
  try {
    const parsed = new URL(text);
    return "[URL:" + parsed.hostname + " path=" + truncateString(parsed.pathname || "/", 48) + " len=" + text.length + "]";
  } catch (error) {
    return "[URL len=" + text.length + "]";
  }
}

function truncateString(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 14) + "...[truncated]";
}

function shortValue(value) {
  if (typeof value === "string") return truncateString(value, 64);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return truncateString(safeStringify(value), 64);
}

function shortId(value) {
  const text = String(value || "");
  if (!text) return "n/a";
  if (text.length <= 18) return text;
  return text.slice(0, 8) + "..." + text.slice(-6);
}

function formatTraceLine(event) {
  const timestamp = formatTime(event.ts);
  const level = event.level === "error" ? "ERR" : event.level === "warn" ? "WARN" : "OK";
  const trace = event.traceId ? " " + shortId(event.traceId) : "";
  const summary = event.summary && event.summary !== event.event ? " - " + event.summary : "";

  return "- " + timestamp + " " + level + " " + event.event + trace + summary;
}

function formatTime(value) {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return "sin-hora";
  return date.toISOString().slice(11, 19);
}

function yesNo(value) {
  return value ? "si" : "no";
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value || "");
  }
}
