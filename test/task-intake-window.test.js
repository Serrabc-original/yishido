import test from "node:test";
import assert from "node:assert/strict";
import {
  addCampaignAsset,
  buildMediaBatch,
  buildTaskIntakeDecision,
  buildUserTurn,
  createTaskIntakeFromText,
  handleUserClaimedMoreImages,
  normalizeIncomingMessage,
  updateTaskIntakeWithMessage
} from "../src/index.js";
import {
  createConversationSupervisorPlan
} from "../src/supervisor/conversationSupervisor.js";
import {
  composeFinalResponse
} from "../src/ai/finalResponseComposer.js";

const basePayload = {
  type: "IMAGE",
  app: "app",
  channel: "channel",
  from: "user",
  to: "bot"
};

function textMessage(text, id) {
  return normalizeIncomingMessage({ type: "TEXT", text }, Object.assign({}, basePayload, { type: "TEXT" }), {
    messageId: id || "text",
    receivedAt: "2026-06-14T12:00:00.000Z"
  });
}

function imageMessage(fileId, id) {
  return normalizeIncomingMessage({ type: "IMAGE", fileId }, basePayload, {
    messageId: id || fileId,
    receivedAt: "2026-06-14T12:00:00.000Z"
  });
}

test("text first opens task intake and waits for images", () => {
  const activeTask = createTaskIntakeFromText("Que tal te parecen estos precios?", {
    now: 1000,
    waitSeconds: 30,
    maxWaitSeconds: 45,
    silenceSeconds: 8
  });

  assert.equal(activeTask.type, "price_review");
  assert.equal(activeTask.status, "awaiting_media");
  assert.equal(activeTask.expectedInputs, "images");
  assert.equal(activeTask.originalUserRequest, "Que tal te parecen estos precios?");

  const decision = buildTaskIntakeDecision(activeTask, {
    now: 5000,
    hasMedia: false,
    userDone: false
  });

  assert.equal(decision.ready, false);
  assert.equal(decision.shouldWait, true);
});

test("separate WhatsApp images are accumulated in the active task batch", () => {
  let activeTask = createTaskIntakeFromText("revisa estos precios", { now: 1000 });
  activeTask = updateTaskIntakeWithMessage(activeTask, imageMessage("img_1"), { now: 3000 });
  activeTask = updateTaskIntakeWithMessage(activeTask, imageMessage("img_2"), { now: 6000 });

  assert.deepEqual(activeTask.taskMediaFileIds, ["img_1", "img_2"]);
  assert.equal(activeTask.receivedMediaCount, 2);
  assert.equal(activeTask.lastMediaAt, 6000);

  const decision = buildTaskIntakeDecision(activeTask, {
    now: 14000,
    hasMedia: true,
    userDone: false,
    silenceSeconds: 8
  });

  assert.equal(decision.ready, true);
  assert.equal(decision.reason, "silence");
});

test("user done words process the task immediately with all images", () => {
  let activeTask = createTaskIntakeFromText("mira estas imagenes", { now: 1000 });
  activeTask = updateTaskIntakeWithMessage(activeTask, imageMessage("img_1"), { now: 2000 });
  activeTask = updateTaskIntakeWithMessage(activeTask, imageMessage("img_2"), { now: 2500 });
  activeTask = updateTaskIntakeWithMessage(activeTask, textMessage("listo", "done"), { now: 3000 });

  const decision = buildTaskIntakeDecision(activeTask, {
    now: 3000,
    hasMedia: true,
    userDone: true
  });

  assert.equal(decision.ready, true);
  assert.equal(decision.reason, "user_done");
  assert.deepEqual(activeTask.taskMediaFileIds, ["img_1", "img_2"]);
});

test("task intake expires without media and asks for images", () => {
  const activeTask = createTaskIntakeFromText("puedes ver si esta caro", {
    now: 1000,
    waitSeconds: 30,
    maxWaitSeconds: 45
  });
  const decision = buildTaskIntakeDecision(activeTask, {
    now: 46000,
    hasMedia: false
  });

  assert.equal(decision.ready, true);
  assert.equal(decision.reason, "expired_no_media");
});

test("claiming more images recounts recent media and selects both when present", () => {
  const messages = [textMessage("Que tal te parecen estos precios?", "t1"), imageMessage("img_1"), imageMessage("img_2")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_prices" },
      { asset_id: "asset_2", file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE", turn_id: "turn_prices" }
    ]
  };

  const result = handleUserClaimedMoreImages("pero te mande 2 imagenes", campaignState, messages);

  assert.equal(result.claimedCount, 2);
  assert.equal(result.receivedCount, 2);
  assert.equal(result.shouldReanalyze, true);
  assert.deepEqual(result.mediaBatch.fileIds, ["img_1", "img_2"]);
});

test("claiming two images asks for resend when only one arrived", () => {
  const messages = [textMessage("Que tal te parecen estos precios?", "t1"), imageMessage("img_1")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_prices" }
    ]
  };

  const result = handleUserClaimedMoreImages("pero te mande 2 imagenes", campaignState, messages);

  assert.equal(result.claimedCount, 2);
  assert.equal(result.receivedCount, 1);
  assert.equal(result.shouldReanalyze, false);
  assert.match(result.message, /Me llego solo una imagen/);
});

test("supervisor uses active price task for image without asking clarification", () => {
  const messages = [imageMessage("img_1")];
  const campaignState = {
    active_task: {
      type: "price_review",
      status: "awaiting_media",
      originalUserRequest: "revisa estos precios",
      taskMediaFileIds: ["img_1"],
      receivedMediaCount: 1
    },
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_prices" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_prices" });
  turn.activeTask = campaignState.active_task;

  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    activeTask: campaignState.active_task,
    recentConversationWindow: []
  });

  assert.equal(plan.intent, "price_review");
  assert.equal(plan.responseStrategy, "analyze_then_answer");
  assert.equal(plan.needsClarification, false);
});

test("image without context asks a useful non-marketing clarification", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "unknown_image_request" },
    specialistResults: {
      vision: { assets: [{ analysis: { main_subject: "captura de pantalla", visible_text: "", confidence: 0.8 } }] }
    },
    currentUserMessage: "",
    currentMediaSummary: { assets: [{ analysis: { main_subject: "captura de pantalla", visible_text: "", confidence: 0.8 } }] }
  });

  assert.match(response.text, /analice|extraiga texto|compare/i);
  assert.doesNotMatch(response.text, /copy|Instagram|campana|dise/i);
});

test("multiple images with one failed still produce a useful price response", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "multi_image_price_review" },
    specialistResults: {
      vision: {
        failed_asset_count: 1,
        assets: [
          { status: "analyzed", analysis: { main_subject: "parlante", product_type: "parlante JBL", visible_text: "$55.99", confidence: 0.9 } },
          { status: "analysis_failed", analysis_error: "bad url" }
        ]
      }
    },
    currentUserMessage: "Que tal te parecen estos precios?"
  });

  assert.match(response.text, /revis[eé] 1 imagen/i);
  assert.match(response.text, /1 imagen.*no se pudo analizar/i);
});

test("marketing stays allowed only for explicit marketing requests", () => {
  let assets = [];
  assets = addCampaignAsset(assets, { file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE" });
  const batch = buildMediaBatch({ campaign_assets: assets }, [imageMessage("img_1")]);
  assert.equal(batch.assets.length, 1);

  const general = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("Que tal este producto?", "prod"), imageMessage("img_1")], {
      campaign_assets: [{ asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_prod" }]
    }, { turnId: "turn_prod" })
  });
  const marketing = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("Hazme un post con esta imagen", "post"), imageMessage("img_2")], {
      campaign_assets: [{ asset_id: "asset_1", file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE", turn_id: "turn_post" }]
    }, { turnId: "turn_post" })
  });

  assert.notEqual(general.intent, "marketing");
  assert.equal(marketing.intent, "marketing");
});
