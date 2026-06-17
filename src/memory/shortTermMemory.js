import {
  buildConversationLogEntry,
  buildConversationSummary,
  buildCustomerMemory,
  buildUserStyleProfile,
  buildUtilityMemory,
  getCoreFeatureFlags,
  updateConversationMemory
} from "../conversationMemory.js";
import { buildMemoryPolicy } from "./memoryPolicy.js";
import { normalizeLongTermMemory } from "./longTermMemoryAdapter.js";

export {
  buildConversationLogEntry,
  buildConversationSummary,
  buildCustomerMemory,
  buildUserStyleProfile,
  buildUtilityMemory,
  getCoreFeatureFlags
};

export function updateShortTermMemory(data, userTurn, options) {
  return updateConversationMemory(data, userTurn, options);
}

export { updateShortTermMemory as updateConversationMemory };

export function buildShortTermMemorySnapshot(data, options) {
  const clean = data || {};
  const limit = Number(options && options.limit || 20);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 20;

  return {
    conversationLog: Array.isArray(clean.conversationLog) ? clean.conversationLog.slice(-safeLimit) : [],
    conversationSummary: clean.conversationSummary || null,
    userStyleProfile: clean.userStyleProfile || null,
    customerMemory: clean.customerMemory || null,
    utilityMemory: clean.utilityMemory || null,
    retentionMode: String(options && options.retentionMode || "summarized"),
    scope: "conversation"
  };
}

export function buildMemoryReadModel(data, options) {
  const clean = data || {};
  const policy = options && options.memoryPolicy || clean.memoryPolicy || buildMemoryPolicy({}, clean, options);
  const longTermMemory = policy.longTerm && policy.longTerm.readAllowed
    ? normalizeLongTermMemory(options && options.longTermMemory || clean.longTermMemory || null)
    : null;

  return {
    shortTerm: buildShortTermMemorySnapshot(clean, Object.assign({}, options || {}, {
      limit: policy.shortTerm && policy.shortTerm.maxTurns || options && options.limit,
      retentionMode: policy.shortTerm && policy.shortTerm.retentionMode || options && options.retentionMode
    })),
    longTerm: longTermMemory,
    policy: {
      shortTerm: policy.shortTerm,
      longTerm: {
        enabled: Boolean(policy.longTerm && policy.longTerm.enabled),
        mode: policy.longTerm && policy.longTerm.mode || "disabled",
        scope: policy.longTerm && policy.longTerm.scope || "user_conversation",
        requiresConsent: Boolean(policy.longTerm && policy.longTerm.requiresConsent),
        consentStatus: policy.longTerm && policy.longTerm.consentStatus || "not_requested",
        readAllowed: Boolean(policy.longTerm && policy.longTerm.readAllowed),
        writeAllowed: Boolean(policy.longTerm && policy.longTerm.writeAllowed),
        rawHistoryAllowed: false,
        sensitiveDataAllowed: false
      }
    },
    identity: buildMemoryIdentity(clean)
  };
}

export function buildMemoryIdentity(data) {
  const clean = data || {};
  return {
    conversationId: clean.channelIdentity && clean.channelIdentity.conversationId || clean.doName || "",
    channelId: clean.channel || clean.channelIdentity && clean.channelIdentity.channelId || "",
    userId: clean.phone || clean.channelIdentity && clean.channelIdentity.recipientId || "",
    memberId: clean.member || clean.channelIdentity && clean.channelIdentity.memberId || "",
    platform: clean.channelIdentity && clean.channelIdentity.platform || "whatsapp"
  };
}
