import { getRegisteredAction, listRegisteredActions } from "./actionRegistry.js";
import { planAgentRuntimeAction, runAgentRuntime } from "./agentRuntime.js";
import { buildIntentToolResponsePipeline } from "./intentToolResponsePipeline.js";
import { buildResponsePlan, normalizeActionContract } from "../contracts/assistantContracts.js";

export function buildAgentExecutionPlan(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || {};
  const route = clean.utilityRoute || clean.route || {};
  const trace = buildTrace(userTurn, clean.data);
  const plannedActions = buildPlannedActions(userTurn, route, clean);
  const executionMode = selectExecutionMode(route, plannedActions);
  const permission = buildToolPermissionPreview(plannedActions, executionMode);
  const finalResponsePolicy = buildFinalResponsePolicy(executionMode, route);
  const responsePlan = buildResponsePlan({
    messages: [],
    traceId: trace.traceId,
    turnId: trace.turnId,
    doName: trace.doName
  });

  return {
    stage: "execution_planned",
    traceId: trace.traceId,
    turnId: trace.turnId,
    doName: trace.doName,
    intent: String(route.intent || "general"),
    module: String(route.module || route.targetModule || ""),
    confidence: Number(route.confidence || 0),
    executionMode: executionMode,
    route: {
      intent: String(route.intent || "general"),
      module: String(route.module || route.targetModule || ""),
      shouldHandleInCore: Boolean(route.shouldHandleInCore),
      shouldPassToAgent: Boolean(route.shouldPassToAgent),
      missingFields: Array.isArray(route.missingFields) ? route.missingFields.slice(0, 10) : []
    },
    toolPlan: {
      actions: plannedActions
    },
    toolPermission: permission,
    finalResponsePolicy: finalResponsePolicy,
    responsePlan: responsePlan,
    allowedToolActions: listRegisteredActions().map(function (item) { return item.action; }),
    shouldUseVisionUtility: executionMode === "vision_utility",
    shouldUseAgentRuntime: executionMode === "agent_runtime",
    shouldUseCoreUtility: executionMode === "core_utility",
    shouldUseOrchestrator: executionMode === "orchestrator"
  };
}

export function runAgentExecutionPlan(input) {
  const clean = input || {};
  const plan = clean.executionPlan || clean.plan || {};

  if (plan.executionMode !== "agent_runtime") {
    return {
      handled: false,
      executionPlan: plan,
      runtimeResult: null,
      finalResponse: null
    };
  }

  const runtimeResult = runAgentRuntime({
    data: clean.data,
    userTurn: clean.userTurn,
    utilityRoute: clean.utilityRoute || clean.route,
    action: plan.toolPlan && plan.toolPlan.actions && plan.toolPlan.actions[0],
    now: clean.now
  });
  const finalResponse = runtimeResult.handled
    ? buildResponsePlan({
      text: runtimeResult.responseText || "Listo.",
      traceId: plan.traceId,
      turnId: plan.turnId,
      doName: plan.doName
    })
    : null;

  return {
    handled: Boolean(runtimeResult.handled),
    executionPlan: plan,
    runtimeResult: runtimeResult,
    finalResponse: finalResponse
  };
}

export function summarizeAgentExecutionPlan(plan) {
  const clean = plan || {};
  const toolActions = clean.toolPlan && Array.isArray(clean.toolPlan.actions) ? clean.toolPlan.actions : [];
  const permission = clean.toolPermission || {};
  const responsePolicy = clean.finalResponsePolicy || {};

  return {
    stage: clean.stage || "execution_planned",
    traceId: clean.traceId || "",
    turnId: clean.turnId || "",
    doName: clean.doName || "",
    intent: clean.intent || "",
    module: clean.module || "",
    executionMode: clean.executionMode || "",
    toolActions: toolActions.map(function (action) { return action.action; }),
    toolModules: toolActions.map(function (action) { return action.module; }),
    toolPermissionStatus: permission.status || "",
    blockedToolCount: Number(permission.blockedCount || 0),
    finalResponseSource: responsePolicy.source || "",
    outputChannel: responsePolicy.outputChannel || "whatsapp"
  };
}

export function buildPipelineDescriptorFromExecution(input) {
  const clean = input || {};
  const plan = clean.executionPlan || clean.plan || {};

  return buildIntentToolResponsePipeline({
    stage: clean.stage || plan.stage || "execution_planned",
    userTurn: clean.userTurn,
    utilityRoute: clean.utilityRoute || plan.route,
    executionPlan: plan,
    runtimeResult: clean.runtimeResult,
    finalResponse: clean.finalResponse
  });
}

function buildPlannedActions(userTurn, route, input) {
  const mode = selectExecutionMode(route, []);

  if (mode === "agent_runtime") {
    const action = planAgentRuntimeAction({
      userTurn: userTurn,
      utilityRoute: route,
      now: input && input.now
    });
    return action ? [normalizeActionContract(action)] : [];
  }

  if (mode === "vision_utility") {
    return [normalizeActionContract({
      action: route.intent === "image_ocr" ? "extract_image_text" : "analyze_image",
      module: "vision",
      confidence: route.confidence || 0.78,
      status: "allowed",
      userFacingSummary: route.intent === "image_ocr" ? "Extraer texto visible de imagenes." : "Analizar imagenes del turno."
    })];
  }

  if (mode === "core_utility") {
    return [normalizeActionContract({
      action: mapCoreUtilityAction(route.intent),
      module: route.module || "core",
      confidence: route.confidence || 0.7,
      status: "allowed",
      userFacingSummary: "Ejecutar utilidad interna del asistente."
    })];
  }

  return [];
}

function selectExecutionMode(route, plannedActions) {
  const clean = route || {};

  if (isVisionUtilityRoute(clean)) return "vision_utility";
  if (isAgentRuntimeRoute(clean) || hasRegisteredRuntimeAction(plannedActions)) return "agent_runtime";
  if (clean.shouldHandleInCore) return "core_utility";
  return "orchestrator";
}

function hasRegisteredRuntimeAction(plannedActions) {
  if (!Array.isArray(plannedActions)) return false;
  return plannedActions.some(function (action) {
    return Boolean(action && getRegisteredAction(action.action));
  });
}

function buildToolPermissionPreview(actions, executionMode) {
  if (!Array.isArray(actions) || !actions.length) {
    return {
      status: executionMode === "orchestrator" ? "not_applicable" : "no_tools_planned",
      allowed: executionMode === "orchestrator",
      blockedCount: 0,
      allowedCount: 0,
      reasons: []
    };
  }

  if (executionMode !== "agent_runtime") {
    return {
      status: "internal_allowed",
      allowed: true,
      blockedCount: 0,
      allowedCount: actions.length,
      reasons: []
    };
  }

  const blocked = actions.filter(function (action) {
    const registered = getRegisteredAction(action.action);
    return !registered || registered.requiresApproval || action.requiresApproval;
  });

  return {
    status: blocked.length ? "blocked" : "allowed",
    allowed: blocked.length === 0,
    blockedCount: blocked.length,
    allowedCount: actions.length - blocked.length,
    reasons: blocked.map(function (action) {
      return getRegisteredAction(action.action) ? "approval_required:" + action.action : "unregistered_action:" + action.action;
    })
  };
}

function buildFinalResponsePolicy(executionMode, route) {
  const sourceByMode = {
    vision_utility: "vision_final_response",
    agent_runtime: "tool_runtime_result",
    core_utility: "core_utility_result",
    orchestrator: "orchestrator_plan"
  };

  return {
    source: sourceByMode[executionMode] || "orchestrator_plan",
    outputChannel: "whatsapp",
    requiresHumanFinalResponse: executionMode === "orchestrator",
    intent: String(route && route.intent || "general")
  };
}

function mapCoreUtilityAction(intent) {
  if (intent === "list") return "update_list";
  if (intent === "reminder") return "schedule_reminder";
  if (intent === "list_reminder") return "update_list_and_schedule_reminder";
  return "handle_core_utility";
}

function buildTrace(userTurn, data) {
  return {
    traceId: userTurn && (userTurn.trace_id || userTurn.traceId) || "",
    turnId: userTurn && (userTurn.turn_id || userTurn.turnId) || "",
    doName: data && data.doName || ""
  };
}

function isVisionUtilityRoute(route) {
  return route && (route.intent === "image_question" || route.intent === "image_ocr");
}

function isAgentRuntimeRoute(route) {
  return route && (route.intent === "task" || route.intent === "crm" || route.module === "tasks" || route.module === "crmLite");
}
