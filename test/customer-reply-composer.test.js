import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { composeCustomerReply } from "../src/ai/customerReplyComposer.js";
import { getCustomerReplyModel } from "../src/ai/modelRegistry.js";

test("Customer Reply Composer humanizes without inventing", () => {
  const reply = composeCustomerReply({
    userTurn: {
      turn_id: "turn_1",
      combinedUserText: "Como funciona un motor de induccion?",
      image_count: 1
    },
    intent: "general",
    systemResult: {
      text: "Análisis visual: Entendido. Un motor de induccion usa un campo magnetico para mover el rotor."
    }
  }, {});

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /motor de induccion/);
  assert.doesNotMatch(reply.text, /Análisis visual|Analisis visual|que quieres hacer/i);
});

test("Customer Reply Composer asks useful clarification only when image has no intent", () => {
  const reply = composeCustomerReply({
    userTurn: { turn_id: "turn_img", image_count: 1, combinedUserText: "" },
    intent: "unknown_image_request",
    systemResult: { text: "" }
  }, {});

  assert.match(reply.text, /Recibi la imagen/);
  assert.match(reply.text, /analice|lea texto|compare/);
});

test("CUSTOMER_REPLY_MODEL prefers gpt-4.1-mini and falls back to configured mini", () => {
  assert.equal(getCustomerReplyModel({}), "gpt-4.1-mini");
  assert.equal(getCustomerReplyModel({ CUSTOMER_REPLY_MODEL: "bad-model", FINAL_RESPONSE_MODEL: "gpt-5.4-mini" }), "gpt-5.4-mini");
});

test("Customer Reply Composer blocks secret-like output", () => {
  const reply = composeCustomerReply({
    systemResult: { text: "OPENAI_API_KEY=abc123" }
  }, {});

  assert.equal(reply.shouldSend, false);
});

test("Customer Reply Composer replaces generic menu when user request is clear", () => {
  const reply = composeCustomerReply({
    userTurn: {
      turn_id: "turn_clear",
      combinedUserText: "Que opinas de este libro y que ingredientes le pongo al aguacate molido?"
    },
    intent: "general",
    systemResult: {
      text: "¿Quieres que lo explique, lo resuma o revise algún detalle puntual?"
    }
  }, {});

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /libro/i);
  assert.match(reply.text, /aguacate/i);
  assert.doesNotMatch(reply.text, /quieres que lo explique|revise/i);
});

test("Customer Reply Composer uses reception style for appointment requests", () => {
  const reply = composeCustomerReply({
    userTurn: {
      turn_id: "turn_cita",
      combinedUserText: "Hola buenas, quiero agendar una cita para manana"
    },
    intent: "general",
    systemResult: {
      text: "¿Quieres que lo explique, lo resuma o revise algún detalle puntual?"
    }
  }, {});

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /cita/i);
  assert.match(reply.text, /dia|hora|nombre|servicio/i);
  assert.doesNotMatch(reply.text, /quieres que lo explique|resuma/i);
});

test("Conversation style profile JSON is visible and product-editable", () => {
  const profile = JSON.parse(readFileSync(new URL("../docs/CONVERSATION_STYLE_PROFILE.json", import.meta.url), "utf8"));

  assert.equal(profile.id, "whatsapp_reception_v1");
  assert.equal(profile.source.conversationFiles, 9);
  assert.equal(profile.priorities.includes("answer_the_clear_request_first"), true);
  assert.equal(profile.replyRules.some((rule) => /appointment|cita|date|time/i.test(rule)), true);
});
