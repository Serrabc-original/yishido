import { routeIntentV2 } from "./intentRouterV2.js";
import { evaluatePolicyGate } from "./policyGate.js";
import { composeReplyV2 } from "./replyComposerV2.js";
import { resolveIntentRouterV2MultimodalContext } from "./multimodalContextResolver.js";
import { hasIntentRouterV2LocalWork } from "../tools/toolContracts.js";

export function buildIntentRouterV2TurnDecision(input) {
  const clean = input || {};
  const env = clean.env || {};
  const flags = {
    intentRouterV2: isEnabled(env.INTENT_ROUTER_V2_ENABLED),
    policyGate: isEnabled(env.POLICY_GATE_ENABLED),
    replyComposerV2: isEnabled(env.REPLY_COMPOSER_V2_ENABLED)
  };

  if (!flags.intentRouterV2 || !flags.policyGate || !flags.replyComposerV2) {
    return {
      enabled: false,
      handled: false,
      shouldSend: false,
      shouldContinueLegacyFlow: true,
      flags: flags,
      reason: "feature_flags_disabled"
    };
  }

  const resolvedContext = resolveIntentRouterV2MultimodalContext({
    userTurn: clean.userTurn,
    conversationState: clean.conversationState || {}
  });
  const effectiveUserTurn = resolvedContext.userTurn;
  const effectiveConversationState = resolvedContext.conversationState;

  const routerResult = routeIntentV2({
    userTurn: effectiveUserTurn,
    conversationState: effectiveConversationState,
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
  const policyDecision = evaluatePolicyGate({
    routerResult: routerResult,
    userTurn: effectiveUserTurn,
    conversationState: effectiveConversationState,
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
  const toolExecution = executeLocalToolsIfNeeded({
    toolExecutor: clean.toolExecutor,
    routerResult: routerResult,
    policyDecision: policyDecision,
    userTurn: effectiveUserTurn,
    conversationState: effectiveConversationState,
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
  const policyForReply = Object.assign({}, policyDecision, {
    toolResults: toolExecution && Array.isArray(toolExecution.toolResults) ? toolExecution.toolResults : [],
    executedTools: toolExecution && Array.isArray(toolExecution.executedTools) ? toolExecution.executedTools : [],
    blockedTools: toolExecution && Array.isArray(toolExecution.blockedTools) ? toolExecution.blockedTools : []
  });
  const reply = composeReplyV2({
    routerResult: routerResult,
    policyDecision: policyForReply,
    toolResults: policyForReply.toolResults,
    userTurn: effectiveUserTurn,
    conversationState: effectiveConversationState,
    tenantConfig: clean.tenantConfig || {}
  });
  const handled = shouldHandle(policyForReply, reply, toolExecution);
  const shouldContinueLegacyFlow = toolExecution && toolExecution.shouldContinueLegacyFlow === true ? true : !handled;

  return {
    enabled: true,
    handled: handled,
    shouldSend: Boolean(handled && reply.shouldSend),
    shouldContinueLegacyFlow: shouldContinueLegacyFlow,
    reason: buildDecisionReason(handled, toolExecution),
    routerResult: routerResult,
    policyDecision: policyForReply,
    reply: reply,
    toolExecution: toolExecution,
    updatedData: toolExecution && toolExecution.updatedData || null,
    stateRecommendations: routerResult.state_recommendations || {}
  };
}

export function summarizeIntentRouterV2Decision(decision) {
  const clean = decision || {};
  const router = clean.routerResult || {};
  const policy = clean.policyDecision || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
  return {
    enabled: Boolean(clean.enabled),
    handled: Boolean(clean.handled),
    reason: clean.reason || "",
    turnType: router.turn_type || "",
    replyStrategy: router.reply_strategy && router.reply_strategy.kind || "",
    policyDecision: policy.decision || "",
    shouldExecuteTools: Boolean(policy.shouldExecuteTools),
    shouldSendBotReply: policy.shouldSendBotReply !== false,
    taskIntents: tasks.map(function (task) { return task.intent; }).filter(Boolean),
    toolsExecuted: Array.isArray(policy.executedTools) ? policy.executedTools : [],
    toolsBlocked: Array.isArray(policy.blockedTools) ? policy.blockedTools : [],
    missingSlots: Array.isArray(policy.missingSlots) ? policy.missingSlots : [],
    blockedReasons: Array.isArray(policy.blockedReasons) ? policy.blockedReasons : []
  };
}

function executeLocalToolsIfNeeded(input) {
  const clean = input || {};
  if (typeof clean.toolExecutor !== "function") return null;
  const router = clean.routerResult || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
  const policy = clean.policyDecision || {};
  if (!policy.shouldExecuteTools && !hasIntentRouterV2LocalWork(tasks) && !hasIntentRouterV2PendingStateWork(tasks)) return null;
  return clean.toolExecutor({
    routerResult: router,
    policyDecision: policy,
    userTurn: clean.userTurn,
    conversationState: clean.conversationState || {},
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
}

function hasIntentRouterV2PendingStateWork(tasks) {
  return (Array.isArray(tasks) ? tasks : []).some(function (task) {
    return task && (task.intent === "reminder.create" && task.status === "needs_clarification" ||
      /^crm\./.test(String(task.intent || "")) && task.status === "needs_confirmation");
  });
}

function shouldHandle(policyDecision, reply, toolExecution) {
  if (toolExecution) {
    if (toolExecution.shouldContinueLegacyFlow === true) return false;
    if (toolExecution.handled === true) return true;
  }
  const policy = policyDecision || {};
  if (policy.shouldSendBotReply === false || policy.decision === "do_nothing") return true;
  if (policy.shouldExecuteTools) return false;
  if (!reply || !reply.shouldSend) return false;
  return ["repair", "ask_clarification", "ask_confirmation", "reply_only", "answer_only"].includes(policy.decision);
}

function buildDecisionReason(handled, toolExecution) {
  if (toolExecution && toolExecution.shouldContinueLegacyFlow === true) return "v2_policy_delegated_to_legacy_flow";
  if (toolExecution && toolExecution.handled === true) return "v2_policy_executed_local_tools";
  return handled ? "v2_policy_handled_without_tool_execution" : "v2_policy_deferred_to_legacy_tools";
}

function isEnabled(value) {
  return String(value || "false").toLowerCase() === "true";
}
