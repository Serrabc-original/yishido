import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCopywriterPrompt,
  buildImagePrompt,
  buildOrchestratorInstruction,
  buildVisionPromptText
} from "../src/index.js";
import { listAgents } from "../src/agents/agentRegistry.js";
import { buildCustomerReplyPromptPayload } from "../src/ai/customerReplyComposer.js";

test("orchestrator prompt enforces structured intent and no direct reply", () => {
  const prompt = buildOrchestratorInstruction();

  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /Do not answer the user directly/);
  assert.match(prompt, /correction/);
  assert.match(prompt, /meta-question/);
  assert.match(prompt, /multi_intent_request/);
  assert.match(prompt, /image_followup/);
  assert.match(prompt, /live_chat/);
  assert.match(prompt, /Do not trigger reminders or lists from keywords alone/);
});

test("customer reply prompt is a final composer, not a tool planner", () => {
  const payload = buildCustomerReplyPromptPayload({
    userTurn: { turn_id: "turn_prompt", combinedUserText: "Hazme acuerdo de la lista", image_count: 0 },
    intent: "reminder",
    systemResult: { text: "" },
    policyDecision: { decision: "ask_clarification" },
    missingSlots: ["due_at"],
    shouldSendBotReply: false
  });
  const rules = payload.non_negotiable_rules.join("\n");

  assert.match(rules, /No decides herramientas/);
  assert.match(rules, /Si falta un dato, pregunta solo ese dato/);
  assert.match(rules, /live chat, no generes mensaje/);
  assert.equal(payload.system_decision_context.decision, "ask_clarification");
  assert.deepEqual(payload.system_decision_context.missingSlots, ["due_at"]);
  assert.equal(payload.system_decision_context.shouldSendBotReply, false);
});

test("vision prompt extracts facts without marketing by default", () => {
  const prompt = buildVisionPromptText({ caption: "Que es esto?" });

  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /Do not invent/);
  assert.match(prompt, /Do not identify real people by name/);
  assert.match(prompt, /Marketing is not the default/);
  assert.match(prompt, /Use the existing backend schema exactly/);
});

test("copywriter prompt is restricted to commercial copy", () => {
  const prompt = buildCopywriterPrompt({
    brief: "Post para Instagram",
    messages: []
  }, {}, false);

  assert.match(prompt, /copy comercial/);
  assert.match(prompt, /No manejes listas personales, recordatorios, CRM/);
  assert.match(prompt, /No inventes precios/);
});

test("image prompt preserves source assets and blocks bad text", () => {
  const prompt = buildImagePrompt("Portada neon", {
    last_uploaded_image: { fileId: "img_1" },
    uploaded_image_analysis: { main_subject: "insecto sobre piso", confidence: 0.9 },
    last_copy: "LONG SIGNAL"
  });

  assert.match(prompt, /source image/i);
  assert.match(prompt, /Do not ask for a new image/);
  assert.match(prompt, /no unreadable microtext/);
  assert.match(prompt, /no fake contact info/);
});

test("specialist prompts include V2 safety boundaries", () => {
  const agents = listAgents({});
  const reminder = agents.find((agent) => agent.name === "reminder");
  const image = agents.find((agent) => agent.name === "image_generation");
  const price = agents.find((agent) => agent.name === "price_review");

  assert.match(reminder.systemPrompt, /fecha\/hora claros/);
  assert.match(reminder.systemPrompt, /No uses titulos genericos/);
  assert.match(image.systemPrompt, /Usa assets existentes/);
  assert.match(image.systemPrompt, /nunca publiques en Meta/);
  assert.match(price.systemPrompt, /todas las imagenes del batch/);
});
