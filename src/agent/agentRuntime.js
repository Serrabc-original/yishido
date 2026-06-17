import { authorizeAction } from "./actionRegistry.js";
import {
  buildTaskActionFromTurn,
  buildTaskMemoryReadModel,
  executeTaskAction,
  formatTasksForWhatsApp,
  normalizeTaskState
} from "./taskEngine.js";
import { evaluateHandoffPolicy } from "./handoffPolicy.js";
import { logEvent } from "../logger.js";
import { normalizeAgentMemoryReadModels } from "../contracts/assistantContracts.js";

export function buildAgentMemoryReadModels(input) {
  const clean = input || {};
  const data = clean.data || {};
  const coreUtilityState = data.coreUtilityState || {};

  return normalizeAgentMemoryReadModels({
    recentConversation: {
      turnCount: Array.isArray(data.conversationLog) ? data.conversationLog.length : 0,
      summary: data.conversationSummary || null
    },
    userMemory: {
      customerMemory: data.customerMemory || null,
      userStyleProfile: data.userStyleProfile || null
    },
    businessMemory: {
      utilityMemory: data.utilityMemory || null,
      activeList: coreUtilityState.activeList || ""
    },
    longTermMemory: data.longTermMemory || null,
    memoryPolicy: data.memoryPolicy || null,
    clientsLeadsTasks: buildTaskMemoryReadModel({
      tasks: coreUtilityState.tasks || [],
      leads: coreUtilityState.leads || [],
      clients: coreUtilityState.clients || []
    })
  });
}

export function planAgentRuntimeAction(input) {
  const clean = input || {};
  const userTurn = clean.userTurn || {};
  const route = clean.utilityRoute || clean.route || {};
  const action = buildTaskActionFromTurn(userTurn, route, {
    now: clean.now || new Date().toISOString()
  });

  if (!action) return null;
  return action;
}

export function canAgentRuntimeHandle(input) {
  const route = input && (input.utilityRoute || input.route) || {};
  const action = planAgentRuntimeAction(input || {});
  return Boolean(action && ["task", "crm", "crmLite"].includes(route.intent || route.module) || action);
}

export function runAgentRuntime(input) {
  const clean = input || {};
  const data = Object.assign({}, clean.data || {});
  const userTurn = clean.userTurn || {};
  const utilityRoute = clean.utilityRoute || {};
  const traceContext = {
    traceId: userTurn.trace_id || userTurn.traceId || "",
    turnId: userTurn.turn_id || userTurn.turnId || "",
    doName: data.doName || ""
  };
  const planned = clean.action || planAgentRuntimeAction({
    userTurn: userTurn,
    utilityRoute: utilityRoute,
    now: clean.now
  });

  if (!planned) {
    return {
      handled: false,
      data: data,
      action: null,
      result: null,
      responseText: "",
      memoryReadModels: buildAgentMemoryReadModels({ data: data })
    };
  }

  const allowed = authorizeAction(planned, traceContext);
  const handoff = evaluateHandoffPolicy({
    text: userTurn.current_turn_text || "",
    confidence: allowed.confidence,
    action: allowed
  });

  if (allowed.status === "blocked") {
    logEvent("AGENT_RUNTIME_ACTION_BLOCKED", Object.assign({}, traceContext, {
      action: allowed.action,
      reason: allowed.userFacingSummary
    }));
    return {
      handled: true,
      data: data,
      action: allowed,
      result: null,
      responseText: allowed.userFacingSummary || "No pude ejecutar esa accion.",
      handoff: handoff,
      memoryReadModels: buildAgentMemoryReadModels({ data: data })
    };
  }

  const taskState = normalizeTaskState({
    tasks: data.coreUtilityState && data.coreUtilityState.tasks || [],
    leads: data.coreUtilityState && data.coreUtilityState.leads || [],
    clients: data.coreUtilityState && data.coreUtilityState.clients || [],
    metrics: data.coreUtilityState && data.coreUtilityState.taskMetrics || {}
  });
  const result = executeTaskAction(taskState, allowed, {
    now: clean.now || new Date().toISOString()
  });
  const coreUtilityState = Object.assign({}, data.coreUtilityState || {}, {
    tasks: result.state.tasks,
    leads: result.state.leads,
    clients: result.state.clients,
    taskMetrics: result.state.metrics
  });
  const nextData = Object.assign({}, data, {
    coreUtilityState: coreUtilityState
  });

  logEvent("AGENT_RUNTIME_ACTION_EXECUTED", Object.assign({}, traceContext, {
    action: allowed.action,
    ok: result.ok,
    needsHuman: handoff.needsHuman
  }));

  return {
    handled: true,
    data: nextData,
    action: Object.assign({}, allowed, { status: result.ok ? "executed" : "failed" }),
    result: result,
    responseText: result.userFacingSummary || formatTasksForWhatsApp(result.state.tasks),
    handoff: handoff,
    memoryReadModels: buildAgentMemoryReadModels({ data: nextData })
  };
}
