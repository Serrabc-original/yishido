import { logEvent } from "../logger.js";

const STATUS_TYPES = new Set(["SENT", "DELIVERED", "READ", "DELIVERY", "ECHO"]);
const SUPPORTED_TYPES = new Set(["TEXT", "IMAGE", "AUDIO", "VIDEO", "FILE", "LOCATION"]);
const AUDIO_TYPES = new Set(["AUDIO", "VOICE", "PTT"]);
const WHATSAPP_UNSUPPORTED_CODES = new Set(["131051"]);

export function normalizeInboundEvent(payload, options) {
  const body = payload || {};
  const data = body.data || {};
  const rawType = String(body.type || data.type || "").trim();
  const type = normalizeEventType(rawType, body);
  const messageId = String(body.messageId || data.messageId || body.id || data.id || "").trim();
  const fileId = extractFileId(body);
  const text = extractText(body);
  const caption = extractCaption(body);
  const eventId = String(body.eventId || body._id || messageId || fileId || "").trim();
  const status = String(body.status || data.status || data.statuses && data.statuses[0] && data.statuses[0].status || "").toUpperCase();
  const errorCode = String(
    body.errorCode ||
    data.errorCode ||
    body.code ||
    data.code ||
    body.error && body.error.code ||
    data.error && data.error.code ||
    data.errors && data.errors[0] && data.errors[0].code ||
    ""
  ).trim();
  const isStatusEvent = STATUS_TYPES.has(rawType.toUpperCase()) || STATUS_TYPES.has(status);
  const isUnsupported = !isStatusEvent && (
    !type ||
    type === "UNSUPPORTED" ||
    WHATSAPP_UNSUPPORTED_CODES.has(errorCode) ||
    WHATSAPP_UNSUPPORTED_CODES.has(String(data.errors && data.errors[0] && data.errors[0].error_code || ""))
  );

  const event = {
    eventId: eventId || messageId || randomEventId(),
    messageId: messageId || eventId || fileId || randomEventId(),
    type: isUnsupported ? "UNSUPPORTED" : type,
    text: isUnsupported || isStatusEvent ? "" : text,
    caption: isUnsupported || isStatusEvent ? "" : caption,
    fileId: fileId,
    timestamp: Number(body.timestamp || data.timestamp || Date.now()),
    channelId: String(body.channel || body.channelId || data.channel || data.channelId || ""),
    memberId: String(body.member || body.memberId || data.member || data.memberId || ""),
    appId: String(body.app || body.appId || data.app || data.appId || ""),
    from: String(body.from || data.from || ""),
    rawType: rawType,
    isStatusEvent: isStatusEvent,
    isUnsupported: Boolean(isUnsupported),
    errorCode: errorCode,
    source: options && options.source || "woztell"
  };

  logEvent("INBOUND_EVENT_NORMALIZED", {
    traceId: options && options.traceId || "",
    eventId: event.eventId,
    messageId: event.messageId,
    type: event.type,
    rawType: event.rawType,
    hasText: Boolean(event.text),
    hasCaption: Boolean(event.caption),
    hasFileId: Boolean(event.fileId),
    isStatusEvent: event.isStatusEvent,
    isUnsupported: event.isUnsupported,
    errorCode: event.errorCode
  });

  return event;
}

export function shouldIgnoreInboundEvent(event, seenMessageIds, options) {
  const clean = event || {};
  const traceId = options && options.traceId || "";
  const seen = seenMessageIds instanceof Set ? seenMessageIds : new Set(seenMessageIds || []);

  if (clean.isStatusEvent) {
    logEvent("INBOUND_EVENT_IGNORED_STATUS", {
      traceId: traceId,
      messageId: clean.messageId || "",
      rawType: clean.rawType || "",
      type: clean.type || ""
    });
    return { ignore: true, reason: "status_event" };
  }

  if (clean.isUnsupported || clean.type === "UNSUPPORTED") {
    logEvent("INBOUND_EVENT_IGNORED_UNSUPPORTED", {
      traceId: traceId,
      messageId: clean.messageId || "",
      rawType: clean.rawType || "",
      errorCode: clean.errorCode || ""
    });
    return { ignore: true, reason: "unsupported_event" };
  }

  if (clean.messageId && seen.has(clean.messageId)) {
    logEvent("INBOUND_EVENT_DEDUPED", {
      traceId: traceId,
      messageId: clean.messageId,
      type: clean.type || ""
    });
    return { ignore: true, reason: "duplicate_message_id" };
  }

  logEvent("INBOUND_EVENT_ACCEPTED", {
    traceId: traceId,
    messageId: clean.messageId || "",
    type: clean.type || "",
    fileId: clean.fileId || ""
  });
  return { ignore: false, reason: "accepted" };
}

export function normalizeEventType(rawType, payload) {
  const body = payload || {};
  const data = body.data || {};
  const type = String(rawType || "").trim().toUpperCase();
  const mimeType = String(body.mimeType || data.mimeType || body.file && body.file.mimeType || data.file && data.file.mimeType || "").toLowerCase();

  if (STATUS_TYPES.has(type)) return type;
  if (AUDIO_TYPES.has(type)) return "AUDIO";
  if (SUPPORTED_TYPES.has(type)) return type;
  if (!type && mimeType.startsWith("image/")) return "IMAGE";
  if (!type && mimeType.startsWith("audio/")) return "AUDIO";
  if (!type && mimeType.startsWith("video/")) return "VIDEO";
  if (!type && extractFileId(body)) return "FILE";
  if (!type && extractText(body)) return "TEXT";
  return type ? "UNSUPPORTED" : "";
}

function extractText(body) {
  const data = body.data || {};
  return String(data.text || body.text || "").trim();
}

function extractCaption(body) {
  const data = body.data || {};
  const media = firstMediaLike(body);
  return String(data.caption || body.caption || media.caption || media.text || "").trim();
}

function extractFileId(body) {
  const data = body.data || {};
  const media = firstMediaLike(body);
  return String(
    data.fileId ||
    body.fileId ||
    data.mediaId ||
    body.mediaId ||
    media.fileId ||
    media.file_id ||
    media.mediaId ||
    media.id ||
    data.file && data.file.fileId ||
    body.file && body.file.fileId ||
    data.attachment && data.attachment.fileId ||
    body.attachment && body.attachment.fileId ||
    data.audio && data.audio.fileId ||
    body.audio && body.audio.fileId ||
    data.voice && data.voice.fileId ||
    body.voice && body.voice.fileId ||
    ""
  ).trim();
}

function firstMediaLike(body) {
  const data = body.data || {};
  return []
    .concat(Array.isArray(body.media) ? body.media : [])
    .concat(Array.isArray(data.media) ? data.media : [])
    .concat(Array.isArray(body.attachments) ? body.attachments : [])
    .concat(Array.isArray(data.attachments) ? data.attachments : [])
    .concat(body.attachment || [])
    .concat(data.attachment || [])
    .find(Boolean) || {};
}

function randomEventId() {
  return "evt_" + Math.random().toString(36).slice(2, 12);
}

