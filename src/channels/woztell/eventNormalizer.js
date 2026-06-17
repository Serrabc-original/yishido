import {
  normalizeInboundEvent,
  normalizeEventType,
  shouldIgnoreInboundEvent
} from "../../conversation/inboundEventCollector.js";

export {
  normalizeInboundEvent,
  normalizeEventType,
  shouldIgnoreInboundEvent
};

export function normalizeWoztellInboundEvent(payload, options) {
  return normalizeInboundEvent(payload, Object.assign({ source: "woztell" }, options || {}));
}

export function shouldIgnoreWoztellInboundEvent(event, seenMessageIds, options) {
  return shouldIgnoreInboundEvent(event, seenMessageIds, options);
}

export function extractWoztellMessage(body) {
  const payload = body || {};
  const event = normalizeWoztellInboundEvent(payload);
  const data = payload.data || {};
  const type = event.type || normalizeEventType(payload.type || data.type || "", payload) || "UNSUPPORTED";
  const text = event.text || event.caption || "";
  const fileId = data.fileId ||
    payload.fileId ||
    data.mediaId ||
    payload.mediaId ||
    data.file && data.file.fileId ||
    payload.file && payload.file.fileId ||
    data.attachment && data.attachment.fileId ||
    payload.attachment && payload.attachment.fileId ||
    data.audio && data.audio.fileId ||
    payload.audio && payload.audio.fileId ||
    data.voice && data.voice.fileId ||
    payload.voice && payload.voice.fileId ||
    "";

  return {
    type: type,
    text: String(text || "").trim(),
    fileId: String(fileId || ""),
    caption: event.caption || "",
    media: Array.isArray(payload.media) ? payload.media : Array.isArray(data.media) ? data.media : [],
    fileName: data.fileName || payload.fileName || data.file && data.file.fileName || payload.file && payload.file.fileName || "",
    mimeType: data.mimeType || payload.mimeType || data.file && data.file.mimeType || payload.file && payload.file.mimeType || data.audio && data.audio.mimeType || payload.audio && payload.audio.mimeType || "",
    messageId: payload.messageId || data.messageId || ""
  };
}

export function normalizeIncomingMessage(parsedMessage, woztellPayload, options) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const type = String(parsed.type || normalizeEventType(payload.type || payload.data && payload.data.type || "", payload) || "UNSUPPORTED").toUpperCase();
  const fileId = String(parsed.fileId || "");
  const quoted = extractQuotedMessageReference(parsed, payload);
  const media = extractMediaFromPayload(parsed, payload);
  const audio = isAudioMessage(parsed) && fileId ? [{
    type: type,
    fileId: fileId,
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    status: parsed.audioStatus || "pending_transcription"
  }] : [];
  const video = buildVideoMetadata(parsed, payload);
  const files = buildFileMetadata(parsed, payload);

  const fallbackText = type === "UNSUPPORTED" ? ""
    : fileId && !isAudioMessage(parsed)
    ? "[" + type + " uploaded without caption]"
    : isAudioMessage(parsed) ? "[AUDIO pending transcription]" : "";

  return {
    messageId: String(options && options.messageId || parsed.messageId || payload.messageId || randomId(12)),
    traceId: String(options && options.traceId || parsed.traceId || payload.traceId || ""),
    type: type,
    text: String(parsed.text || fallbackText).trim(),
    fileId: fileId,
    media: media,
    audio: audio,
    video: video,
    files: files,
    location: buildLocationMetadata(parsed, payload),
    captions: collectCaptions(parsed, payload),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    originalType: parsed.originalType || (type === "AUDIO" ? "AUDIO" : ""),
    originalFileId: parsed.originalFileId || "",
    quotedMessageId: quoted.messageId,
    replyToMessageId: quoted.messageId,
    quotedFileId: quoted.fileId,
    quotedType: quoted.type,
    audioStatus: parsed.audioStatus || (audio.length ? "pending" : ""),
    audioTranscript: parsed.audioTranscript || "",
    awaitingTranscription: Boolean(audio.length && !parsed.audioTranscript && parsed.audioStatus !== "failed"),
    app: String(payload.app || ""),
    member: String(payload.member || ""),
    channel: String(payload.channel || ""),
    from: String(payload.from || ""),
    to: String(payload.to || ""),
    receivedAt: String(options && options.receivedAt || new Date().toISOString())
  };
}

export function extractMediaFromPayload(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const type = String(parsed.type || payload.type || data.type || "TEXT").toUpperCase();
  const candidates = [];
  const rawMedia = []
    .concat(Array.isArray(parsed.media) ? parsed.media : [])
    .concat(Array.isArray(data.media) ? data.media : [])
    .concat(Array.isArray(payload.media) ? payload.media : [])
    .concat(Array.isArray(data.attachments) ? data.attachments : [])
    .concat(Array.isArray(payload.attachments) ? payload.attachments : []);

  if (parsed.fileId) {
    rawMedia.unshift({
      type: type,
      fileId: parsed.fileId,
      mimeType: parsed.mimeType || "",
      fileName: parsed.fileName || "",
      caption: parsed.caption || parsed.text || ""
    });
  }

  for (const item of rawMedia) {
    const fileId = String(item.fileId || item.file_id || item.mediaId || item.id || "");
    if (!fileId) continue;

    const itemType = String(item.type || type || "FILE").toUpperCase();
    const mimeType = String(item.mimeType || item.mime_type || item.contentType || "");
    const normalizedType = mimeType.startsWith("image/") ? "IMAGE"
      : mimeType.startsWith("video/") ? "VIDEO"
      : mimeType.startsWith("audio/") ? "AUDIO"
      : itemType;

    if (["AUDIO", "VOICE", "PTT"].includes(normalizedType)) continue;

    candidates.push({
      type: ["IMAGE", "VIDEO", "FILE"].includes(normalizedType) ? normalizedType : "FILE",
      fileId: fileId,
      mimeType: mimeType,
      fileName: String(item.fileName || item.file_name || item.name || ""),
      caption: String(item.caption || item.text || "")
    });
  }

  const seen = new Set();
  return candidates.filter(function (item) {
    if (seen.has(item.fileId)) return false;
    seen.add(item.fileId);
    return true;
  });
}

export function extractQuotedMessageReference(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const directRefs = [{
    quotedMessageId: parsed.quotedMessageId || payload.quotedMessageId || data.quotedMessageId,
    replyToMessageId: parsed.replyToMessageId || payload.replyToMessageId || data.replyToMessageId,
    fileId: parsed.quotedFileId || payload.quotedFileId || data.quotedFileId,
    type: parsed.quotedType || payload.quotedType || data.quotedType
  }];
  const containers = directRefs.concat([
    parsed.context,
    payload.context,
    data.context,
    parsed.quotedMessage,
    payload.quotedMessage,
    data.quotedMessage,
    parsed.quoted,
    payload.quoted,
    data.quoted,
    parsed.replyTo,
    payload.replyTo,
    data.replyTo,
    parsed.reply_to,
    payload.reply_to,
    data.reply_to
  ]).filter(function (item) {
    return item && typeof item === "object";
  });

  for (const item of containers) {
    const messageId = String(
      item.quotedMessageId ||
      item.replyToMessageId ||
      item.messageId ||
      item.message_id ||
      item.id ||
      item.mid ||
      item.stanzaId ||
      item.stanza_id ||
      ""
    ).trim();
    const fileId = String(
      item.fileId ||
      item.file_id ||
      item.mediaId ||
      item.media_id ||
      item.attachment && (item.attachment.fileId || item.attachment.file_id) ||
      item.file && (item.file.fileId || item.file.file_id) ||
      ""
    ).trim();
    const type = String(item.type || item.messageType || item.message_type || "").toUpperCase();
    if (messageId || fileId) {
      return { messageId: messageId, fileId: fileId, type: type };
    }
  }

  return { messageId: "", fileId: "", type: "" };
}

export function collectCaptions(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const captions = []
    .concat(parsed.caption || [])
    .concat(payload.caption || [])
    .concat(data.caption || [])
    .concat((Array.isArray(parsed.media) ? parsed.media : []).map(function (item) { return item.caption || item.text || ""; }))
    .concat((Array.isArray(data.media) ? data.media : []).map(function (item) { return item.caption || item.text || ""; }))
    .map(function (value) { return String(value || "").trim(); })
    .filter(Boolean);

  if (parsed.text && captions.indexOf(String(parsed.text).trim()) === -1 && parsed.fileId) {
    captions.unshift(String(parsed.text).trim());
  }

  return Array.from(new Set(captions));
}

export function isAudioMessage(parsedMessage) {
  const type = String(parsedMessage && parsedMessage.type || "").toUpperCase();
  const mimeType = String(parsedMessage && parsedMessage.mimeType || "").toLowerCase();

  return ["AUDIO", "VOICE", "PTT"].includes(type) ||
    (type === "FILE" && mimeType.startsWith("audio/"));
}

export function buildVideoMetadata(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const type = String(parsed.type || "").toUpperCase();

  if (type !== "VIDEO") return [];

  return [{
    fileId: String(parsed.fileId || ""),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    url: String(parsed.url || ""),
    duration: parsed.duration || woztellPayload && woztellPayload.duration || "",
    receivedAt: new Date().toISOString()
  }].filter(function (item) {
    return item.fileId || item.url;
  });
}

export function buildFileMetadata(parsedMessage) {
  const parsed = parsedMessage || {};
  const type = String(parsed.type || "").toUpperCase();

  if (type !== "FILE") return [];

  return [{
    fileId: String(parsed.fileId || ""),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    url: String(parsed.url || ""),
    receivedAt: new Date().toISOString()
  }].filter(function (item) {
    return item.fileId || item.url;
  });
}

export function buildLocationMetadata(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const type = String(parsed.type || payload.type || data.type || "").toUpperCase();

  if (type !== "LOCATION") return null;

  const location = data.location || payload.location || parsed.location || data;
  return {
    latitude: Number(location.latitude || location.lat || 0) || null,
    longitude: Number(location.longitude || location.lng || location.lon || 0) || null,
    name: String(location.name || ""),
    address: String(location.address || "")
  };
}

function randomId(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";

  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}
