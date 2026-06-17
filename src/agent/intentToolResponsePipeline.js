import { listRegisteredActions } from "./actionRegistry.js";

export function buildIntentToolResponsePipeline(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || {};
  const route = clean.utilityRoute || clean.route || {};
  const runtimeResult = clean.runtimeResult || null;
  const supervisorPlan = clean.supervisorPlan || {};
  const finalResponse = clean.finalResponse || null;
  const executionPlan = clean.executionPlan || {};
  const registered = listRegisteredActions();
  const plannedActions = executionPlan.toolPlan && Array.isArray(executionPlan.toolPlan.actions) ? executionPlan.toolPlan.actions : [];
  const action = runtimeResult && runtimeResult.action || clean.action || plannedActions[0] || null;

  return {
    stage: String(clean.stage || "intent_routed"),
    traceId: userTurn.trace_id || userTurn.traceId || "",
    turnId: userTurn.turn_id || userTurn.turnId || "",
    intent: String(route.intent || supervisorPlan.intent || "general"),
    module: String(route.module || route.targetModule || supervisorPlan.targetModule || ""),
    shouldHandleInCore: Boolean(route.shouldHandleInCore),
    responseStrategy: String(route.responseStrategy || supervisorPlan.responseStrategy || ""),
    executionMode: String(executionPlan.executionMode || ""),
    allowedToolActions: registered.map(function (item) { return item.action; }),
    plannedToolAction: action && action.action || "",
    plannedToolModule: action && action.module || "",
    toolStatus: action && action.status || "",
    blockedReason: action && action.status === "blocked" ? action.userFacingSummary || action.reason || "" : "",
    toolPermissionStatus: executionPlan.toolPermission && executionPlan.toolPermission.status || "",
    finalResponseSource: executionPlan.finalResponsePolicy && executionPlan.finalResponsePolicy.source || "",
    finalResponseReady: hasFinalResponse(finalResponse),
    outputChannel: "whatsapp"
  };
}

export function summarizePipelineForLog(pipeline) {
  const clean = pipeline || {};
  return {
    stage: clean.stage || "",
    traceId: clean.traceId || "",
    turnId: clean.turnId || "",
    intent: clean.intent || "",
    module: clean.module || "",
    shouldHandleInCore: Boolean(clean.shouldHandleInCore),
    responseStrategy: clean.responseStrategy || "",
    executionMode: clean.executionMode || "",
    plannedToolAction: clean.plannedToolAction || "",
    plannedToolModule: clean.plannedToolModule || "",
    toolStatus: clean.toolStatus || "",
    toolPermissionStatus: clean.toolPermissionStatus || "",
    finalResponseSource: clean.finalResponseSource || "",
    blockedReason: clean.blockedReason || "",
    finalResponseReady: Boolean(clean.finalResponseReady),
    outputChannel: clean.outputChannel || "whatsapp"
  };
}

function hasFinalResponse(finalResponse) {
  if (!finalResponse) return false;
  return Boolean(
    finalResponse.text ||
    finalResponse.responseText ||
    (Array.isArray(finalResponse.messages) && finalResponse.messages.length)
  );
}
