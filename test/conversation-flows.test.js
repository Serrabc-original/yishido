import test from "node:test";
import assert from "node:assert/strict";
import {
  composeFinalResponse,
  composeGeneralTextAnswer
} from "../src/ai/finalResponseComposer.js";
import {
  createConversationSupervisorPlan,
  generateFinalUserResponse
} from "../src/supervisor/conversationSupervisor.js";
import {
  buildUserTurn,
  normalizeIncomingMessage
} from "../src/index.js";

const basePayload = {
  type: "TEXT",
  app: "app",
  channel: "channel",
  from: "user",
  to: "bot"
};

function textMessage(text, messageId) {
  return normalizeIncomingMessage({ type: "TEXT", text }, basePayload, {
    messageId: messageId || "text",
    receivedAt: "2026-06-14T12:00:00.000Z"
  });
}

function imageMessage(fileId, messageId) {
  return normalizeIncomingMessage({ type: "IMAGE", fileId }, Object.assign({}, basePayload, { type: "IMAGE" }), {
    messageId: messageId || fileId,
    receivedAt: "2026-06-14T12:00:01.000Z"
  });
}

function planTurn(messages, campaignState, recentConversationWindow, activeContext, turnId, activeTask) {
  const turn = buildUserTurn(messages, campaignState || {}, { turnId: turnId || "turn_flow" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: recentConversationWindow || [],
    activeContext: activeContext || {},
    activeTask: activeTask || null
  });
  return { turn, plan };
}

test("active price request followed by three images is treated as one comparison flow", () => {
  const recent = [{ turnId: "turn_text", type: "text", summary: "Puedes revisar estos precios?", mediaRefs: {} }];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_imgs" },
      { asset_id: "asset_2", file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE", turn_id: "turn_imgs" },
      { asset_id: "asset_3", file_id: "img_3", url: "https://cdn/3.jpg", media_type: "IMAGE", turn_id: "turn_imgs" }
    ]
  };
  const { turn, plan } = planTurn([
    imageMessage("img_1"),
    imageMessage("img_2"),
    imageMessage("img_3")
  ], campaignState, recent, { activeIntent: "price_review" }, "turn_imgs", {
    type: "price_review",
    status: "awaiting_media",
    expectedInputs: "images"
  });

  assert.equal(plan.intent, "multi_image_price_review");
  assert.equal(plan.mediaScope, "all_pending_batch");
  assert.equal(turn.media_batch.assets.length, 3);
});

test("new technical question after price flow does not inherit stale media or task", () => {
  const { plan } = planTurn([
    textMessage("como funciona un motor de induccion?", "tech")
  ], {
    campaign_assets: [
      { asset_id: "asset_old", file_id: "old_price", url: "https://cdn/old.jpg", media_type: "IMAGE", turn_id: "old" }
    ]
  }, [
    { turnId: "old", type: "image", summary: "precios de productos", mediaRefs: { assetCount: 1 } }
  ], { activeIntent: "price_review" }, "turn_tech");
  const answer = composeGeneralTextAnswer("como funciona un motor de induccion?");

  assert.equal(plan.intent, "general");
  assert.equal(plan.mediaScope, "none");
  assert.equal(plan.isContextSwitch, true);
  assert.match(answer, /estator|rotor|campo/i);
});

test("single image without caption asks what to do instead of describing it", () => {
  const vision = {
    assets: [{
      analysis: {
        main_subject: "gatito gris acostado en una cama",
        product_type: "",
        objects_detected: ["gato", "cama"],
        confidence: 0.9
      }
    }]
  };
  const { plan } = planTurn([imageMessage("cat")], {
    campaign_assets: [{ asset_id: "asset_1", file_id: "cat", url: "https://cdn/cat.jpg", media_type: "IMAGE", turn_id: "turn_cat" }]
  }, [], { activeIntent: "general" }, "turn_cat");
  assert.equal(plan.responseStrategy, "ask_clarification");
  assert.equal(plan.needsClarification, true);
  assert.match(plan.clarificationQuestion, /analice|texto visible|compare|puntual/i);
});

test("continuation phrase keeps the previous price comparison task", () => {
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_next", url: "https://cdn/next.jpg", media_type: "IMAGE", turn_id: "turn_next" }
    ]
  };
  const { plan } = planTurn([
    textMessage("y este otro?", "next_text"),
    imageMessage("img_next")
  ], campaignState, [
    { turnId: "old", type: "text", summary: "revisa estos precios", mediaRefs: {} }
  ], { activeIntent: "price_review" }, "turn_next");

  assert.equal(plan.intent, "price_review");
  assert.equal(plan.isContinuation, true);
  assert.equal(plan.mediaScope, "current_only");
});

test("image generation continuation reuses previous media when user references the photo", () => {
  const { turn, plan } = planTurn([
    textMessage("El mismo texto que me diste y que pusiste en la foto", "same_text")
  ], {}, [
    { turnId: "turn_design", type: "image", summary: "puedes disenar ese texto sobre esta foto", mediaRefs: { fileIds: ["img_mom"], assetCount: 1 } }
  ], { activeIntent: "image_generation" }, "turn_same_text");
  turn.previous_relevant_media = { asset_count: 1, image_count: 1, file_ids: ["img_mom"] };
  turn.previousRelevantMedia = turn.previous_relevant_media;
  const fixedPlan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [
      { turnId: "turn_design", type: "image", summary: "puedes disenar ese texto sobre esta foto", mediaRefs: { fileIds: ["img_mom"], assetCount: 1 } }
    ],
    activeContext: { activeIntent: "image_generation" }
  });

  assert.equal(plan.intent, "general");
  assert.equal(fixedPlan.intent, "image_generation");
  assert.equal(fixedPlan.mediaScope, "previous_relevant");
  assert.equal(fixedPlan.shouldUsePreviousMedia, true);
});

test("multi image final answer compares all visible prices", () => {
  const text = generateFinalUserResponse({
    intent: "multi_image_price_review",
    mediaScope: "all_pending_batch"
  }, {
    vision: {
      assets: [
        { analysis: { main_subject: "parlante", product_type: "parlante JBL", visible_text: "$55.99" } },
        { analysis: { main_subject: "audifonos", product_type: "audifonos Sony", visible_text: "$39.99" } },
        { analysis: { main_subject: "cargador", product_type: "cargador USB-C", visible_text: "$24.99" } }
      ]
    }
  });

  assert.match(text, /Imagen 1/);
  assert.match(text, /Imagen 2/);
  assert.match(text, /Imagen 3/);
  assert.match(text, /parece mas conveniente/i);
});
