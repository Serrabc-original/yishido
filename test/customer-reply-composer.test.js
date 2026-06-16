import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildCustomerReplyPromptPayload, composeCustomerReply } from "../src/ai/customerReplyComposer.js";
import { getCustomerReplyModel } from "../src/ai/modelRegistry.js";
import { parseCustomerReplyModelOutput } from "../src/index.js";

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

test("Customer reply model JSON output is parsed as visible text", () => {
  const parsed = parseCustomerReplyModelOutput('{"text":"Claro, reviso las imagenes.","shouldSend":true}');
  const whatsappLeak = parseCustomerReplyModelOutput('{"text":"Listo, te lo recuerdo en 20 minutos para llamar al cliente.","shouldSend":true}');

  assert.equal(parsed.text, "Claro, reviso las imagenes.");
  assert.equal(parsed.shouldSend, true);
  assert.equal(whatsappLeak.text, "Listo, te lo recuerdo en 20 minutos para llamar al cliente.");
  assert.equal(whatsappLeak.shouldSend, true);
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

test("Customer Reply Composer prompt exposes final WhatsApp response contract", () => {
  const payload = buildCustomerReplyPromptPayload({
    userTurn: {
      turn_id: "turn_prompt",
      combinedUserText: "Hazme una imagen de un desayuno saludable",
      image_count: 0,
      audio_count: 0
    },
    intent: "image_generation",
    supervisorPlan: {
      intent: "image_generation",
      targetModules: ["image_generation", "general_llm"],
      responseStrategy: "execute_then_confirm"
    },
    systemResult: {
      text: "La imagen esta en proceso."
    },
    nextAction: "generate_image"
  });

  assert.equal(payload.role, "customer_reply_composer");
  assert.equal(payload.output_contract.schema.text, "string");
  assert.equal(payload.routing_context.intent, "image_generation");
  assert.equal(payload.non_negotiable_rules.some((rule) => /No digas que no puedes generar imagenes/i.test(rule)), true);
});

test("Customer Reply Composer handles multiple image clarification as a batch", () => {
  const reply = composeCustomerReply({
    userTurn: { turn_id: "turn_imgs", image_count: 3, combinedUserText: "" },
    intent: "unknown_image_request",
    systemResult: { text: "" }
  }, {});

  assert.match(reply.text, /imagenes/i);
  assert.match(reply.text, /compare|texto visible|detalle/i);
});

test("Customer Reply Composer preserves multi-image evidence instead of generic clarification", () => {
  const reply = composeCustomerReply({
    userTurn: { turn_id: "turn_imgs", image_count: 3, combinedUserText: "esas son" },
    intent: "image_ocr",
    systemResult: { text: "Claro, te ayudo con eso. Puedo analizarla, extraer el texto o compararla con otra imagen. ¿Qué necesitas exactamente?" },
    visibleFacts: [
      { visibleText: "Texto de la primera captura" },
      { visibleText: "Texto de la segunda captura" },
      { visibleText: "Texto de la tercera captura" }
    ]
  }, {});

  assert.match(reply.text, /Imagen 1/i);
  assert.match(reply.text, /Imagen 2/i);
  assert.match(reply.text, /Imagen 3/i);
  assert.doesNotMatch(reply.text, /Qué necesitas exactamente|que necesitas exactamente/i);
});

test("Customer Reply Composer replaces singular batch summary with per-image evidence", () => {
  const reply = composeCustomerReply({
    userTurn: { turn_id: "turn_imgs_singular", image_count: 3, combinedUserText: "" },
    intent: "image_question",
    systemResult: { text: "Veo una captura de una conversacion de WhatsApp y te puedo ayudar con esa imagen." },
    visibleFacts: [
      { visibleText: "Primera captura con CRM" },
      { visibleText: "Segunda captura con anuncio" },
      { visibleText: "Tercera captura con chat" }
    ]
  }, {});

  assert.match(reply.text, /Imagen 1/i);
  assert.match(reply.text, /Imagen 2/i);
  assert.match(reply.text, /Imagen 3/i);
  assert.doesNotMatch(reply.text, /Veo una captura/i);
});

test("Customer Reply Composer preserves OCR text that looks like assistant stance", () => {
  const reply = composeCustomerReply({
    userTurn: {
      turn_id: "turn_ocr",
      combinedUserText: "Lee el texto visible de esta imagen",
      image_count: 1
    },
    intent: "image_ocr",
    systemResult: {
      text: "Texto visible: No veo ninguna imagen adjunta en este turno. Puedes reenviarla?"
    }
  }, {});

  assert.match(reply.text, /Texto visible/i);
  assert.match(reply.text, /No veo ninguna imagen adjunta/i);
  assert.doesNotMatch(reply.text, /Voy a tomar tu mensaje como la instruccion principal/i);
});

test("CUSTOMER_REPLY_MODEL prefers gpt-4.1-mini and falls back to configured mini", () => {
  assert.equal(getCustomerReplyModel({}), "gpt-4.1-mini");
  assert.equal(getCustomerReplyModel({ CUSTOMER_REPLY_MODEL: "bad-model", FINAL_RESPONSE_MODEL: "gpt-5.4-mini" }), "gpt-5.4-mini");
  assert.equal(getCustomerReplyModel({ CUSTOMER_REPLY_MODEL: "gpt-5.4" }), "gpt-5.4");
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
