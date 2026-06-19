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

export function normalizeWoztellLiveChatMode(input) {
  const clean = input || {};
  const payload = clean.payload || clean.woztellPayload || {};
  const data = safeObject(payload.data);
  const meta = safeObject(payload.meta || data.meta);
  const member = safeObject(payload.member || payload.memberInfo);
  const dataMember = safeObject(data.member || data.memberInfo);
  const eventMeta = clean.eventMeta || clean.messageEventMeta || {};
  const eventWoztellMeta = safeObject(eventMeta.woztellMeta || eventMeta.woztell_meta);
  const state = clean.data || clean.state || {};

  const candidates = [
    ["payload.conversation_mode", payload.conversation_mode],
    ["payload.conversationMode", payload.conversationMode],
    ["payload.liveChat", payload.liveChat],
    ["payload.live_chat", payload.live_chat],
    ["payload.liveChatStatus", payload.liveChatStatus],
    ["payload.chatMode", payload.chatMode],
    ["payload.mode", payload.mode],
    ["data.conversation_mode", data.conversation_mode],
    ["data.conversationMode", data.conversationMode],
    ["data.liveChat", data.liveChat],
    ["data.live_chat", data.live_chat],
    ["data.liveChatStatus", data.liveChatStatus],
    ["data.chatMode", data.chatMode],
    ["data.mode", data.mode],
    ["meta.conversation_mode", meta.conversation_mode],
    ["meta.conversationMode", meta.conversationMode],
    ["meta.liveChat", meta.liveChat],
    ["meta.live_chat", meta.live_chat],
    ["meta.liveChatStatus", meta.liveChatStatus],
    ["meta.chatMode", meta.chatMode],
    ["meta.mode", meta.mode],
    ["member.conversation_mode", member.conversation_mode],
    ["member.conversationMode", member.conversationMode],
    ["member.liveChat", member.liveChat],
    ["member.live_chat", member.live_chat],
    ["member.liveChatStatus", member.liveChatStatus],
    ["member.chatMode", member.chatMode],
    ["member.mode", member.mode],
    ["data.member.conversation_mode", dataMember.conversation_mode],
    ["data.member.conversationMode", dataMember.conversationMode],
    ["data.member.liveChat", dataMember.liveChat],
    ["data.member.live_chat", dataMember.live_chat],
    ["data.member.liveChatStatus", dataMember.liveChatStatus],
    ["data.member.chatMode", dataMember.chatMode],
    ["data.member.mode", dataMember.mode],
    ["eventMeta.woztellMeta.conversation_mode", eventWoztellMeta.conversation_mode],
    ["eventMeta.woztellMeta.conversationMode", eventWoztellMeta.conversationMode],
    ["eventMeta.woztellMeta.liveChat", eventWoztellMeta.liveChat],
    ["eventMeta.woztellMeta.live_chat", eventWoztellMeta.live_chat],
    ["eventMeta.woztellMeta.liveChatStatus", eventWoztellMeta.liveChatStatus],
    ["state.conversation_mode", state.conversation_mode],
    ["state.conversationMode", state.conversationMode],
    ["state.liveChat", state.liveChat],
    ["state.live_chat", state.live_chat]
  ];

  for (const candidate of candidates) {
    const parsed = parseLiveChatValue(candidate[1]);
    if (parsed.known) {
      return {
        isLiveChat: parsed.isLiveChat,
        conversationMode: parsed.isLiveChat ? "live_chat" : "bot",
        source: candidate[0]
      };
    }
  }

  return {
    isLiveChat: false,
    conversationMode: "unknown",
    source: "not_provided"
  };
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

function safeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseLiveChatValue(value) {
  if (typeof value === "boolean") {
    return { known: true, isLiveChat: value };
  }

  if (typeof value === "number") {
    if (value === 1) return { known: true, isLiveChat: true };
    if (value === 0) return { known: true, isLiveChat: false };
    return { known: false, isLiveChat: false };
  }

  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  if (!text) {
    return { known: false, isLiveChat: false };
  }

  if ([
    "livechat",
    "live_chat",
    "human",
    "human_mode",
    "humano",
    "manual",
    "manual_mode",
    "agent",
    "agent_mode",
    "asesor",
    "asesor_humano",
    "live",
    "active",
    "enabled",
    "on",
    "true",
    "1"
  ].includes(text)) {
    return { known: true, isLiveChat: true };
  }

  if ([
    "bot",
    "bot_mode",
    "automation",
    "automated",
    "auto",
    "automatic",
    "false",
    "0",
    "off",
    "disabled",
    "inactive"
  ].includes(text)) {
    return { known: true, isLiveChat: false };
  }

  return { known: false, isLiveChat: false };
}
