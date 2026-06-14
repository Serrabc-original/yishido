import test from "node:test";
import assert from "node:assert/strict";
import {
  createConversationSupervisorPlan,
  generateFinalUserResponse,
  getRecentConversationWindow
} from "../src/supervisor/conversationSupervisor.js";
import {
  buildMediaBatch,
  buildUserTurn,
  clearMediaState,
  createEmptyConversationContext,
  forgetAllConversationData,
  formatListsIndexForWhatsApp,
  normalizeIncomingMessage
} from "../src/index.js";
import { addListItems, createList } from "../src/modules/lists/index.js";
import { buildCustomerMemory } from "../src/conversationMemory.js";
import { selectReminderDeliveryPath } from "../src/modules/reminders/index.js";

const basePayload = {
  type: "IMAGE",
  app: "app",
  channel: "channel",
  from: "user",
  to: "bot"
};

function imageMessage(fileId, messageId) {
  return normalizeIncomingMessage({ type: "IMAGE", fileId }, basePayload, {
    messageId: messageId || fileId,
    receivedAt: "2026-06-13T12:00:00.000Z"
  });
}

function textMessage(text, messageId) {
  return normalizeIncomingMessage({ type: "TEXT", text }, Object.assign({}, basePayload, { type: "TEXT" }), {
    messageId: messageId || "text",
    receivedAt: "2026-06-13T12:00:00.000Z"
  });
}

test("supervisor continues price review and selects all pending images", () => {
  const messages = [imageMessage("img_1"), imageMessage("img_2"), imageMessage("img_3")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_prices" },
      { asset_id: "asset_2", asset_index: 2, file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE", turn_id: "turn_prices" },
      { asset_id: "asset_3", asset_index: 3, file_id: "img_3", url: "https://cdn/3.jpg", media_type: "IMAGE", turn_id: "turn_prices" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_prices" });
  const recentConversationWindow = [{
    turnId: "turn_previous",
    type: "text",
    timestamp: "2026-06-13T11:59:00.000Z",
    summary: "Puedes revisar estos precios y decirme si estan caros?",
    mediaRefs: { fileIds: [], assetCount: 0 }
  }];

  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow,
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "multi_image_price_review");
  assert.equal(plan.isContinuation, true);
  assert.equal(plan.mediaScope, "all_pending_batch");
  assert.equal(turn.media_batch.assets.length, 3);
});

test("final response compares all price images and does not ask what to do", () => {
  const text = generateFinalUserResponse({
    intent: "multi_image_price_review",
    mediaScope: "all_pending_batch"
  }, {
    vision: {
      analyzed_asset_count: 3,
      failed_asset_count: 0,
      assets: [
        { analysis: { main_subject: "parlante", product_type: "parlante JBL", brand_or_labels: "JBL", visible_text: "$55.99", confidence: 0.87 } },
        { analysis: { main_subject: "audifonos", product_type: "audifonos Sony", brand_or_labels: "Sony", visible_text: "$39.99", confidence: 0.82 } },
        { analysis: { main_subject: "cargador", product_type: "cargador USB-C", brand_or_labels: "Anker", visible_text: "$24.99", confidence: 0.8 } }
      ]
    }
  });

  assert.match(text, /revisé 3 imagenes/);
  assert.match(text, /Imagen 1/);
  assert.match(text, /Imagen 2/);
  assert.match(text, /Imagen 3/);
  assert.match(text, /parece mas conveniente/);
  assert.doesNotMatch(text, /qué quieres hacer|que quieres hacer/i);
});

test("image plus caption is an image question, not generic visual analysis", () => {
  const messages = [imageMessage("speaker_1"), textMessage("Que tal este parlante?", "caption_text")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "speaker_1", url: "https://cdn/speaker.jpg", media_type: "IMAGE", turn_id: "turn_speaker" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_speaker" });
  const plan = createConversationSupervisorPlan({ currentTurn: turn, recentConversationWindow: [] });

  assert.equal(plan.intent, "image_question");
  assert.equal(plan.responseStrategy, "analyze_then_answer");
});

test("cat image with analyzed media blocks stale price context", () => {
  const messages = [imageMessage("cat_1")];
  const campaignState = {
    campaign_assets: [
      {
        asset_id: "asset_1",
        asset_index: 1,
        file_id: "cat_1",
        url: "https://cdn/cat.jpg",
        media_type: "IMAGE",
        turn_id: "turn_cat",
        status: "analyzed",
        analysis: {
          main_subject: "gatito gris acostado en una cama",
          product_type: "",
          objects_detected: ["gato", "cama"],
          confidence: 0.9
        }
      }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_cat" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{ turnId: "old", type: "text", summary: "revisa estos precios", mediaRefs: {} }],
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "pet_photo");
  assert.notEqual(plan.intent, "price_review");
});

test("topic switch from prices to reminder does not keep price intent", () => {
  const turn = buildUserTurn([textMessage("Recuerdame manana comprar leche", "reminder")], {}, { turnId: "turn_reminder" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{ turnId: "old", type: "text", summary: "revisa estos precios", mediaRefs: {} }],
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "reminder");
  assert.equal(plan.isContextSwitch, true);
  assert.equal(plan.mediaScope, "none");
});

test("audio transcript list request routes to list without dragging images", () => {
  const msg = textMessage("[Audio transcrito]: hazme una lista de huevos, pan, leche y carne", "audio_text");
  msg.originalType = "AUDIO";
  msg.audioTranscript = "hazme una lista de huevos, pan, leche y carne";
  const turn = buildUserTurn([msg], {
    campaign_assets: [
      { asset_id: "asset_old", file_id: "old_img", url: "https://cdn/old.jpg", media_type: "IMAGE", turn_id: "old" }
    ]
  }, { turnId: "audio_turn" });
  const plan = createConversationSupervisorPlan({ currentTurn: turn, recentConversationWindow: [] });

  assert.equal(plan.intent, "list");
  assert.equal(plan.mediaScope, "none");
  assert.equal(turn.media_batch.assets.length, 0);
});

test("reset clears media context while lists stay available only via lists command", () => {
  let listState = createList({}, "compras");
  listState = addListItems(listState, "compras", ["pan"]);
  const data = {
    campaignState: {
      campaign_assets: [{ asset_id: "asset_1", file_id: "old_img", url: "https://cdn/old.jpg" }],
      workflow_status: "media_received"
    },
    activeContext: createEmptyConversationContext("test"),
    coreUtilityState: { listsState: listState, lists: listState.lists, activeList: "compras" }
  };
  const reset = clearMediaState(data, "manual_reset");
  reset.coreUtilityState.activeList = "";

  assert.equal(reset.campaignState.campaign_assets.length, 0);
  assert.equal(reset.coreUtilityState.lists.compras.items.length, 1);
  assert.match(formatListsIndexForWhatsApp(reset.coreUtilityState), /compras/);
});

test("forget all removes lists, memory, reminders, media and context", () => {
  const forgotten = forgetAllConversationData({
    customerMemory: { name: "Mateo" },
    coreUtilityState: {
      reminders: [{ id: "rem_1", title: "comprar leche", status: "scheduled_mock" }],
      listsState: addListItems(createList({}, "compras"), "compras", ["pan"])
    },
    campaignState: {
      campaign_assets: [{ asset_id: "asset_1", file_id: "img" }]
    },
    conversationLog: [{ textPreview: "hola" }]
  }, "test");

  assert.equal(forgotten.customerMemory, null);
  assert.equal(Object.keys(forgotten.coreUtilityState.lists).length, 0);
  assert.equal(forgotten.coreUtilityState.reminders.length, 0);
  assert.equal(forgotten.campaignState.campaign_assets.length, 0);
  assert.equal(forgotten.conversationLog.length, 0);
});

test("customer memory stores and forgets user name safely", () => {
  const memory = buildCustomerMemory([{
    textPreview: "me llamo Mateo",
    audioTranscripts: []
  }], null);

  assert.equal(memory.name, "Mateo");
  const forgotten = buildCustomerMemory([], null);
  assert.equal(forgotten.name, "");
});

test("reminder delivery selects session message inside 24h", () => {
  const decision = selectReminderDeliveryPath({
    lastUserInteractionAt: "2026-06-13T12:00:00.000Z"
  }, {}, {
    now: "2026-06-13T13:00:00.000Z"
  });

  assert.equal(decision.path, "session_message");
});

test("reminder delivery blocks outside 24h without template", () => {
  const decision = selectReminderDeliveryPath({
    lastUserInteractionAt: "2026-06-12T12:00:00.000Z"
  }, {}, {
    now: "2026-06-13T13:00:00.000Z"
  });

  assert.equal(decision.path, "blocked_template_required");
});

test("reminder delivery selects template outside 24h when configured", () => {
  const decision = selectReminderDeliveryPath({
    lastUserInteractionAt: "2026-06-12T12:00:00.000Z"
  }, {
    REMINDER_TEMPLATE_NAME: "reminder_due",
    REMINDER_TEMPLATE_LANGUAGE: "es"
  }, {
    now: "2026-06-13T13:00:00.000Z"
  });

  assert.equal(decision.path, "template_message");
  assert.equal(decision.template.name, "reminder_due");
});

test("interactive policy keeps primary text as separate responsibility", () => {
  const plan = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("hazme una lista de compras con arroz", "list")], {}, { turnId: "turn_list" }),
    recentConversationWindow: []
  });

  assert.equal(plan.intent, "list");
  assert.equal(plan.responseStrategy, "create_utility_then_confirm");
  assert.equal(plan.targetModules.includes("whatsapp_interactive"), true);
});

test("marketing is only explicit and general product image stays evaluation", () => {
  const marketing = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("Hazme un post con esta foto", "mkt"), imageMessage("img_mkt")], {
      campaign_assets: [{ asset_id: "asset_1", file_id: "img_mkt", url: "https://cdn/mkt.jpg", media_type: "IMAGE", turn_id: "turn_mkt" }]
    }, { turnId: "turn_mkt" }),
    recentConversationWindow: []
  });
  const general = createConversationSupervisorPlan({
    currentTurn: buildUserTurn([textMessage("Que tal este producto?", "prod"), imageMessage("img_prod")], {
      campaign_assets: [{ asset_id: "asset_1", file_id: "img_prod", url: "https://cdn/prod.jpg", media_type: "IMAGE", turn_id: "turn_prod" }]
    }, { turnId: "turn_prod" }),
    recentConversationWindow: []
  });

  assert.equal(marketing.intent, "marketing");
  assert.equal(general.intent, "product_advice");
});

test("recent conversation window normalizes the last 20 turns", () => {
  const window = getRecentConversationWindow({
    conversationLog: Array.from({ length: 25 }, (_, index) => ({
      turnId: "turn_" + index,
      at: "2026-06-13T12:00:00.000Z",
      inputTypes: ["TEXT"],
      counts: { text: 1 },
      textPreview: "mensaje " + index,
      media: { fileIds: [], assetCount: 0 }
    }))
  }, 20);

  assert.equal(window.length, 20);
  assert.equal(window[0].turnId, "turn_5");
  assert.equal(window[19].type, "text");
});

test("buildMediaBatch still treats campaign_assets as media source of truth", () => {
  const batch = buildMediaBatch({
    campaign_assets: [
      { asset_id: "asset_1", file_id: "img_1", url: "https://cdn/1.jpg", media_type: "IMAGE" },
      { asset_id: "asset_2", file_id: "img_2", url: "https://cdn/2.jpg", media_type: "IMAGE" }
    ]
  }, [imageMessage("img_1"), imageMessage("img_2")]);

  assert.deepEqual(batch.fileIds, ["img_1", "img_2"]);
});
