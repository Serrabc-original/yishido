import test from "node:test";
import assert from "node:assert/strict";
import { authorizeAction, getRegisteredAction, listRegisteredActions } from "../src/agent/actionRegistry.js";
import {
  buildTaskActionFromTurn,
  executeTaskAction,
  formatTasksForWhatsApp,
  normalizeTaskState
} from "../src/agent/taskEngine.js";
import { runAgentRuntime, buildAgentMemoryReadModels } from "../src/agent/agentRuntime.js";
import { buildIntentToolResponsePipeline, summarizePipelineForLog } from "../src/agent/intentToolResponsePipeline.js";
import {
  buildAgentExecutionPlan,
  buildPipelineDescriptorFromExecution,
  runAgentExecutionPlan,
  summarizeAgentExecutionPlan
} from "../src/agent/agentOrchestrationPipeline.js";
import { evaluateHandoffPolicy } from "../src/agent/handoffPolicy.js";
import { normalizeActionContract, normalizeTaskContract } from "../src/contracts/assistantContracts.js";
import { routeCoreUtilityIntent } from "../src/coreUtilityRouter.js";

test("action and task contracts normalize strict internal JSON shapes", () => {
  const action = normalizeActionContract({
    type: "create_task",
    entities: { title: "llamar cliente" },
    confidence: 2
  });
  const task = normalizeTaskContract({
    id: "task_1",
    type: "call",
    status: "open",
    title: "llamar cliente",
    mediaRefs: { fileIds: ["img_1"], assetIds: ["asset_1"] }
  });

  assert.equal(action.action, "create_task");
  assert.equal(action.module, "tasks");
  assert.equal(action.confidence, 1);
  assert.equal(task.taskId, "task_1");
  assert.deepEqual(task.mediaRefs.fileIds, ["img_1"]);
});

test("action registry allows registered actions and blocks unknown actions", () => {
  const allowed = authorizeAction({ action: "create_task", module: "tasks", confidence: 0.8 }, {});
  const blocked = authorizeAction({ action: "publish_to_meta", module: "marketing", confidence: 0.8 }, {});

  assert.equal(getRegisteredAction("create_task").module, "tasks");
  assert.equal(listRegisteredActions().some((item) => item.action === "save_lead"), true);
  assert.equal(allowed.status, "allowed");
  assert.equal(blocked.status, "blocked");
});

test("task engine creates, updates, pauses, closes and formats tasks", () => {
  let state = normalizeTaskState({});
  const created = executeTaskAction(state, {
    action: "create_task",
    entities: { title: "llamar a cliente", type: "call", dueAt: "2026-06-17T10:00:00.000Z" }
  }, { now: "2026-06-16T12:00:00.000Z" });
  state = created.state;
  const updated = executeTaskAction(state, {
    action: "update_task",
    entities: { taskId: created.task.taskId, title: "llamar a cliente VIP", priority: "high" }
  }, { now: "2026-06-16T12:01:00.000Z" });
  state = updated.state;
  const paused = executeTaskAction(state, {
    action: "pause_task",
    entities: { taskId: created.task.taskId }
  }, { now: "2026-06-16T12:02:00.000Z" });
  state = paused.state;
  const closed = executeTaskAction(state, {
    action: "close_task",
    entities: { taskId: created.task.taskId }
  }, { now: "2026-06-16T12:03:00.000Z" });

  assert.equal(created.ok, true);
  assert.equal(updated.task.priority, "high");
  assert.equal(paused.task.status, "paused");
  assert.equal(closed.task.status, "closed");
  assert.match(formatTasksForWhatsApp(state.tasks), /llamar a cliente VIP/);
});

test("runtime creates task from user turn and stores media refs from campaign assets", () => {
  const userTurn = {
    turn_id: "turn_task",
    trace_id: "trace_task",
    current_turn_text: "Revisa estas fotos y haz seguimiento manana",
    image_count: 2,
    media_batch: {
      fileIds: ["img_1", "img_2"],
      assets: [
        { asset_id: "asset_1", file_id: "img_1", status: "analyzed" },
        { asset_id: "asset_2", file_id: "img_2", status: "analysis_failed" }
      ]
    }
  };
  const route = routeCoreUtilityIntent(userTurn);
  const action = buildTaskActionFromTurn(userTurn, route, { now: "2026-06-16T12:00:00.000Z" });
  const result = runAgentRuntime({
    data: { doName: "channel:user", coreUtilityState: {} },
    userTurn,
    utilityRoute: route,
    now: "2026-06-16T12:00:00.000Z"
  });

  assert.equal(route.intent, "task");
  assert.equal(action.action, "create_task");
  assert.equal(result.handled, true);
  assert.equal(result.data.coreUtilityState.tasks.length, 1);
  assert.deepEqual(result.data.coreUtilityState.tasks[0].mediaRefs.fileIds, ["img_1", "img_2"]);
  assert.match(result.responseText, /cre[eé] la tarea/i);
});

test("runtime saves leads and builds compact memory read models", () => {
  const userTurn = {
    current_turn_text: "Guarda este lead Juan Perez para seguimiento",
    media_batch: { assets: [], fileIds: [] }
  };
  const route = routeCoreUtilityIntent(userTurn);
  const result = runAgentRuntime({
    data: { coreUtilityState: {} },
    userTurn,
    utilityRoute: route,
    now: "2026-06-16T12:00:00.000Z"
  });
  const memory = buildAgentMemoryReadModels({ data: result.data });

  assert.equal(result.data.coreUtilityState.leads.length, 1);
  assert.equal(memory.clientsLeadsTasks.leadCount, 1);
});

test("intent tool response pipeline summarizes route and runtime action", () => {
  const pipeline = buildIntentToolResponsePipeline({
    stage: "tool_execution_done",
    userTurn: { turn_id: "turn_1", trace_id: "trace_1" },
    utilityRoute: { intent: "task", shouldHandleInCore: true, responseStrategy: "create_utility_then_confirm" },
    executionPlan: {
      executionMode: "agent_runtime",
      toolPermission: { status: "allowed" },
      finalResponsePolicy: { source: "tool_runtime_result" }
    },
    runtimeResult: {
      action: { action: "create_task", module: "tasks", status: "executed" },
      responseText: "Listo."
    },
    finalResponse: { responseText: "Listo." }
  });
  const summary = summarizePipelineForLog(pipeline);

  assert.equal(summary.stage, "tool_execution_done");
  assert.equal(summary.intent, "task");
  assert.equal(summary.plannedToolAction, "create_task");
  assert.equal(summary.toolStatus, "executed");
  assert.equal(summary.executionMode, "agent_runtime");
  assert.equal(summary.toolPermissionStatus, "allowed");
  assert.equal(summary.finalResponseSource, "tool_runtime_result");
  assert.equal(summary.finalResponseReady, true);
  assert.equal(pipeline.allowedToolActions.includes("create_task"), true);
});

test("agent execution plan classifies core utilities, vision, runtime tools and orchestrator", () => {
  const listRoute = routeCoreUtilityIntent({ current_turn_text: "Agrega arroz a la lista" }, {
    flags: { enableLists: true }
  });
  const visionRoute = routeCoreUtilityIntent({
    current_turn_text: "Que tal esta imagen?",
    image_count: 1,
    media_batch: { assets: [{ file_id: "img_1" }], fileIds: ["img_1"] }
  });
  const taskRoute = routeCoreUtilityIntent({ current_turn_text: "Haz seguimiento manana a este cliente" });
  const generalRoute = routeCoreUtilityIntent({ current_turn_text: "Hola, como estas?" });
  const listPlan = buildAgentExecutionPlan({ userTurn: { turn_id: "turn_list" }, utilityRoute: listRoute });
  const visionPlan = buildAgentExecutionPlan({ userTurn: { turn_id: "turn_img" }, utilityRoute: visionRoute });
  const taskPlan = buildAgentExecutionPlan({
    userTurn: { turn_id: "turn_task", current_turn_text: "Haz seguimiento manana a este cliente" },
    utilityRoute: taskRoute,
    now: "2026-06-16T12:00:00.000Z"
  });
  const generalPlan = buildAgentExecutionPlan({ userTurn: { turn_id: "turn_gen" }, utilityRoute: generalRoute });

  assert.equal(listPlan.executionMode, "core_utility");
  assert.equal(listPlan.toolPlan.actions[0].action, "update_list");
  assert.equal(visionPlan.executionMode, "vision_utility");
  assert.equal(visionPlan.toolPlan.actions[0].module, "vision");
  assert.equal(taskPlan.executionMode, "agent_runtime");
  assert.equal(taskPlan.toolPermission.status, "allowed");
  assert.equal(taskPlan.toolPlan.actions[0].action, "create_task");
  assert.equal(generalPlan.executionMode, "orchestrator");
  assert.equal(generalPlan.finalResponsePolicy.source, "orchestrator_plan");
});

test("agent execution plan runs runtime tools and returns a response plan", () => {
  const userTurn = {
    turn_id: "turn_exec",
    trace_id: "trace_exec",
    current_turn_text: "Haz seguimiento manana a este cliente",
    media_batch: { assets: [], fileIds: [] }
  };
  const route = routeCoreUtilityIntent(userTurn);
  const executionPlan = buildAgentExecutionPlan({
    data: { doName: "channel:user" },
    userTurn,
    utilityRoute: route,
    now: "2026-06-16T12:00:00.000Z"
  });
  const execution = runAgentExecutionPlan({
    data: { doName: "channel:user", coreUtilityState: {} },
    userTurn,
    utilityRoute: route,
    executionPlan,
    now: "2026-06-16T12:00:00.000Z"
  });
  const summary = summarizeAgentExecutionPlan(executionPlan);
  const descriptor = buildPipelineDescriptorFromExecution({
    stage: "tool_execution_done",
    userTurn,
    utilityRoute: route,
    executionPlan,
    runtimeResult: execution.runtimeResult,
    finalResponse: execution.finalResponse
  });

  assert.equal(execution.handled, true);
  assert.equal(execution.runtimeResult.action.status, "executed");
  assert.equal(execution.finalResponse.messages[0].type, "TEXT");
  assert.equal(summary.executionMode, "agent_runtime");
  assert.equal(descriptor.finalResponseReady, true);
});

test("handoff policy flags sensitive or low confidence turns without forcing handoff", () => {
  const policy = evaluateHandoffPolicy({
    text: "cliente molesto pide humano y mando cedula",
    confidence: 0.3
  });

  assert.equal(policy.needsHuman, true);
  assert.equal(policy.defaultBehavior, "flag_only");
  assert.equal(policy.reasons.includes("user_requested_human"), true);
  assert.equal(policy.reasons.includes("low_confidence"), true);
});
