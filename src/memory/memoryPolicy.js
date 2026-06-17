const DEFAULT_SHORT_TERM_LIMIT = 20;
const MAX_SHORT_TERM_LIMIT = 20;

export function buildMemoryPolicy(env, data, options) {
  const cleanEnv = env || {};
  const cleanData = data || {};
  const cleanOptions = options || {};
  const retentionMode = normalizeRetentionMode(cleanOptions.retentionMode || cleanEnv.MEMORY_RETENTION_MODE || "summarized");
  const shortTermLimit = clampNumber(
    cleanOptions.shortTermLimit || cleanEnv.SHORT_TERM_MEMORY_TURNS || DEFAULT_SHORT_TERM_LIMIT,
    1,
    MAX_SHORT_TERM_LIMIT,
    DEFAULT_SHORT_TERM_LIMIT
  );
  const rawLongTermMode = cleanOptions.longTermMode || cleanEnv.LONG_TERM_MEMORY_MODE || "";
  const normalizedLongTermMode = normalizeLongTermMode(rawLongTermMode);
  const longTermExplicitlyEnabled = parseBoolean(cleanOptions.enableLongTermMemory, parseBoolean(cleanEnv.ENABLE_LONG_TERM_MEMORY, false));
  const longTermMode = longTermExplicitlyEnabled && !rawLongTermMode ? "kv" : normalizedLongTermMode;
  const longTermEnabled = longTermExplicitlyEnabled || longTermMode !== "disabled";
  const requiresConsent = parseBoolean(
    cleanOptions.longTermRequiresConsent,
    parseBoolean(cleanEnv.LONG_TERM_MEMORY_REQUIRES_CONSENT, true)
  );
  const consent = normalizeMemoryConsent(cleanData.memoryConsent || cleanData.memory_consent || {});
  const hasConsent = consent.longTerm.status === "granted";
  const readAllowed = longTermEnabled && (!requiresConsent || hasConsent);

  return {
    version: "memory_policy_v1",
    shortTerm: {
      enabled: true,
      scope: "conversation",
      maxTurns: shortTermLimit,
      retentionMode: retentionMode,
      rawHistoryAllowed: false
    },
    longTerm: {
      enabled: Boolean(longTermEnabled),
      mode: longTermEnabled ? longTermMode || "kv" : "disabled",
      scope: "user_conversation",
      binding: String(cleanOptions.longTermBinding || cleanEnv.LONG_TERM_MEMORY_KV_BINDING || "SESSIONS_KV"),
      namespace: String(cleanOptions.longTermNamespace || cleanEnv.LONG_TERM_MEMORY_NAMESPACE || "ltm"),
      requiresConsent: requiresConsent,
      consentStatus: consent.longTerm.status,
      readAllowed: readAllowed,
      writeAllowed: readAllowed,
      rawHistoryAllowed: false,
      sensitiveDataAllowed: false
    },
    consent: consent,
    source: "worker_memory_policy"
  };
}

export function normalizeMemoryConsent(consent) {
  const clean = consent && typeof consent === "object" ? consent : {};
  const longTerm = clean.longTerm || clean.long_term || {};
  const rawStatus = String(longTerm.status || clean.status || "").toLowerCase();
  const status = ["granted", "revoked", "not_requested"].includes(rawStatus) ? rawStatus : "not_requested";

  return {
    longTerm: {
      status: status,
      grantedAt: String(longTerm.grantedAt || longTerm.granted_at || clean.grantedAt || clean.granted_at || ""),
      revokedAt: String(longTerm.revokedAt || longTerm.revoked_at || clean.revokedAt || clean.revoked_at || ""),
      source: String(longTerm.source || clean.source || "").slice(0, 80)
    },
    updatedAt: String(clean.updatedAt || clean.updated_at || "")
  };
}

export function grantLongTermMemoryConsent(data, options) {
  const next = Object.assign({}, data || {});
  const now = String(options && options.now || new Date().toISOString());
  const source = String(options && options.source || "user_command").slice(0, 80);

  next.memoryConsent = {
    longTerm: {
      status: "granted",
      grantedAt: now,
      revokedAt: "",
      source: source
    },
    updatedAt: now
  };

  return next;
}

export function revokeLongTermMemoryConsent(data, options) {
  const next = Object.assign({}, data || {});
  const previous = normalizeMemoryConsent(next.memoryConsent || {});
  const now = String(options && options.now || new Date().toISOString());
  const source = String(options && options.source || "user_command").slice(0, 80);

  next.memoryConsent = {
    longTerm: {
      status: "revoked",
      grantedAt: previous.longTerm.grantedAt || "",
      revokedAt: now,
      source: source
    },
    updatedAt: now
  };
  next.longTermMemory = null;

  return next;
}

export function summarizeMemoryPolicy(policy) {
  const clean = policy || {};
  const shortTerm = clean.shortTerm || {};
  const longTerm = clean.longTerm || {};

  return {
    shortTermEnabled: Boolean(shortTerm.enabled),
    shortTermMaxTurns: Number(shortTerm.maxTurns || 0),
    shortTermRetentionMode: shortTerm.retentionMode || "",
    longTermEnabled: Boolean(longTerm.enabled),
    longTermMode: longTerm.mode || "disabled",
    longTermConsentStatus: longTerm.consentStatus || "not_requested",
    longTermReadAllowed: Boolean(longTerm.readAllowed),
    longTermWriteAllowed: Boolean(longTerm.writeAllowed),
    rawHistoryAllowed: Boolean(shortTerm.rawHistoryAllowed || longTerm.rawHistoryAllowed)
  };
}

export function shouldReadLongTermMemory(policy) {
  const longTerm = policy && policy.longTerm || {};
  return Boolean(longTerm.enabled && longTerm.readAllowed);
}

export function shouldWriteLongTermMemory(policy) {
  const longTerm = policy && policy.longTerm || {};
  return Boolean(longTerm.enabled && longTerm.writeAllowed);
}

function parseBoolean(value, fallback) {
  if (value === true || value === false) return value;
  const clean = String(value || "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(clean)) return true;
  if (["false", "0", "no", "off"].includes(clean)) return false;
  return fallback;
}

function normalizeRetentionMode(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (["summarized", "compact", "minimal"].includes(clean)) return clean;
  if (clean === "raw") return "summarized";
  return "summarized";
}

function normalizeLongTermMode(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return "disabled";
  if (["kv", "sessions_kv", "cloudflare_kv"].includes(clean)) return "kv";
  if (["false", "off", "none", "noop", "disabled"].includes(clean)) return "disabled";
  return clean;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}
