import { normalizeConversationIdentity } from "../contracts/assistantContracts.js";
import { redactForLog } from "../logger.js";

export function buildWoztellConversationIdentity(payload) {
  const clean = payload || {};

  return normalizeConversationIdentity({
    conversationId: clean.conversationId || "",
    channelId: clean.channel || clean.channelId || "",
    memberId: clean.member || clean.memberId || "",
    recipientId: clean.from || clean.recipientId || "",
    appId: clean.app || clean.appId || "",
    platform: clean.platform || "whatsapp"
  });
}

export function normalizeWoztellMessageEventMeta(payload) {
  const clean = payload || {};
  const data = clean.data || {};

  return redactForLog({
    channelId: clean.channel || clean.channelId || "",
    memberId: clean.member || clean.memberId || "",
    appId: clean.app || clean.appId || "",
    platform: clean.platform || "whatsapp",
    messageEvent: {
      type: clean.type || data.type || "",
      messageId: clean.messageId || data.messageId || "",
      timestamp: clean.timestamp || data.timestamp || "",
      hasText: Boolean(clean.text || data.text || data.caption),
      hasFile: Boolean(clean.fileId || data.fileId || data.mediaId)
    },
    woztellMeta: clean.meta || data.meta || null,
    lastInboundAt: new Date().toISOString()
  });
}

export function buildWoztellEventSummary(payload) {
  const clean = payload || {};
  const data = clean.data || {};
  const media = Array.isArray(clean.media || data.media) ? clean.media || data.media : [];
  const fileId = String(clean.fileId || data.fileId || data.file_id || "");

  return redactForLog({
    eventType: clean.eventType || "",
    type: clean.type || data.type || "",
    messageId: clean.messageId || data.messageId || data.message_id || "",
    channel: clean.channel || clean.channelId || "",
    app: clean.app || clean.appId || "",
    from: clean.from || "",
    hasText: Boolean(clean.text || data.text || data.caption),
    textLength: String(clean.text || data.text || data.caption || "").length,
    hasFileId: Boolean(fileId),
    fileIdPreview: fileId ? fileId.slice(0, 6) + "***" + fileId.slice(-4) : "",
    mediaCount: media.length || (fileId ? 1 : 0)
  });
}

export function buildWoztellSendAttempts(params) {
  const clean = params || {};
  const memberId = String(clean.memberId || "");
  const recipientId = String(clean.recipientId || "");

  if (memberId) {
    return [{
      mode: "memberId",
      payload: buildWoztellSendPayload(clean, "memberId")
    }];
  }

  if (recipientId) {
    return [{
      mode: "recipientId",
      payload: buildWoztellSendPayload(clean, "recipientId")
    }];
  }

  return [{
    mode: "empty_recipient",
    payload: buildWoztellSendPayload(clean, "recipientId")
  }];
}

export function buildWoztellSendPayload(params, mode) {
  const clean = params || {};
  const payload = {
    channelId: clean.channelId,
    response: Array.isArray(clean.response) ? clean.response : []
  };

  if (clean.appId) payload.appId = clean.appId;
  if (mode === "memberId" && clean.memberId) {
    payload.memberId = clean.memberId;
  } else {
    payload.recipientId = clean.recipientId || "";
  }

  return payload;
}

export function summarizeWoztellSendPayload(payload, mode) {
  const clean = payload || {};

  return redactForLog({
    mode: mode || (clean.memberId ? "memberId" : "recipientId"),
    channelId: clean.channelId || "",
    hasMemberId: Boolean(clean.memberId),
    hasRecipientId: Boolean(clean.recipientId),
    hasAppId: Boolean(clean.appId),
    responseCount: Array.isArray(clean.response) ? clean.response.length : 0,
    responseTypes: (Array.isArray(clean.response) ? clean.response : []).map(function (item) {
      return item.type || "";
    })
  });
}

export function buildWoztellChannelCapabilities(env) {
  const clean = env || {};

  return {
    text: true,
    image: true,
    audioInbound: true,
    videoMetadataOnly: true,
    fileMetadataOnly: true,
    interactive: String(clean.ENABLE_WHATSAPP_INTERACTIVE || "true").toLowerCase() !== "false",
    templates: String(clean.ENABLE_TEMPLATE_MODULE || "true").toLowerCase() !== "false",
    brainLocation: "worker",
    channelRole: "whatsapp_crm_transport"
  };
}
