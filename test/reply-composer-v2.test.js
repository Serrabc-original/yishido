import test from "node:test";
import assert from "node:assert/strict";
import { routeIntentV2 } from "../src/ai/intentRouterV2.js";
import { evaluatePolicyGate } from "../src/ai/policyGate.js";
import { composeReplyV2 } from "../src/ai/replyComposerV2.js";

test("ReplyComposerV2 formats a simple list without storing it", () => {
  const reply = composeFromTurn({
    combinedUserText: "Hazme una lista de comida de gatito, leche, pan, agua y harina",
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /Listo/);
  assert.match(reply.text, /1\. Comida de gatito/);
  assert.match(reply.text, /5\. Harina/);
  assert.doesNotMatch(reply.text, /recordatorio|te lo recuerdo/i);
});

test("ReplyComposerV2 confirms list plus reminder in one warm reply", () => {
  const reply = composeFromTurn({
    combinedUserText: "Hazme una lista de leche, pan y huevos y recuerdamela en dos horas",
    audio_count: 1,
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /te la recuerdo en 2 horas/i);
  assert.match(reply.text, /1\. Leche/);
  assert.match(reply.text, /3\. Huevos/);
});

test("ReplyComposerV2 asks only the missing reminder time", () => {
  const reply = composeFromTurn({
    combinedUserText: "Hazme acuerdo de la lista de compras",
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(normalize(reply.text), /cuando quieres que te recuerde/);
  assert.equal((reply.text.match(/\?/g) || []).length, 1);
});

test("ReplyComposerV2 repairs correction without executing anything", () => {
  const reply = composeFromTurn({
    combinedUserText: "No no te estoy preguntando en cuantos minutos me vas a hacer acuerdo",
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(normalize(reply.text), /tienes razon/);
  assert.match(normalize(reply.text), /no voy a crear nada/);
});

test("ReplyComposerV2 uses available uploaded image for cover followup", () => {
  const reply = composeFromTurn({
    combinedUserText: "Portada",
    channel: "whatsapp"
  }, {
    last_uploaded_image: { asset_id: "img_1" }
  });

  assert.equal(reply.shouldSend, true);
  assert.match(normalize(reply.text), /uso la imagen/);
  assert.match(normalize(reply.text), /portada/);
  assert.doesNotMatch(normalize(reply.text), /reenvi|mandamela|no tengo la imagen/);
});

test("ReplyComposerV2 asks for client identity before ambiguous CRM update", () => {
  const reply = composeFromTurn({
    combinedUserText: "Actualiza este cliente con correo mateo@test.com telefono 0999999999 y nota interesado en soporte",
    audio_count: 1,
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(normalize(reply.text), /que cliente quieres actualizar/);
  assert.doesNotMatch(normalize(reply.text), /lo guardo asi/);
  assert.equal((reply.text.match(/\?/g) || []).length, 1);
});

test("ReplyComposerV2 summarizes identified CRM update and asks confirmation", () => {
  const reply = composeFromTurn({
    combinedUserText: "Actualiza el cliente Juan Perez con correo mateo@test.com telefono 0999999999 y nota interesado en soporte",
    audio_count: 1,
    channel: "whatsapp"
  });

  assert.equal(reply.shouldSend, true);
  assert.match(reply.text, /mateo@test\.com/);
  assert.match(reply.text, /0999999999/);
  assert.match(normalize(reply.text), /lo guardo asi/);
});

test("ReplyComposerV2 stays silent in live chat mode", () => {
  const reply = composeFromTurn({
    combinedUserText: "Hola",
    channel: "whatsapp"
  }, {
    conversation_mode: "live_chat"
  });

  assert.equal(reply.shouldSend, false);
  assert.equal(reply.text, "");
});

function composeFromTurn(userTurn, conversationState) {
  const routerResult = routeIntentV2({
    userTurn: userTurn,
    conversationState: conversationState || {},
    tenantConfig: {}
  });
  const policyDecision = evaluatePolicyGate({
    routerResult: routerResult,
    userTurn: userTurn,
    conversationState: conversationState || {},
    tenantConfig: {}
  });

  return composeReplyV2({
    routerResult: routerResult,
    policyDecision: policyDecision,
    userTurn: userTurn,
    conversationState: conversationState || {},
    tenantConfig: {}
  });
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
