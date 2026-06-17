import { routeIntentV2 } from "./intentRouterV2.js";
import { evaluatePolicyGate } from "./policyGate.js";
import { composeReplyV2 } from "./replyComposerV2.js";

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

  const routerResult = routeIntentV2({
    userTurn: clean.userTurn,
    conversationState: clean.conversationState || {},
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
  const policyDecision = evaluatePolicyGate({
    routerResult: routerResult,
    userTurn: clean.userTurn,
    conversationState: clean.conversationState || {},
    tenantConfig: clean.tenantConfig || {},
    now: clean.now,
    timezone: clean.timezone
  });
  const reply = composeReplyV2({
    routerResult: routerResult,
    policyDecision: policyDecision,
    userTurn: clean.userTurn,
    conversationState: clean.conversationState || {},
    tenantConfig: clean.tenantConfig || {}
  });
  const handled = shouldHandleWithoutToolExecution(policyDecision, reply);

  return {
    enabled: true,
    handled: handled,
    shouldSend: Boolean(handled && reply.shouldSend),
    shouldContinueLegacyFlow: !handled,
    reason: handled ? "v2_policy_handled_without_tool_execution" : "v2_policy_deferred_to_legacy_tools",
    routerResult: routerResult,
    policyDecision: policyDecision,
    reply: reply,
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
    missingSlots: Array.isArray(policy.missingSlots) ? policy.missingSlots : [],
    blockedReasons: Array.isArray(policy.blockedReasons) ? policy.blockedReasons : []
  };
}

function shouldHandleWithoutToolExecution(policyDecision, reply) {
  const policy = policyDecision || {};
  if (policy.shouldSendBotReply === false || policy.decision === "do_nothing") return true;
  if (policy.shouldExecuteTools) return false;
  if (!reply || !reply.shouldSend) return false;
  return ["repair", "ask_clarification", "ask_confirmation", "reply_only", "answer_only"].includes(policy.decision);
}

function isEnabled(value) {
  return String(value || "false").toLowerCase() === "true";
}
