import { logEvent, redactForLog } from "../logger.js";
import { normalizeSupervisorDecision, normalizeUserTurnContract } from "../contracts/assistantContracts.js";

const DEFAULT_RECENT_LIMIT = 12;

export function buildRequestContext(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || clean.currentTurn || {};
  const activeContext = normalizeActiveContext(clean.activeContext || {});
  const recentWindow = compactRecentWindow(clean.recentConversationWindow || [], clean.recentLimit || DEFAULT_RECENT_LIMIT);
  const turnContract = normalizeUserTurnContract(userTurn);
  const mediaPolicy = buildMediaPolicy(userTurn, activeContext);
  const context = redactForLog({
    contextId: activeContext.contextId,
    userTurn: turnContract,
    activeContext: activeContext,
    recentConversationWindow: recentWindow,
    conversationSummary: compactObject(clean.conversationSummary || null, 1200),
    customerMemory: compactObject(clean.customerMemory || null, 1200),
    utilityMemory: compactObject(clean.utilityMemory || null, 800),
    mediaMemorySummary: compactObject(clean.mediaMemorySummary || null, 1600),
    mediaPolicy: mediaPolicy,
    orchestrationPolicy: {
      sendRawHistory: false,
      preferCompactState: true,
      usePreviousMediaOnlyWhenReferenced: mediaPolicy.previousMediaAllowed,
      staleMediaAllowed: false
    }
  });

  logEvent("CONTEXT_SNAPSHOT_BUILT", {
    traceId: userTurn.trace_id || userTurn.traceId || "",
    turnId: userTurn.turn_id || userTurn.turnId || "",
    contextId: context.contextId || "",
    recentWindowCount: recentWindow.length,
    contextPolicy: turnContract.contextPolicy,
    mediaScopeHint: mediaPolicy.scopeHint
  });

  return context;
}

export function buildSupervisorInput(input) {
  const clean = input || {};
  const requestContext = clean.requestContext || buildRequestContext(clean);

  return {
    currentTurn: clean.userTurn || clean.currentTurn || {},
    recentConversationWindow: requestContext.recentConversationWindow || [],
    activeContext: requestContext.activeContext || {},
    memorySummary: requestContext.conversationSummary || null,
    utilityMemory: requestContext.utilityMemory || null,
    mediaMemorySummary: requestContext.mediaMemorySummary || null,
    activeTask: clean.activeTask || clean.userTurn && (clean.userTurn.activeTask || clean.userTurn.active_task) || null,
    taskMediaAssets: clean.taskMediaAssets || clean.userTurn && (clean.userTurn.taskMediaAssets || clean.userTurn.task_media_assets) || [],
    pendingMedia: clean.pendingMedia || clean.userTurn && (clean.userTurn.current_turn_media || clean.userTurn.currentTurnMedia) || {},
    mediaCounts: {
      expected: clean.userTurn && clean.userTurn.expected_media_count || "",
      received: clean.userTurn && clean.userTurn.received_media_count || clean.userTurn && clean.userTurn.image_count || 0
    },
    requestContext: requestContext,
    supervisorConfig: clean.supervisorConfig || {}
  };
}

export function buildFinalResponseContext(input) {
  const clean = input || {};
  const supervisorDecision = normalizeSupervisorDecision(clean.supervisorPlan || clean.supervisorDecision || {});

  return {
    userTurn: normalizeUserTurnContract(clean.userTurn || {}),
    supervisorDecision: supervisorDecision,
    contextSnapshot: clean.requestContext || buildRequestContext(clean),
    moduleResults: Array.isArray(clean.moduleResults) ? clean.moduleResults : []
  };
}

function buildMediaPolicy(userTurn, activeContext) {
  const turn = userTurn || {};
  const current = turn.current_turn_media || turn.currentTurnMedia || {};
  const previous = turn.previous_relevant_media || turn.previousRelevantMedia || {};
  const stale = turn.stale_media || turn.staleMedia || {};
  const contextPolicy = String(turn.context_policy || "current_turn_only");
  const currentCount = Number(current.asset_count || current.assetCount || turn.image_count || 0);
  const previousCount = Number(previous.asset_count || previous.assetCount || 0);

  return {
    scopeHint: currentCount > 1 ? "all_pending_batch" : currentCount === 1 ? "current_only" : previousCount ? "previous_relevant" : "none",
    currentMediaCount: currentCount,
    previousRelevantMediaCount: previousCount,
    staleMediaCount: Number(stale.asset_count || stale.assetCount || 0),
    previousMediaAllowed: contextPolicy === "use_previous_context" && previousCount > 0,
    activeIntent: activeContext.activeIntent || "general"
  };
}

function normalizeActiveContext(context) {
  const clean = context || {};

  return {
    activeIntent: String(clean.activeIntent || clean.active_intent || "general"),
    activeTask: String(clean.activeTask || clean.active_task || clean.activeIntent || clean.active_intent || "general"),
    contextId: String(clean.contextId || clean.context_id || ""),
    lastUserGoal: String(clean.lastUserGoal || clean.last_user_goal || "").slice(0, 500),
    pendingClarification: String(clean.pendingClarification || clean.pending_clarification || "").slice(0, 500),
    referencedMedia: clean.referencedMedia || clean.referenced_media || null,
    updatedAt: String(clean.updatedAt || clean.updated_at || "")
  };
}

function compactRecentWindow(window, limit) {
  return (Array.isArray(window) ? window : []).slice(-Number(limit || DEFAULT_RECENT_LIMIT)).map(function (entry) {
    return redactForLog({
      turnId: String(entry.turnId || entry.turn_id || ""),
      traceId: String(entry.traceId || entry.trace_id || ""),
      type: String(entry.type || ""),
      timestamp: String(entry.timestamp || entry.at || ""),
      summary: String(entry.summary || entry.textPreview || "").slice(0, 500),
      mediaRefs: entry.mediaRefs || entry.media_refs || {},
      audioTranscript: String(entry.audioTranscript || "").slice(0, 500),
      visualResult: entry.visualResult || null
    });
  });
}

function compactObject(value, maxChars) {
  if (!value) return null;
  const text = JSON.stringify(redactForLog(value));
  if (text.length <= maxChars) return redactForLog(value);
  return {
    compacted: true,
    preview: text.slice(0, maxChars)
  };
}
