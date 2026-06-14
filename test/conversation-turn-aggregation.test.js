import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMediaBatch,
  buildVersionDiagnostic,
  clearMediaState,
  buildUserTurn,
  createTaskIntakeFromText,
  normalizeIncomingMessage,
  updateTaskIntakeWithMessage
} from "../src/index.js";
import { appendPendingEvent, buildTurnReadiness, getTurnAggregationTiming } from "../src/conversation/turnAggregator.js";
import { createConversationSupervisorPlan } from "../src/supervisor/conversationSupervisor.js";

const basePayload = {
  eventType: "INBOUND",
  app: "app_1",
  channel: "channel_1",
  from: "user_1",
  to: "bot_1"
};

function textMessage(text, id) {
  return normalizeIncomingMessage({ type: "TEXT", text, messageId: id }, Object.assign({}, basePayload, { type: "TEXT" }), {
    messageId: id,
    receivedAt: "2026-06-14T00:00:00.000Z"
  });
}

function imageMessage(fileId, caption) {
  return normalizeIncomingMessage({ type: "IMAGE", fileId, text: caption || "", caption: caption || "", messageId: fileId }, Object.assign({}, basePayload, { type: "IMAGE" }), {
    messageId: fileId,
    receivedAt: "2026-06-14T00:00:01.000Z"
  });
}

function audioMessage(id, transcript) {
  const msg = normalizeIncomingMessage({ type: "AUDIO", fileId: id, audioStatus: "transcribed", audioTranscript: transcript, messageId: id }, Object.assign({}, basePayload, { type: "AUDIO" }), {
    messageId: id,
    receivedAt: "2026-06-14T00:00:02.000Z"
  });
  msg.text = transcript;
  msg.awaitingTranscription = false;
  msg.audio = msg.audio.map((audio) => Object.assign({}, audio, { status: "transcribed", transcript }));
  return msg;
}

function campaignState(fileIds) {
  return {
    campaign_assets: fileIds.map((fileId, index) => ({
      asset_id: "asset_" + (index + 1),
      asset_index: index + 1,
      file_id: fileId,
      url: "https://cdn/" + fileId + ".jpg",
      media_type: "IMAGE",
      status: "received",
      turn_id: "turn_test"
    }))
  };
}

test("2 and 4 images stay in one UserTurn media batch", () => {
  const two = [imageMessage("img_1"), imageMessage("img_2")];
  const twoTurn = buildUserTurn(two, campaignState(["img_1", "img_2"]), { turnId: "turn_test" });
  assert.equal(twoTurn.counts.image, 2);
  assert.deepEqual(twoTurn.media_batch.fileIds, ["img_1", "img_2"]);

  const four = ["img_1", "img_2", "img_3", "img_4"].map((id) => imageMessage(id));
  const fourTurn = buildUserTurn(four, campaignState(["img_1", "img_2", "img_3", "img_4"]), { turnId: "turn_test" });
  assert.equal(fourTurn.counts.image, 4);
  assert.deepEqual(fourTurn.media_batch.fileIds, ["img_1", "img_2", "img_3", "img_4"]);
});

test("2 and 3 audios join transcripts in order", () => {
  const twoTurn = buildUserTurn([audioMessage("aud_1", "primero"), audioMessage("aud_2", "segundo")], {}, { turnId: "turn_audio" });
  assert.deepEqual(twoTurn.audioTranscripts, ["primero", "segundo"]);
  assert.equal(twoTurn.counts.audio, 2);
  assert.equal(twoTurn.combinedUserText, "primero\nsegundo");

  const threeTurn = buildUserTurn([
    audioMessage("aud_1", "uno"),
    audioMessage("aud_2", "dos"),
    audioMessage("aud_3", "tres")
  ], {}, { turnId: "turn_audio" });
  assert.deepEqual(threeTurn.audioTranscripts, ["uno", "dos", "tres"]);
  assert.equal(threeTurn.counts.audio, 3);
});

test("4 texts join as one user intention", () => {
  const turn = buildUserTurn([
    textMessage("Necesito una lista", "t1"),
    textMessage("para la semana", "t2"),
    textMessage("con desayuno", "t3"),
    textMessage("y cena", "t4")
  ], {}, { turnId: "turn_text" });

  assert.equal(turn.counts.text, 4);
  assert.equal(turn.combinedUserText, "Necesito una lista\npara la semana\ncon desayuno\ny cena");
});

test("text plus images and audio plus images prioritize clear text/audio intent", () => {
  const textImages = buildUserTurn([
    textMessage("Como funciona un motor de induccion?", "t1"),
    imageMessage("img_1"),
    imageMessage("img_2")
  ], campaignState(["img_1", "img_2"]), { turnId: "turn_test" });
  const textPlan = createConversationSupervisorPlan({ currentTurn: textImages, recentConversationWindow: [] });
  assert.equal(textPlan.intent, "general");
  assert.deepEqual(textPlan.targetModules, ["general_llm"]);

  const audioImages = buildUserTurn([
    imageMessage("img_1"),
    imageMessage("img_2"),
    audioMessage("aud_1", "Como funciona un motor de induccion?")
  ], campaignState(["img_1", "img_2"]), { turnId: "turn_test" });
  const audioPlan = createConversationSupervisorPlan({ currentTurn: audioImages, recentConversationWindow: [] });
  assert.equal(audioPlan.intent, "general");
  assert.notEqual(audioPlan.intent, "unknown_image_request");
});

test("captions stay associated with their images", () => {
  const turn = buildUserTurn([
    imageMessage("img_1", "caption uno"),
    imageMessage("img_2", "caption dos")
  ], campaignState(["img_1", "img_2"]), { turnId: "turn_test" });

  assert.deepEqual(turn.images.map((image) => image.caption), ["caption uno", "caption dos"]);
  assert.deepEqual(turn.caption_links.map((caption) => caption.fileId), ["img_1", "img_2"]);
});

test("image without text can ask useful clarification but image plus audio clear is not unknown", () => {
  const imageOnly = buildUserTurn([imageMessage("img_1")], campaignState(["img_1"]), { turnId: "turn_test" });
  const imagePlan = createConversationSupervisorPlan({ currentTurn: imageOnly, recentConversationWindow: [] });
  assert.equal(imagePlan.intent, "unknown_image_request");

  const clearAudio = buildUserTurn([imageMessage("img_1"), audioMessage("aud_1", "Que es induccion magnetica?")], campaignState(["img_1"]), { turnId: "turn_test" });
  const audioPlan = createConversationSupervisorPlan({ currentTurn: clearAudio, recentConversationWindow: [] });
  assert.notEqual(audioPlan.intent, "unknown_image_request");
});

test("media batch is selected from UserTurn images and deduped", () => {
  const messages = [imageMessage("img_1"), imageMessage("img_2"), imageMessage("img_2")];
  const turn = buildUserTurn(messages, campaignState(["img_1", "img_2"]), { turnId: "turn_test" });
  const batch = buildMediaBatch({}, [], { userTurn: turn });

  assert.equal(batch.assetCount, 2);
  assert.deepEqual(batch.fileIds, ["img_1", "img_2"]);
});

test("pending events append and readiness handles audio wait plus done signal", () => {
  const data = { pendingMessages: [], currentTurnId: "turn_1", firstMessageAt: 1000, lastMessageAt: 1000 };
  appendPendingEvent(data, textMessage("uno", "t1"));
  appendPendingEvent(data, textMessage("dos", "t2"));
  assert.equal(data.pendingMessages.length, 2);

  const pendingAudio = audioMessage("aud_1", "");
  pendingAudio.awaitingTranscription = true;
  data.pendingMessages.push(pendingAudio);
  const timing = getTurnAggregationTiming({ TURN_AUDIO_MAX_WAIT_MS: 75000 });
  assert.equal(buildTurnReadiness(data, { now: 2000, timing }).ready, false);

  data.pendingMessages.push(textMessage("listo", "done"));
  assert.equal(buildTurnReadiness(data, { now: 3000, timing }).reason, "user_done");
});

test("task intake window still accepts media after text request", () => {
  const task = createTaskIntakeFromText("revisa estos precios", { now: 1000 });
  const updated = updateTaskIntakeWithMessage(task, imageMessage("img_1"), { now: 2000 });

  assert.equal(updated.status, "awaiting_media");
  assert.equal(updated.receivedMediaCount, 1);
  assert.deepEqual(updated.taskMediaFileIds, ["img_1"]);
});

test("/version, /reset-style clear, lists and reminders contracts still work", () => {
  const version = buildVersionDiagnostic({});
  assert.equal(version.version, "whatsapp-ai-agent-core-v3");
  assert.equal(Boolean(version.CUSTOMER_REPLY_MODEL), true);

  const cleared = clearMediaState({
    campaignState: {
      campaign_assets: [{ file_id: "img_1" }],
      last_uploaded_image: { fileId: "img_1" }
    }
  }, "test");
  assert.equal(cleared.campaignState.campaign_assets.length, 0);
  assert.equal(cleared.campaignState.last_uploaded_image, null);

  const listTurn = buildUserTurn([textMessage("hazme una lista de compras con arroz", "list")], {}, { turnId: "turn_list" });
  const listPlan = createConversationSupervisorPlan({ currentTurn: listTurn, recentConversationWindow: [] });
  assert.equal(listPlan.intent, "list");

  const reminderTurn = buildUserTurn([textMessage("recuerdame llamar a Juan manana", "rem")], {}, { turnId: "turn_rem" });
  const reminderPlan = createConversationSupervisorPlan({ currentTurn: reminderTurn, recentConversationWindow: [] });
  assert.equal(reminderPlan.intent, "reminder");
});
