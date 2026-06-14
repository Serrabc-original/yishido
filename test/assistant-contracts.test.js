import test from "node:test";
import assert from "node:assert/strict";
import {
  buildResponsePlan,
  normalizeConversationIdentity,
  normalizeMediaBatchContract,
  normalizeModuleResult,
  normalizeSupervisorDecision,
  normalizeUserTurnContract
} from "../src/contracts/assistantContracts.js";
import { buildRequestContext, buildSupervisorInput } from "../src/context/requestContextManager.js";
import {
  buildWoztellChannelCapabilities,
  buildWoztellConversationIdentity,
  buildWoztellSendAttempts,
  normalizeWoztellMessageEventMeta,
  summarizeWoztellSendPayload
} from "../src/channels/woztellChannelAdapter.js";
import { composeFinalResponse, composeResponsePlan } from "../src/ai/finalResponseComposer.js";
import { createConversationSupervisorPlan } from "../src/supervisor/conversationSupervisor.js";
import { buildTemplateCatalog, buildTemplateMessageDraft, canSendTemplate, getTemplateByPurpose } from "../src/modules/templates/index.js";
import { buildUserTurn, normalizeIncomingMessage } from "../src/index.js";

const basePayload = {
  eventType: "INBOUND",
  type: "IMAGE",
  app: "app_1",
  channel: "channel_1",
  from: "593999111222",
  member: "member_1",
  to: "bot_1"
};

function textMessage(text, messageId) {
  return normalizeIncomingMessage({ type: "TEXT", text }, Object.assign({}, basePayload, { type: "TEXT" }), {
    messageId: messageId || "text_1",
    receivedAt: "2026-06-14T00:00:00.000Z"
  });
}

function imageMessage(fileId, messageId) {
  return normalizeIncomingMessage({ type: "IMAGE", fileId }, basePayload, {
    messageId: messageId || fileId,
    receivedAt: "2026-06-14T00:00:00.000Z"
  });
}

test("assistant contracts normalize UserTurn, media batch and module results", () => {
  const messages = [
    textMessage("Compara estas imagenes", "txt"),
    imageMessage("img_1", "img_1"),
    imageMessage("img_2", "img_2")
  ];
  const turn = buildUserTurn(messages, {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", status: "analyzed" },
      { asset_id: "asset_2", asset_index: 2, file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE", status: "analysis_failed", analysis_error: "timeout" }
    ]
  }, { turnId: "turn_contract" });
  turn.trace_id = "trace_contract";

  const contract = normalizeUserTurnContract(turn);
  const batch = normalizeMediaBatchContract(turn.media_batch);
  const moduleResult = normalizeModuleResult({
    module: "vision",
    ok: true,
    confidence: 0.7,
    text: "Revisé una imagen y otra falló."
  });

  assert.equal(contract.turnId, "turn_contract");
  assert.equal(contract.traceId, "trace_contract");
  assert.equal(contract.mediaBatch.assetCount, 2);
  assert.equal(batch.failedAssetCount, 1);
  assert.equal(moduleResult.module, "vision");
  assert.equal(moduleResult.userFacingSummary.includes("falló"), true);
});

test("request context manager builds compact context without raw history", () => {
  const turn = buildUserTurn([textMessage("Como funciona un motor de induccion?", "tech")], {}, { turnId: "turn_ctx" });
  turn.trace_id = "trace_ctx";
  const requestContext = buildRequestContext({
    userTurn: turn,
    activeContext: { activeIntent: "price_review", contextId: "ctx_old", lastUserGoal: "comparar precios" },
    recentConversationWindow: Array.from({ length: 16 }, (_, index) => ({
      turnId: "turn_" + index,
      type: "text",
      summary: "x".repeat(900)
    })),
    conversationSummary: { summary: "compact" },
    customerMemory: { name: "Mateo", token: "secret" },
    utilityMemory: { reminder_count: 1 }
  });
  const supervisorInput = buildSupervisorInput({
    userTurn: turn,
    requestContext,
    supervisorConfig: { model: "gpt-5.4-mini" }
  });

  assert.equal(requestContext.orchestrationPolicy.sendRawHistory, false);
  assert.equal(requestContext.recentConversationWindow.length, 12);
  assert.equal(requestContext.recentConversationWindow[0].summary.length, 500);
  assert.equal(supervisorInput.requestContext.contextId, "ctx_old");
  assert.equal(supervisorInput.recentConversationWindow.length, 12);
});

test("supervisor decision exposes stable v2 contract fields", () => {
  const plan = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("Recuerdame manana a las 9 llamar a Juan", "rem")], {}, { turnId: "turn_rem" }),
    recentConversationWindow: [],
    activeContext: { activeIntent: "general" }
  });
  const decision = normalizeSupervisorDecision(plan);

  assert.equal(plan.intent, "reminder");
  assert.equal(plan.shouldWaitForMoreInputs, false);
  assert.equal(plan.toolPlan.actions.length, 0);
  assert.equal(plan.memoryPolicy.sensitiveDataAllowed, false);
  assert.equal(decision.responseStrategy, "create_utility_then_confirm");
});

test("final response composer emits a channel-ready response plan", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "general", mediaScope: "none" },
    specialistResults: { text: "Hola. Puedo ayudarte con preguntas, fotos, audios, listas y recordatorios." },
    currentUserMessage: "hola",
    trace: { traceId: "trace_resp", turnId: "turn_resp", doName: "channel:user" }
  });
  const responsePlan = composeResponsePlan({
    text: "Uno.\n\nDos.",
    supervisorPlan: { intent: "general" },
    traceId: "trace_resp",
    turnId: "turn_resp"
  });

  assert.equal(response.responsePlan.messages[0].type, "TEXT");
  assert.equal(response.responsePlan.trace.traceId, "trace_resp");
  assert.equal(responsePlan.messages.length, 1);
  assert.equal(buildResponsePlan({ text: "Listo" }).messages[0].text, "Listo");
});

test("Woztell channel adapter keeps channel role separate from brain", () => {
  const identity = buildWoztellConversationIdentity(basePayload);
  const meta = normalizeWoztellMessageEventMeta(Object.assign({}, basePayload, {
    messageId: "msg_1",
    data: { text: "hola" }
  }));
  const attempts = buildWoztellSendAttempts({
    channelId: "channel_1",
    memberId: "member_1",
    recipientId: "593999111222",
    appId: "app_1",
    response: [{ type: "TEXT", text: "hola" }]
  });
  const summary = summarizeWoztellSendPayload(attempts[0].payload, attempts[0].mode);
  const capabilities = buildWoztellChannelCapabilities({ ENABLE_TEMPLATE_MODULE: "true" });

  assert.equal(identity.channelId, "channel_1");
  assert.equal(identity.memberId, "member_1");
  assert.equal(meta.messageEvent.hasText, true);
  assert.equal(attempts[0].mode, "memberId");
  assert.equal(Object.hasOwn(attempts[0].payload, "recipientId"), false);
  assert.equal(summary.responseTypes[0], "TEXT");
  assert.equal(capabilities.brainLocation, "worker");
});

test("template catalog blocks safely when template is not configured", () => {
  const emptyCatalog = buildTemplateCatalog({});
  const configured = getTemplateByPurpose({
    REMINDER_TEMPLATE_NAME: "reminder_due",
    REMINDER_TEMPLATE_LANGUAGE: "es"
  }, "reminder_due_outside_24h");
  const blockedDraft = buildTemplateMessageDraft({
    template: emptyCatalog[0],
    params: ["comprar leche"]
  });
  const sendableDraft = buildTemplateMessageDraft({
    template: configured,
    params: ["comprar leche"]
  });

  assert.equal(emptyCatalog[0].approvalStatus, "not_configured");
  assert.equal(blockedDraft.enabled, false);
  assert.equal(canSendTemplate(configured), true);
  assert.equal(sendableDraft.enabled, true);
  assert.equal(sendableDraft.templateName, "reminder_due");
});
