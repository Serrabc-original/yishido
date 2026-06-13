const SECRET_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "WOZTELL_ACCESS_TOKEN",
  "WOZTELL_OPEN_API_TOKEN",
  "GOOGLE_SHEETS_SECRET",
  "authorization",
  "Authorization"
];

const PHONE_KEYS = new Set(["phone", "from", "to", "recipientId", "recipient_id"]);

export function createTraceId(parts) {
  const cleanParts = Array.isArray(parts) ? parts : [parts];
  const seed = cleanParts
    .map(function (part) {
      return String(part || "")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 36);
    })
    .filter(Boolean)
    .join("_");

  return ["trace", Date.now(), seed || randomTraceSuffix()].join("_").slice(0, 120);
}

export function logEvent(event, details, options) {
  const record = buildLogRecord(event, details, options);
  const line = JSON.stringify(record);

  if (record.level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }

  return record;
}

export function captureError(error, details) {
  return logEvent("ERROR_CAPTURED", Object.assign({}, details || {}, {
    errorName: error && error.name || "Error",
    errorMessage: String(error && error.message || error || ""),
    stack: String(error && error.stack || "").slice(0, 2000)
  }), {
    level: "error",
    traceId: details && details.traceId
  });
}

export function buildLogRecord(event, details, options) {
  const cleanOptions = options || {};
  const cleanDetails = redactForLog(details || {});

  return {
    ts: new Date().toISOString(),
    level: cleanOptions.level || "info",
    event: String(event || "EVENT"),
    traceId: cleanOptions.traceId || cleanDetails.traceId || "",
    turnId: cleanOptions.turnId || cleanDetails.turnId || cleanDetails.turn_id || "",
    doName: cleanOptions.doName || cleanDetails.doName || "",
    details: cleanDetails
  };
}

export function redactForLog(value) {
  if (Array.isArray(value)) {
    return value.map(redactForLog);
  }

  if (value && typeof value === "object") {
    const out = {};

    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) {
        out[key] = "[REDACTED]";
      } else if (PHONE_KEYS.has(key)) {
        out[key] = redactPhone(item);
      } else {
        out[key] = redactForLog(item);
      }
    }

    return out;
  }

  if (typeof value === "string") {
    return redactSecretStrings(value);
  }

  return value;
}

export function redactPhone(value) {
  const text = String(value || "");
  const digits = text.replace(/\D/g, "");

  if (digits.length < 6) return text ? "[PHONE_REDACTED]" : "";

  return "[PHONE:" + digits.slice(0, 2) + "***" + digits.slice(-2) + "]";
}

function isSecretKey(key) {
  const clean = String(key || "").toLowerCase();
  return SECRET_KEYS.some(function (secretKey) {
    return clean === String(secretKey).toLowerCase() ||
      clean.includes("api_key") ||
      clean.includes("access_token") ||
      clean.includes("open_api_token") ||
      clean.includes("secret") ||
      clean.includes("authorization");
  });
}

function redactSecretStrings(text) {
  return String(text || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|ANTHROPIC_API_KEY|WOZTELL_ACCESS_TOKEN|WOZTELL_OPEN_API_TOKEN|GOOGLE_SHEETS_SECRET)=\S+/gi, "$1=[REDACTED]");
}

function randomTraceSuffix() {
  return Math.random().toString(36).slice(2, 10);
}
