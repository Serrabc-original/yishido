import test from "node:test";
import assert from "node:assert/strict";
import {
  extractWoztellMessage,
  normalizeIncomingMessage,
  extractMediaFromPayload,
  addCampaignAsset,
  getUploadedMediaBatch,
  buildMediaBatch,
  buildAudioBatch,
  buildVideoMetadata,
  shouldStartNewTurn,
  shouldUsePreviousContext,
  buildUserTurn,
  buildOrchestratorInput,
  buildContextSnapshot,
  clearMediaState,
  createEmptyConversationContext,
  formatContextForWhatsApp,
  updateConversationContext,
  compactConversationHistory,
  mapOrchestratorActions,
  analyzeMediaBatch,
  buildMediaBatchSummary,
  consolidatedMessagesText
} from "../src/index.js";

const basePayload = {
  eventType: "INBOUND",
  type: "IMAGE",
  app: "app_1",
  channel: "channel_1",
  from: "user_1",
  to: "bot_1"
};

test("extractWoztellMessage keeps text-only messages working", () => {
  const parsed = extractWoztellMessage({
    eventType: "INBOUND",
    type: "TEXT",
    messageId: "msg_text",
    text: "hazme un post"
  });

  assert.equal(parsed.type, "TEXT");
  assert.equal(parsed.text, "hazme un post");
  assert.equal(parsed.fileId, "");
});

test("normalizeIncomingMessage always exposes media as an array", () => {
  const parsed = extractWoztellMessage({
    ...basePayload,
    messageId: "msg_img_1",
    fileId: "file_1",
    caption: "usa esta imagen"
  });
  const normalized = normalizeIncomingMessage(parsed, basePayload, {
    messageId: "msg_img_1",
    receivedAt: "2026-06-12T00:00:00.000Z"
  });

  assert.equal(normalized.fileId, "file_1");
  assert.equal(Array.isArray(normalized.media), true);
  assert.equal(normalized.media.length, 1);
  assert.equal(normalized.media[0].fileId, "file_1");
});

test("addCampaignAsset deduplicates by file id and preserves multiple assets", () => {
  let assets = [];
  assets = addCampaignAsset(assets, { file_id: "file_1", url: "https://cdn/1.jpg" });
  assets = addCampaignAsset(assets, { file_id: "file_2", url: "https://cdn/2.jpg" });
  assets = addCampaignAsset(assets, { file_id: "file_1", url: "https://cdn/1b.jpg" });

  assert.equal(assets.length, 2);
  assert.deepEqual(assets.map((asset) => asset.file_id), ["file_1", "file_2"]);
});

test("buildMediaBatch returns the current pending image batch", () => {
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", file_id: "file_1", url: "https://cdn/1.jpg", status: "received" },
      { asset_id: "asset_2", file_id: "file_2", url: "https://cdn/2.jpg", status: "received" },
      { asset_id: "asset_old", file_id: "old", url: "https://cdn/old.jpg", status: "received" }
    ]
  };
  const messages = [
    { type: "IMAGE", fileId: "file_1", media: [{ fileId: "file_1" }] },
    { type: "IMAGE", fileId: "file_2", media: [{ fileId: "file_2" }] }
  ];

  const batch = buildMediaBatch(campaignState, messages);

  assert.equal(batch.assets.length, 2);
  assert.deepEqual(batch.fileIds, ["file_1", "file_2"]);
});

test("analyzeMediaBatch keeps valid assets when one image fails", async () => {
  const env = {
    OPENAI_API_KEY: "test",
    VISION_MODEL: "mock",
    VISION_FALLBACK_MODEL: "mock",
    fetch: async () => {
      throw new Error("not used");
    }
  };
  const mediaBatch = {
    assets: [
      { asset_id: "asset_1", file_id: "file_1", url: "mock://ok", status: "received" },
      { asset_id: "asset_2", file_id: "file_2", url: "", status: "url_pending" }
    ]
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      output: [
        {
          content: [
            {
              text: JSON.stringify({
                main_subject: "producto",
                product_type: "producto",
                visible_text: "",
                brand_or_labels: "",
                colors: ["azul"],
                style: "limpio",
                objects_detected: ["producto"],
                marketing_notes: "usar como referencia",
                possible_use_cases: ["post"],
                recommended_angle: "beneficio claro",
                confidence: 0.9
              })
            }
          ]
        }
      ]
    })
  });

  try {
    const result = await analyzeMediaBatch(env, {
      doName: "channel:user",
      mediaBatch,
      caption: "hazme posts",
      woztellPayload: basePayload
    });

    assert.equal(result.summary.asset_count, 2);
    assert.equal(result.summary.analyzed_asset_count, 1);
    assert.equal(result.summary.failed_asset_count, 1);
    assert.equal(result.assets[1].status, "analysis_failed");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("consolidatedMessagesText keeps text plus image context together", () => {
  const text = consolidatedMessagesText([
    { type: "TEXT", text: "hazme 3 posts" },
    { type: "IMAGE", fileId: "file_1", text: "[IMAGE uploaded without caption]" }
  ]);

  assert.match(text, /hazme 3 posts/);
  assert.match(text, /fileId=file_1/);
});

test("extractMediaFromPayload supports multiple media in one payload", () => {
  const media = extractMediaFromPayload({}, {
    type: "IMAGE",
    media: [
      { type: "IMAGE", fileId: "file_1", caption: "uno" },
      { type: "IMAGE", fileId: "file_2", caption: "dos" },
      { type: "VIDEO", fileId: "video_1", mimeType: "video/mp4" }
    ]
  });

  assert.equal(media.length, 3);
  assert.deepEqual(media.map((item) => item.fileId), ["file_1", "file_2", "video_1"]);
});

test("buildUserTurn groups text, captions, images, audio, video and files", () => {
  const messages = [
    normalizeIncomingMessage({ type: "TEXT", text: "Hazme posts" }, basePayload, { messageId: "text_1" }),
    normalizeIncomingMessage({ type: "IMAGE", fileId: "img_1", text: "caption uno" }, basePayload, { messageId: "img_1" }),
    normalizeIncomingMessage({ type: "AUDIO", fileId: "aud_1", audioStatus: "transcribed", audioTranscript: "audio listo" }, basePayload, { messageId: "aud_1" }),
    normalizeIncomingMessage({ type: "VIDEO", fileId: "vid_1", mimeType: "video/mp4" }, basePayload, { messageId: "vid_1" }),
    normalizeIncomingMessage({ type: "FILE", fileId: "doc_1", mimeType: "application/pdf" }, basePayload, { messageId: "doc_1" })
  ];
  const campaignState = {
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "img_1", url: "https://cdn/img_1.jpg", media_type: "IMAGE", status: "received" },
      { asset_id: "asset_2", asset_index: 2, file_id: "vid_1", url: "https://cdn/vid_1.mp4", media_type: "VIDEO", status: "received" },
      { asset_id: "asset_3", asset_index: 3, file_id: "doc_1", url: "https://cdn/doc_1.pdf", media_type: "FILE", status: "received" }
    ],
    workflow_status: "idle"
  };

  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_test" });

  assert.equal(turn.text_count, 5);
  assert.equal(turn.audio_count, 1);
  assert.equal(turn.image_count, 1);
  assert.equal(turn.video_count, 1);
  assert.equal(turn.file_count, 1);
  assert.deepEqual(turn.captions, ["caption uno"]);
});

test("buildAudioBatch consolidates several audios and tolerates failures", () => {
  const batch = buildAudioBatch([
    { messageId: "a1", audio: [{ fileId: "audio_1", status: "transcribed", transcript: "hola" }], audioStatus: "transcribed" },
    { messageId: "a2", audio: [{ fileId: "audio_2", status: "failed" }], audioStatus: "failed" }
  ]);

  assert.equal(batch.count, 2);
  assert.equal(batch.transcribedCount, 1);
  assert.equal(batch.failedCount, 1);
  assert.deepEqual(batch.transcripts, ["hola"]);
});

test("context policy separates new media from previous post unless explicitly referenced", () => {
  const previousState = { workflow_status: "copy_ready" };
  const newImage = [normalizeIncomingMessage({ type: "IMAGE", fileId: "new_img" }, basePayload, { messageId: "new_img" })];
  const previousReference = [normalizeIncomingMessage({ type: "TEXT", text: "usa la segunda imagen" }, basePayload, { messageId: "ref" })];

  assert.equal(shouldStartNewTurn(newImage, previousState), true);
  assert.equal(shouldUsePreviousContext(previousReference), true);
});

test("buildOrchestratorInput compacts previous state for current-turn-only requests", () => {
  const messages = [
    normalizeIncomingMessage({ type: "TEXT", text: "Que tal este parlante?" }, basePayload, { messageId: "text" }),
    normalizeIncomingMessage({ type: "IMAGE", fileId: "img_1" }, basePayload, { messageId: "img" })
  ];
  const campaignState = {
    workflow_status: "copy_ready",
    last_copy: "texto anterior que no debe dominar",
    campaign_assets: [{ asset_id: "asset_1", file_id: "img_1", url: "https://cdn/img.jpg", media_type: "IMAGE" }]
  };
  const turn = buildUserTurn(messages, campaignState, { turnId: "turn_new" });
  const input = buildOrchestratorInput({ messages, campaignState, userTurn: turn });

  assert.equal(input.current_turn_summary.image_count, 1);
  assert.equal(input.relevant_previous_state.note, "Previous campaign content intentionally omitted for current turn.");
  assert.equal(input.campaign_state_brief.ignored, true);
  assert.equal(Array.isArray(input.allowed_actions), true);
});

test("text after previous images does not drag stale media into current turn", () => {
  const messages = [
    normalizeIncomingMessage({ type: "TEXT", text: "Hazme una lista de compras" }, basePayload, { messageId: "text_after_images" })
  ];
  const campaignState = {
    workflow_status: "media_received",
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "old_1", url: "https://cdn/old_1.jpg", media_type: "IMAGE", turn_id: "old_turn" },
      { asset_id: "asset_2", asset_index: 2, file_id: "old_2", url: "https://cdn/old_2.jpg", media_type: "IMAGE", turn_id: "old_turn" }
    ],
    last_uploaded_image: { fileId: "old_2", url: "https://cdn/old_2.jpg", type: "IMAGE" }
  };

  const turn = buildUserTurn(messages, campaignState, { turnId: "new_turn" });

  assert.equal(turn.image_count, 0);
  assert.equal(turn.current_turn_media.asset_count, 0);
  assert.equal(turn.previous_relevant_media.asset_count, 0);
  assert.equal(turn.stale_media.asset_count, 2);

  const input = buildOrchestratorInput({ messages, campaignState, userTurn: turn });
  assert.equal(input.stale_media.asset_count, 0);
  assert.equal(input.previous_relevant_media.asset_count, 0);
});

test("previous image plus audio list keeps stale media out of orchestrator input", () => {
  const messages = [
    normalizeIncomingMessage({
      type: "TEXT",
      text: "[Audio transcrito]: Me puedes ayudar a generar una lista de huevos, pan, leche y carne."
    }, basePayload, { messageId: "audio_as_text" })
  ];
  messages[0].originalType = "AUDIO";
  messages[0].audioTranscript = "Me puedes ayudar a generar una lista de huevos, pan, leche y carne.";
  const campaignState = {
    workflow_status: "collecting_assets",
    campaign_type: "bulk_from_assets",
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "old_1", url: "https://cdn/old_1.jpg", media_type: "IMAGE", turn_id: "old_turn" },
      { asset_id: "asset_2", asset_index: 2, file_id: "old_2", url: "https://cdn/old_2.jpg", media_type: "IMAGE", turn_id: "old_turn" }
    ]
  };

  const turn = buildUserTurn(messages, campaignState, { turnId: "audio_turn" });
  const input = buildOrchestratorInput({ messages, campaignState, userTurn: turn });

  assert.equal(turn.audio_count, 1);
  assert.equal(turn.stale_media.asset_count, 2);
  assert.equal(input.stale_media.asset_count, 0);
  assert.equal(input.campaign_state_brief.ignored, true);
});

test("explicit previous image reference selects previous relevant media", () => {
  const messages = [
    normalizeIncomingMessage({ type: "TEXT", text: "Usa la segunda imagen" }, basePayload, { messageId: "use_second" })
  ];
  const campaignState = {
    workflow_status: "media_received",
    campaign_assets: [
      { asset_id: "asset_1", asset_index: 1, file_id: "old_1", url: "https://cdn/old_1.jpg", media_type: "IMAGE", turn_id: "old_turn" },
      { asset_id: "asset_2", asset_index: 2, file_id: "old_2", url: "https://cdn/old_2.jpg", media_type: "IMAGE", turn_id: "old_turn" }
    ]
  };

  const turn = buildUserTurn(messages, campaignState, { turnId: "new_turn" });

  assert.equal(turn.context_policy, "use_previous_context");
  assert.equal(turn.image_count, 1);
  assert.deepEqual(turn.media_batch.fileIds, ["old_2"]);
  assert.equal(turn.previous_relevant_media.asset_count, 1);
});

test("conversation context snapshot and clear media command state", () => {
  const context = updateConversationContext(createEmptyConversationContext("test"), {
    userTurn: {
      current_turn_text: "Hazme una lista de compras",
      context_policy: "current_turn_only",
      current_turn_media: { asset_count: 0, image_count: 0, video_count: 0, file_count: 0, file_ids: [] },
      previous_relevant_media: { asset_count: 0, image_count: 0, video_count: 0, file_count: 0, file_ids: [] },
      stale_media: { asset_count: 2, image_count: 2, video_count: 0, file_count: 0, file_ids: ["old_1", "old_2"] }
    },
    route: { intent: "list" },
    lastUserGoal: "lista compras: arroz, pollo"
  });
  const data = {
    activeContext: context,
    campaignState: {
      campaign_assets: [{ asset_id: "asset_1", file_id: "old_1", url: "https://cdn/old_1.jpg" }],
      workflow_status: "media_received"
    }
  };

  assert.equal(buildContextSnapshot(data).activeIntent, "list");
  assert.match(formatContextForWhatsApp(data), /activeIntent: list/);

  const cleared = clearMediaState(data, "test_clear");
  assert.equal(cleared.campaignState.campaign_assets.length, 0);
  assert.equal(buildContextSnapshot(cleared).staleMedia, 0);
});

test("compactConversationHistory keeps only small recent history", () => {
  const compact = compactConversationHistory(Array.from({ length: 10 }, (_, index) => ({
    role: "user",
    type: "TEXT",
    text: "x".repeat(1000),
    at: String(index)
  })));

  assert.equal(compact.length, 6);
  assert.equal(compact[0].text.length, 500);
});

test("mapOrchestratorActions drops unsupported actions", () => {
  const actions = mapOrchestratorActions({
    actions: [
      { type: "generate_copy" },
      { type: "publish_to_meta" }
    ]
  });

  assert.deepEqual(actions.map((action) => action.type), ["generate_copy"]);
});
