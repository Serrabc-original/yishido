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
import { buildConversationSummary, buildCustomerMemory, buildUtilityMemory, updateConversationMemory } from "../src/conversationMemory.js";
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
    activeContext: { activeIntent: "price_review" },
    activeTask: { type: "price_review", status: "awaiting_media", expectedInputs: "images" }
  });

  assert.equal(plan.intent, "multi_image_price_review");
  assert.equal(plan.isContinuation, true);
  assert.equal(plan.mediaScope, "all_pending_batch");
  assert.equal(turn.media_batch.assets.length, 3);
});

test("images without text do not inherit stale price review without active task", () => {
  const messages = [imageMessage("img_new_1"), imageMessage("img_new_2")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_new_1", url: "https://cdn/1.jpg", media_type: "IMAGE", turn_id: "turn_new" },
      { asset_id: "asset_2", asset_index: 2, file_id: "img_new_2", url: "https://cdn/2.jpg", media_type: "IMAGE", turn_id: "turn_new" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_new" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{
      turnId: "turn_old",
      type: "text",
      timestamp: "2026-06-13T11:00:00.000Z",
      summary: "Puedes revisar estos precios?",
      mediaRefs: { fileIds: [], assetCount: 0 }
    }],
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "multi_image_review");
  assert.equal(plan.activeTask, "multi_image_review");
  assert.equal(plan.mediaScope, "all_pending_batch");
  assert.equal(plan.isContinuation, false);
});

test("design request with previous media is routed to image generation context", () => {
  const turn = buildUserTurn([textMessage("Con esta informacion me haces un diseno?", "design_text")], {}, { turnId: "turn_design" });
  turn.previous_relevant_media = { asset_count: 2, image_count: 2, file_ids: ["img_old_1", "img_old_2"] };
  turn.previousRelevantMedia = turn.previous_relevant_media;
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [],
    activeContext: { activeIntent: "image_question" }
  });

  assert.equal(plan.intent, "image_generation");
  assert.equal(plan.mediaScope, "previous_relevant");
  assert.equal(plan.shouldUsePreviousMedia, true);
  assert.equal(plan.responseStrategy, "execute_then_confirm");
});

test("short design format follow-up keeps previous media as image generation context", () => {
  const turn = buildUserTurn([textMessage("Portada", "design_cover")], {}, { turnId: "turn_design_cover" });
  turn.previous_relevant_media = { asset_count: 1, image_count: 1, file_ids: ["img_base"] };
  turn.previousRelevantMedia = turn.previous_relevant_media;
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{
      turnId: "turn_generated",
      type: "image",
      timestamp: "2026-06-17T01:08:00.000Z",
      summary: "Listo, te genere esta imagen. Quieres otra version o ajustamos el texto?",
      mediaRefs: { fileIds: ["img_base"], assetCount: 1 }
    }],
    activeContext: { activeIntent: "image_generation" },
    activeTask: { type: "image_generation", status: "awaiting_media", taskMediaFileIds: ["img_base"] }
  });

  assert.equal(plan.intent, "image_generation");
  assert.equal(plan.mediaScope, "previous_relevant");
  assert.equal(plan.shouldUsePreviousMedia, true);
  assert.equal(plan.responseStrategy, "execute_then_confirm");
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

test("technical text after price context is a context switch, not price continuation", () => {
  const turn = buildUserTurn([textMessage("Como funciona un motor de induccion?", "tech")], {}, { turnId: "turn_tech" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{ turnId: "old", type: "text", summary: "revisa estos precios", mediaRefs: {} }],
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "general");
  assert.equal(plan.activeTask, "general");
  assert.equal(plan.isContextSwitch, true);
  assert.equal(plan.isContinuation, false);
});

test("clear audio question after images does not drag stale image context", () => {
  const msg = textMessage("[Audio transcrito]: Como funciona un motor de induccion?", "audio_tech");
  msg.originalType = "AUDIO";
  msg.audioTranscript = "Como funciona un motor de induccion?";
  const turn = buildUserTurn([msg], {
    campaign_assets: [
      { asset_id: "asset_old", file_id: "old_img", url: "https://cdn/old.jpg", media_type: "IMAGE", turn_id: "old" }
    ]
  }, { turnId: "audio_tech_turn" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{ turnId: "old", type: "image", summary: "foto anterior", mediaRefs: { assetCount: 1 } }],
    activeContext: { activeIntent: "image_question" }
  });

  assert.equal(plan.intent, "general");
  assert.equal(plan.mediaScope, "none");
  assert.equal(plan.isContextSwitch, true);
  assert.equal(turn.media_batch.assets.length, 0);
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

test("single image without text asks a useful question before analysis", () => {
  const messages = [imageMessage("img_lonely")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_lonely", url: "https://cdn/lonely.jpg", media_type: "IMAGE", turn_id: "turn_lonely" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_lonely" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [],
    activeContext: { activeIntent: "general" }
  });

  assert.equal(plan.intent, "unknown_image_request");
  assert.equal(plan.responseStrategy, "ask_clarification");
  assert.equal(plan.needsClarification, true);
  assert.match(plan.clarificationQuestion, /analice|texto visible|compare|puntual/i);
  assert.equal(plan.mediaScope, "current_only");
});

test("short continuation keeps previous price task for the next image", () => {
  const messages = [textMessage("y este otro?", "and_this"), imageMessage("img_next")];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_next", url: "https://cdn/next.jpg", media_type: "IMAGE", turn_id: "turn_next" }
    ]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_next" });
  const plan = createConversationSupervisorPlan({
    currentTurn: turn,
    recentConversationWindow: [{ turnId: "old", type: "text", summary: "revisa estos precios", mediaRefs: {} }],
    activeContext: { activeIntent: "price_review" }
  });

  assert.equal(plan.intent, "price_review");
  assert.equal(plan.isContinuation, true);
  assert.equal(plan.mediaScope, "current_only");
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

test("conversation memory stores only the last 20 turns", () => {
  let data = { conversationLog: [] };

  for (let index = 0; index < 25; index++) {
    data = updateConversationMemory(data, {
      turn_id: "turn_" + index,
      created_at: "2026-06-13T12:00:00.000Z",
      input_types: ["TEXT"],
      current_turn_text: "mensaje " + index,
      media_batch: { fileIds: [], assetCount: 0, failedAssetCount: 0 }
    }, {
      flags: {
        saveConversationLogs: true,
        enableUserStyleProfile: false,
        enableCustomerMemory: false
      }
    });
  }

  assert.equal(data.conversationLog.length, 20);
  assert.equal(data.conversationLog[0].turnId, "turn_5");
  assert.equal(data.conversationLog[19].turnId, "turn_24");

  const summary = buildConversationSummary(data.conversationLog);
  assert.equal(summary.recent_turn_ids.length, 20);
});

test("conversation memory keeps compact text audio and image refs in the latest 20 turns", () => {
  let data = { conversationLog: [] };

  for (let index = 0; index < 22; index++) {
    data = updateConversationMemory(data, {
      turn_id: "turn_" + index,
      created_at: "2026-06-15T05:" + String(index).padStart(2, "0") + ":00.000Z",
      input_types: index % 2 ? ["AUDIO", "IMAGE"] : ["TEXT"],
      current_turn_text: index % 2 ? "[Audio transcrito]: anota pan y leche" : "mensaje " + index,
      text_count: index % 2 ? 0 : 1,
      audio_count: index % 2 ? 1 : 0,
      image_count: index % 2 ? 1 : 0,
      audio_transcripts: index % 2 ? ["anota pan y leche"] : [],
      media_batch: index % 2 ? { fileIds: ["img_" + index], assetCount: 1, failedAssetCount: 0 } : { fileIds: [], assetCount: 0, failedAssetCount: 0 }
    }, {
      flags: {
        saveConversationLogs: true,
        enableUserStyleProfile: false,
        enableCustomerMemory: true
      }
    });
  }

  assert.equal(data.conversationLog.length, 20);
  assert.equal(data.conversationLog[0].turnId, "turn_2");
  assert.equal(data.conversationLog.some((entry) => entry.audioTranscripts.includes("anota pan y leche")), true);
  assert.equal(data.conversationLog.some((entry) => entry.media.fileIds.includes("img_21")), true);
  assert.match(data.customerMemory.last_audio_summary, /pan y leche/i);
});

test("utility memory exposes recent non-empty lists for reference resolution", () => {
  let listState = createList({}, "super");
  listState = addListItems(listState, "super", ["huevos", "pan", "leche"]);
  const memory = buildUtilityMemory({
    lists: listState.lists,
    activeList: "super"
  });

  assert.equal(memory.active_list, "super");
  assert.equal(memory.recent_lists.length, 1);
  assert.equal(memory.recent_lists[0].item_count, 3);
  assert.deepEqual(memory.recent_lists[0].items, ["huevos", "pan", "leche"]);
});

test("conversation memory promotes client data from audio into compact facts", () => {
  const data = updateConversationMemory({}, {
    turn_id: "turn_audio_client",
    created_at: "2026-06-15T05:40:00.000Z",
    input_types: ["AUDIO"],
    current_turn_text: "[Audio transcrito]: Los datos de Mateo Serrano son 27 anos, correo mate.serra@gmail.com, plan de 50 dolares y maneja Google Maps, Instagram, Facebook y WhatsApp.",
    audio_count: 1,
    audio_transcripts: ["Los datos de Mateo Serrano son 27 anos, correo mate.serra@gmail.com, plan de 50 dolares y maneja Google Maps, Instagram, Facebook y WhatsApp."],
    media_batch: { fileIds: [], assetCount: 0, failedAssetCount: 0 }
  }, {
    flags: {
      saveConversationLogs: true,
      enableUserStyleProfile: false,
      enableCustomerMemory: true
    }
  });

  const facts = data.customerMemory.important_facts;
  assert.equal(facts.some((fact) => fact.label === "email" && fact.value === "mate.serra@gmail.com"), true);
  assert.equal(facts.some((fact) => fact.label === "edad" && fact.value === "27"), true);
  assert.equal(facts.some((fact) => fact.label === "canales_o_plataformas" && fact.value.includes("instagram")), true);
  assert.equal(data.customerMemory.compact_data_memory.length > 0, true);
});

test("conversation memory keeps compact latest audio task for follow-ups", () => {
  const data = updateConversationMemory({}, {
    turn_id: "turn_audio_reminder",
    created_at: "2026-06-15T23:55:00.000Z",
    input_types: ["AUDIO"],
    current_turn_text: "[Audio transcrito]: Para yo poder enviar un mensaje a un lead en cinco minutos.",
    audio_count: 1,
    audio_transcripts: ["Para yo poder enviar un mensaje a un lead en cinco minutos."],
    media_batch: { fileIds: [], assetCount: 0, failedAssetCount: 0 }
  }, {
    flags: {
      saveConversationLogs: true,
      enableUserStyleProfile: false,
      enableCustomerMemory: true
    }
  });

  assert.match(data.customerMemory.last_audio_summary, /enviar un mensaje a un lead/i);
  assert.equal(data.customerMemory.last_audio_summary.length <= 240, true);
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
