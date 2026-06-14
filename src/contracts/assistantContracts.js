import { redactForLog } from "../logger.js";

const SUPERVISOR_MEDIA_SCOPES = new Set(["none", "current_only", "previous_relevant", "current_and_previous", "all_pending_batch"]);
const RESPONSE_STRATEGIES = new Set(["answer_now", "analyze_then_answer", "ask_clarification", "create_utility_then_confirm", "wait_for_more_inputs"]);

export function normalizeConversationIdentity(input) {
  const clean = input || {};
  const channelId = String(clean.channelId || clean.channel || clean.channel_id || "");
  const memberId = String(clean.memberId || clean.member || clean.member_id || "");
  const recipientId = String(clean.recipientId || clean.recipient_id || clean.phone || clean.from || "");
  const appId = String(clean.appId || clean.app || clean.app_id || "");

  return {
    conversationId: String(clean.conversationId || clean.conversation_id || buildConversationId(channelId, memberId || recipientId)),
    channelId: channelId,
    memberId: memberId,
    recipientId: recipientId,
    appId: appId,
    platform: String(clean.platform || clean.type || "whatsapp").toLowerCase(),
    phoneHash: hashStable(recipientId)
  };
}

export function normalizeInboundMessageContract(message) {
  const clean = message || {};

  return redactForLog({
    messageId: String(clean.messageId || clean.message_id || ""),
    type: String(clean.type || "TEXT").toUpperCase(),
    text: String(clean.text || "").slice(0, 4000),
    media: Array.isArray(clean.media) ? clean.media : [],
    audio: Array.isArray(clean.audio) ? clean.audio : [],
    video: Array.isArray(clean.video) ? clean.video : [],
    files: Array.isArray(clean.files) ? clean.files : [],
    messageEventMeta: clean.messageEventMeta || clean.message_event_meta || null,
    receivedAt: String(clean.receivedAt || clean.received_at || new Date().toISOString())
  });
}

export function normalizeUserTurnContract(userTurn) {
  const turn = userTurn || {};
  const mediaBatch = turn.media_batch || turn.mediaBatch || { assets: [], fileIds: [] };

  return redactForLog({
    turnId: String(turn.turn_id || turn.turnId || ""),
    traceId: String(turn.trace_id || turn.traceId || ""),
    requestId: String(turn.request_id || turn.requestId || turn.turn_id || turn.turnId || ""),
    messageIds: Array.isArray(turn.message_ids || turn.messageIds) ? turn.message_ids || turn.messageIds : [],
    inputTypes: Array.isArray(turn.input_types || turn.inputTypes) ? turn.input_types || turn.inputTypes : [],
    currentTurnText: String(turn.current_turn_text || turn.currentTurnText || "").slice(0, 4000),
    audioTranscripts: Array.isArray(turn.audio_transcripts || turn.audioTranscripts) ? turn.audio_transcripts || turn.audioTranscripts : [],
    mediaBatch: normalizeMediaBatchContract(mediaBatch),
    contextPolicy: String(turn.context_policy || turn.contextPolicy || "current_turn_only"),
    createdAt: String(turn.created_at || turn.createdAt || new Date().toISOString())
  });
}

export function normalizeMediaAssetContract(asset) {
  const clean = asset || {};

  return redactForLog({
    assetId: String(clean.asset_id || clean.assetId || ""),
    assetIndex: Number(clean.asset_index || clean.assetIndex || 0),
    fileId: String(clean.file_id || clean.fileId || ""),
    url: String(clean.url || ""),
    mediaType: String(clean.media_type || clean.mediaType || "IMAGE").toUpperCase(),
    mimeType: String(clean.mime_type || clean.mimeType || ""),
    turnId: String(clean.turn_id || clean.turnId || ""),
    status: String(clean.status || "received"),
    analysis: clean.analysis || null,
    analysisError: String(clean.analysis_error || clean.analysisError || "")
  });
}

export function normalizeMediaBatchContract(mediaBatch) {
  const clean = mediaBatch || {};
  const assets = (Array.isArray(clean.assets) ? clean.assets : []).map(normalizeMediaAssetContract);

  return {
    assets: assets,
    fileIds: Array.isArray(clean.fileIds || clean.file_ids)
      ? (clean.fileIds || clean.file_ids).map(String).filter(Boolean)
      : assets.map(function (asset) { return asset.fileId; }).filter(Boolean),
    assetCount: Number(clean.assetCount || clean.asset_count || assets.length),
    analyzedAssetCount: Number(clean.analyzedAssetCount || clean.analyzed_asset_count || assets.filter(function (asset) { return asset.status === "analyzed"; }).length),
    failedAssetCount: Number(clean.failedAssetCount || clean.failed_asset_count || assets.filter(function (asset) { return asset.status === "analysis_failed"; }).length)
  };
}

export function normalizeSupervisorDecision(plan) {
  const clean = plan || {};
  const mediaScope = SUPERVISOR_MEDIA_SCOPES.has(clean.mediaScope) ? clean.mediaScope : "none";
  const responseStrategy = RESPONSE_STRATEGIES.has(clean.responseStrategy) ? clean.responseStrategy : "answer_now";

  return {
    intent: String(clean.intent || "unknown"),
    activeTask: String(clean.activeTask || clean.active_task || clean.intent || "unknown"),
    isContinuation: Boolean(clean.isContinuation || clean.is_continuation),
    isContextSwitch: Boolean(clean.isContextSwitch || clean.is_context_switch),
    contextSwitchReason: String(clean.contextSwitchReason || clean.context_switch_reason || ""),
    mediaScope: mediaScope,
    targetModules: Array.isArray(clean.targetModules || clean.target_modules) ? (clean.targetModules || clean.target_modules).map(String).filter(Boolean) : [],
    shouldWaitForMoreInputs: Boolean(clean.shouldWaitForMoreInputs || clean.should_wait_for_more_inputs),
    responseStrategy: responseStrategy,
    toolPlan: normalizeToolPlan(clean.toolPlan || clean.tool_plan || clean.actions || []),
    clarificationQuestion: String(clean.clarificationQuestion || clean.clarification_question || ""),
    memoryPolicy: normalizeMemoryPolicy(clean.memoryPolicy || clean.memory_policy || {}, clean.memoryUpdates || clean.memory_updates || [])
  };
}

export function normalizeModuleResult(result) {
  const clean = result || {};

  return redactForLog({
    module: String(clean.module || clean.name || ""),
    ok: clean.ok !== false,
    confidence: Number(clean.confidence || 0),
    data: clean.data || null,
    warnings: Array.isArray(clean.warnings) ? clean.warnings.map(String).slice(0, 10) : [],
    userFacingSummary: String(clean.userFacingSummary || clean.user_facing_summary || clean.text || "").slice(0, 1200)
  });
}

export function buildResponsePlan(input) {
  const clean = input || {};
  const messages = normalizeResponseMessages(clean.messages || (clean.text ? [{ type: "TEXT", text: clean.text }] : []));

  return redactForLog({
    messages: messages,
    requiresTemplate: Boolean(clean.requiresTemplate || clean.requires_template),
    interactive: clean.interactive || null,
    trace: {
      traceId: String(clean.traceId || clean.trace_id || clean.trace && clean.trace.traceId || ""),
      turnId: String(clean.turnId || clean.turn_id || clean.trace && clean.trace.turnId || ""),
      doName: String(clean.doName || clean.do_name || clean.trace && clean.trace.doName || "")
    }
  });
}

function normalizeResponseMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(function (message) {
    return {
      type: String(message.type || "TEXT").toUpperCase(),
      text: String(message.text || "").trim(),
      url: String(message.url || "")
    };
  }).filter(function (message) {
    return message.text || message.url;
  }).slice(0, 6);
}

function normalizeToolPlan(toolPlan) {
  const actions = Array.isArray(toolPlan) ? toolPlan : toolPlan.actions;

  return {
    actions: (Array.isArray(actions) ? actions : []).map(function (action) {
      return redactForLog({
        type: String(action && action.type || ""),
        module: String(action && action.module || ""),
        status: String(action && action.status || "planned")
      });
    }).filter(function (action) {
      return action.type;
    }).slice(0, 12)
  };
}

function normalizeMemoryPolicy(policy, memoryUpdates) {
  return {
    mode: String(policy.mode || (Array.isArray(memoryUpdates) && memoryUpdates.length ? "update_requested" : "read_only")),
    allowedUpdates: Array.isArray(memoryUpdates) ? memoryUpdates.map(function (item) {
      return {
        type: String(item && item.type || ""),
        valuePreview: String(item && item.value || "").slice(0, 120)
      };
    }).filter(function (item) {
      return item.type;
    }) : [],
    sensitiveDataAllowed: false
  };
}

function buildConversationId(channelId, userId) {
  return [channelId, userId].filter(Boolean).join(":");
}

function hashStable(value) {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return text ? "h_" + Math.abs(hash).toString(36) : "";
}
