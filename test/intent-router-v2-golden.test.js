import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CASES_FILE = join(process.cwd(), "test", "evals", "intent-router-v2", "real-whatsapp-cases.jsonl");
const EXPECTED_CASE_IDS = [
  "A_audio_simple_list",
  "B_audio_list_plus_reminder",
  "C_incomplete_reminder",
  "D_correction_no_execution",
  "E_meta_question_no_execution",
  "F_uploaded_image_cover_followup",
  "G_generated_image_style_followup",
  "H_crm_search",
  "I_crm_update_disordered_audio",
  "J_crm_delete_requires_strong_confirmation",
  "K_context_switch_pending_reminder_to_image",
  "L_live_chat_no_bot_reply",
  "M_document_existing_request",
  "N_audio_supermaxi_clean_items",
  "O_followup_existing_list_reminder",
  "P_audio_supermaxi_list_plus_reminder",
  "Q_pending_reminder_clarification_answer"
];

test("IntentRouterV2 golden eval file covers the real WhatsApp failure set", () => {
  const cases = readGoldenCases();
  assert.deepEqual(cases.map(function (item) { return item.id; }), EXPECTED_CASE_IDS);

  for (const item of cases) {
    assert.equal(item.userTurn.channel, "whatsapp", item.id);
    assert.ok(item.expected && item.expected.router, item.id + " missing router expectation");
    assert.ok(item.expected && item.expected.policy, item.id + " missing policy expectation");
  }
});

test("IntentRouterV2 plus PolicyGate satisfy golden WhatsApp cases", async (t) => {
  const { routeIntentV2, evaluatePolicyGate } = await loadUnderTest();
  const cases = readGoldenCases();

  for (const item of cases) {
    await t.test(item.id + " - " + item.description, () => {
      const routerResult = routeIntentV2({
        userTurn: item.userTurn,
        conversationState: item.conversationState || {},
        tenantConfig: item.tenantConfig || {},
        now: item.now,
        timezone: item.timezone
      });
      assertRouterResult(routerResult, item.expected.router, item.id);

      const policyDecision = evaluatePolicyGate({
        routerResult: routerResult,
        intentRouterResult: routerResult,
        userTurn: item.userTurn,
        conversationState: item.conversationState || {},
        tenantConfig: item.tenantConfig || {},
        now: item.now,
        timezone: item.timezone
      });
      assertPolicyDecision(policyDecision, item.expected.policy, item.id);
    });
  }
});

async function loadUnderTest() {
  let routerModule;
  let policyModule;

  try {
    routerModule = await import("../src/ai/intentRouterV2.js");
    policyModule = await import("../src/ai/policyGate.js");
  } catch (error) {
    assert.fail(
      "IntentRouterV2/PolicyGate modules are not implemented yet. " +
      "Expected exports: routeIntentV2 from src/ai/intentRouterV2.js and " +
      "evaluatePolicyGate from src/ai/policyGate.js. " +
      "Import error: " + String(error && error.message || error)
    );
  }

  assert.equal(typeof routerModule.routeIntentV2, "function", "routeIntentV2 export must be a function");
  assert.equal(typeof policyModule.evaluatePolicyGate, "function", "evaluatePolicyGate export must be a function");

  return {
    routeIntentV2: routerModule.routeIntentV2,
    evaluatePolicyGate: policyModule.evaluatePolicyGate
  };
}

function readGoldenCases() {
  return readFileSync(CASES_FILE, "utf8")
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(Boolean)
    .map(function (line, index) {
      try {
        return JSON.parse(line);
      } catch (error) {
        assert.fail("Invalid JSONL at " + CASES_FILE + ":" + (index + 1) + " " + String(error.message || error));
      }
    });
}

function assertRouterResult(routerResult, expected, caseId) {
  const router = routerResult || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];

  assert.equal(router.schema_version, "intent_router_v2", caseId + " schema_version");
  assert.equal(router.channel, "whatsapp", caseId + " channel");
  if (expected.conversationMode) {
    assert.equal(router.conversation_mode, expected.conversationMode, caseId + " conversation_mode");
  }
  assert.equal(router.turn_type, expected.turnType, caseId + " turn_type");
  assert.equal(Boolean(router.should_not_execute_tools), expected.shouldNotExecuteTools, caseId + " should_not_execute_tools");
  assert.deepEqual(tasks.map(function (task) { return task.intent; }), expected.taskIntents, caseId + " task intents");

  assertTaskStatuses(tasks, expected.taskStatuses || {}, caseId);
  assertMissingSlots(tasks, expected.missingSlots || {}, caseId);
  assertTaskEntities(tasks, expected.taskEntities || {}, caseId);
  assertDependsOn(tasks, expected.dependsOn || {}, caseId);
  assertSubset(router.references || {}, expected.references || {}, caseId + " references");
  assertSubset(router.state_recommendations || {}, expected.stateRecommendations || {}, caseId + " state_recommendations");

  const reply = router.reply_strategy || {};
  assert.equal(reply.kind, expected.replyStrategyKind, caseId + " reply_strategy.kind");
}

function assertPolicyDecision(policyDecision, expected, caseId) {
  const policy = policyDecision || {};
  const decision = policy.decision || policy.action || policy.kind || "";
  const blockedReasons = normalizeStringArray(policy.blockedReasons || policy.blocked_reasons || policy.reasons || []);
  const toolIntents = extractToolIntents(policy);
  const missingSlots = normalizeStringArray(policy.missingSlots || policy.missing_slots || []);
  const shouldExecuteTools = Boolean(
    policy.shouldExecuteTools !== undefined ? policy.shouldExecuteTools :
      policy.should_execute_tools !== undefined ? policy.should_execute_tools :
        toolIntents.length
  );

  assert.equal(decision, expected.decision, caseId + " policy decision");
  assert.equal(shouldExecuteTools, expected.shouldExecuteTools, caseId + " shouldExecuteTools");
  assert.deepEqual(toolIntents, expected.toolIntents, caseId + " tool intents");
  assert.deepEqual(missingSlots, expected.missingSlots || [], caseId + " missing slots");

  if (expected.shouldSendBotReply !== undefined) {
    const actual = policy.shouldSendBotReply !== undefined ? policy.shouldSendBotReply : policy.should_send_bot_reply;
    assert.equal(Boolean(actual), expected.shouldSendBotReply, caseId + " shouldSendBotReply");
  }
  if (expected.requiresConfirmation !== undefined) {
    const actual = policy.requiresConfirmation !== undefined ? policy.requiresConfirmation : policy.requires_confirmation;
    assert.equal(Boolean(actual), expected.requiresConfirmation, caseId + " requiresConfirmation");
  }
  if (expected.oneQuestionIncludes) {
    const question = getOneQuestion(policy);
    assert.match(normalizeText(question), new RegExp(normalizeText(expected.oneQuestionIncludes)), caseId + " one question");
  }
  for (const reason of expected.blockedReasonsIncludes || []) {
    assert.ok(blockedReasons.includes(reason), caseId + " missing blocked reason " + reason);
  }
  for (const reason of expected.blockedReasonsExcludes || []) {
    assert.equal(blockedReasons.includes(reason), false, caseId + " unexpected blocked reason " + reason);
  }
  if (expected.mustNotAskReupload) {
    assert.doesNotMatch(normalizeText(JSON.stringify(policy)), /reenvi|missing image|missing_image|no tengo la imagen/, caseId + " asks for reupload");
  }
}

function assertTaskStatuses(tasks, statuses, caseId) {
  for (const [intent, status] of Object.entries(statuses)) {
    const task = findTask(tasks, intent);
    assert.ok(task, caseId + " missing task " + intent);
    assert.equal(task.status, status, caseId + " status for " + intent);
  }
}

function assertMissingSlots(tasks, slotsByIntent, caseId) {
  for (const [intent, slots] of Object.entries(slotsByIntent)) {
    const task = findTask(tasks, intent);
    assert.ok(task, caseId + " missing task " + intent);
    assert.deepEqual(normalizeStringArray(task.missing_slots || task.missingSlots || []), slots, caseId + " missing slots for " + intent);
  }
}

function assertTaskEntities(tasks, entitiesByIntent, caseId) {
  for (const [intent, expectedEntities] of Object.entries(entitiesByIntent)) {
    const task = findTask(tasks, intent);
    assert.ok(task, caseId + " missing task " + intent);
    const actual = task.entities || {};
    assertEntitySubset(actual, expectedEntities, caseId + " entities for " + intent);
  }
}

function assertDependsOn(tasks, dependsOn, caseId) {
  for (const [intent, expectedDeps] of Object.entries(dependsOn)) {
    const task = findTask(tasks, intent);
    assert.ok(task, caseId + " missing task " + intent);
    const actualDeps = normalizeStringArray(task.depends_on_task_ids || task.dependsOnTaskIds || []);
    for (const expectedDep of expectedDeps) {
      const depTask = findTask(tasks, expectedDep);
      const acceptedValues = [expectedDep, depTask && (depTask.task_id || depTask.taskId)].filter(Boolean);
      assert.ok(
        acceptedValues.some(function (value) { return actualDeps.includes(value); }),
        caseId + " " + intent + " missing dependency on " + expectedDep
      );
    }
  }
}

function assertEntitySubset(actual, expected, label) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "messageIncludes") {
      const haystack = normalizeText([actual.message, actual.body, actual.title, JSON.stringify(actual)].join(" "));
      for (const value of expectedValue) assert.match(haystack, new RegExp(normalizeText(value)), label + " message includes " + value);
      continue;
    }
    if (key === "notesIncludes") {
      const haystack = normalizeText([actual.notes, actual.note, JSON.stringify(actual)].join(" "));
      for (const value of expectedValue) assert.match(haystack, new RegExp(normalizeText(value)), label + " notes includes " + value);
      continue;
    }
    if (key === "queryIncludes") {
      const haystack = normalizeText([actual.query, actual.title, actual.document_name, actual.documentName, JSON.stringify(actual)].join(" "));
      for (const value of expectedValue) assert.match(haystack, new RegExp(normalizeText(value)), label + " query includes " + value);
      continue;
    }
    const actualValue = getEntityValue(actual, key);
    assert.deepEqual(actualValue, expectedValue, label + " " + key);
  }
}

function assertSubset(actual, expected, label) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    assert.deepEqual(actual[key], expectedValue, label + " " + key);
  }
}

function extractToolIntents(policy) {
  const tools = policy.toolCalls || policy.tool_calls || policy.toolsToExecute || policy.tools_to_execute || policy.plannedTools || policy.planned_tools || [];
  return (Array.isArray(tools) ? tools : [])
    .map(function (tool) { return String(tool.intent || tool.action || tool.type || ""); })
    .filter(Boolean);
}

function getOneQuestion(policy) {
  const reply = policy.replyStrategy || policy.reply_strategy || {};
  return String(policy.oneQuestionToAsk || policy.one_question_to_ask || reply.oneQuestionToAsk || reply.one_question_to_ask || "");
}

function findTask(tasks, intent) {
  return tasks.find(function (task) {
    return task && (task.intent === intent || task.task_id === intent || task.taskId === intent);
  }) || null;
}

function getEntityValue(actual, key) {
  if (Object.prototype.hasOwnProperty.call(actual, key)) return actual[key];
  const snake = key.replace(/[A-Z]/g, function (letter) { return "_" + letter.toLowerCase(); });
  if (Object.prototype.hasOwnProperty.call(actual, snake)) return actual[snake];
  return undefined;
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(Boolean);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
