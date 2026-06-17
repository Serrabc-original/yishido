import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIntentRouterV2TurnDecision,
  summarizeIntentRouterV2Decision
} from "../src/ai/intentRouterV2Pipeline.js";

const ENABLED_ENV = {
  INTENT_ROUTER_V2_ENABLED: "true",
  POLICY_GATE_ENABLED: "true",
  REPLY_COMPOSER_V2_ENABLED: "true"
};

test("IntentRouterV2 pipeline stays off unless all feature flags are enabled", () => {
  const decision = buildIntentRouterV2TurnDecision({
    env: { INTENT_ROUTER_V2_ENABLED: "true" },
    userTurn: { channel: "whatsapp", combinedUserText: "Hazme una lista de leche y pan" }
  });

  assert.equal(decision.enabled, false);
  assert.equal(decision.handled, false);
  assert.equal(decision.shouldContinueLegacyFlow, true);
});

test("IntentRouterV2 pipeline handles correction before legacy tools", () => {
  const decision = buildIntentRouterV2TurnDecision({
    env: ENABLED_ENV,
    userTurn: {
      channel: "whatsapp",
      combinedUserText: "No no te estoy preguntando en cuantos minutos me vas a hacer acuerdo"
    }
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.handled, true);
  assert.equal(decision.shouldSend, true);
  assert.equal(decision.shouldContinueLegacyFlow, false);
  assert.equal(decision.policyDecision.shouldExecuteTools, false);
  assert.match(decision.reply.text, /No voy a crear nada/);
});

test("IntentRouterV2 pipeline handles simple list as reply-only", () => {
  const decision = buildIntentRouterV2TurnDecision({
    env: ENABLED_ENV,
    userTurn: {
      channel: "whatsapp",
      combinedUserText: "Hazme una lista de leche, pan y huevos"
    }
  });

  assert.equal(decision.handled, true);
  assert.equal(decision.policyDecision.decision, "reply_only");
  assert.match(decision.reply.text, /1\. Leche/);
  assert.match(decision.reply.text, /3\. Huevos/);
});

test("IntentRouterV2 pipeline defers real tool execution to existing flow", () => {
  const decision = buildIntentRouterV2TurnDecision({
    env: ENABLED_ENV,
    userTurn: {
      channel: "whatsapp",
      combinedUserText: "Hazme una lista de leche, pan y huevos y recuerdamela en dos horas"
    }
  });

  assert.equal(decision.enabled, true);
  assert.equal(decision.handled, false);
  assert.equal(decision.shouldContinueLegacyFlow, true);
  assert.equal(decision.policyDecision.shouldExecuteTools, true);
  assert.deepEqual(decision.policyDecision.toolCalls.map(function (tool) { return tool.intent; }), ["reminder.create"]);
});

test("IntentRouterV2 pipeline summarizes decisions without raw user text", () => {
  const decision = buildIntentRouterV2TurnDecision({
    env: ENABLED_ENV,
    userTurn: {
      channel: "whatsapp",
      combinedUserText: "Actualiza este cliente con correo mateo@test.com"
    }
  });
  const summary = summarizeIntentRouterV2Decision(decision);

  assert.equal(summary.enabled, true);
  assert.equal(summary.handled, true);
  assert.equal(summary.policyDecision, "ask_confirmation");
  assert.deepEqual(summary.taskIntents, ["crm.update"]);
  assert.equal(JSON.stringify(summary).includes("mateo@test.com"), false);
});
