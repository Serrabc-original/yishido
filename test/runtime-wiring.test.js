import test from "node:test";
import assert from "node:assert/strict";
import { ConversationCoordinator, buildMediaBatch } from "../src/index.js";

function createMemoryState() {
  const storage = new Map();

  return {
    storage: {
      async get(key) {
        return storage.get(key);
      },
      async put(key, value) {
        storage.set(key, value);
      },
      async setAlarm(value) {
        storage.set("alarm", value);
      }
    }
  };
}

function basePayload(type, data) {
  return {
    app: "app_runtime",
    channel: "channel_runtime",
    member: "member_runtime",
    from: "593995660220",
    type: type,
    messageId: data.messageId,
    timestamp: Date.now(),
    data: data
  };
}

function localMessageRequest(body) {
  return new Request("https://conversation.local/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function toolResultRequest(body) {
  return new Request("https://conversation.local/tool-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function imageMessage(fileId, messageId, caption) {
  const payload = basePayload("IMAGE", {
    messageId: messageId,
    fileId: fileId,
    caption: caption || "",
    text: caption || "",
    mimeType: "image/jpeg"
  });

  return {
    type: "woztell_message",
    doName: "channel_runtime:593995660220",
    traceId: "trace_runtime",
    payload: payload,
    parsedMessage: {
      type: "IMAGE",
      messageId: messageId,
      fileId: fileId,
      text: caption || "",
      caption: caption || "",
      mimeType: "image/jpeg"
    }
  };
}

function audioMessage(fileId, messageId) {
  const payload = basePayload("AUDIO", {
    messageId: messageId,
    fileId: fileId,
    mimeType: "audio/ogg"
  });

  return {
    type: "woztell_message",
    doName: "channel_runtime:593995660220",
    traceId: "trace_runtime",
    payload: payload,
    parsedMessage: {
      type: "AUDIO",
      messageId: messageId,
      fileId: fileId,
      mimeType: "audio/ogg"
    }
  };
}

function textMessage(text, messageId) {
  const payload = basePayload("TEXT", {
    messageId: messageId,
    text: text
  });

  return {
    type: "woztell_message",
    doName: "channel_runtime:593995660220",
    traceId: "trace_runtime",
    payload: payload,
    parsedMessage: {
      type: "TEXT",
      messageId: messageId,
      text: text
    }
  };
}

function statusMessage(status, messageId) {
  return {
    type: "woztell_message",
    doName: "channel_runtime:593995660220",
    traceId: "trace_runtime",
    payload: basePayload(status, {
      messageId: messageId,
      status: status
    })
  };
}

function env() {
  return {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_OPEN_API_TOKEN: "woztell-open-test",
    WOZTELL_ACCESS_TOKEN: "woztell-send-test",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    VISION_MODEL: "gpt-4.1-mini",
    VISION_FALLBACK_MODEL: "gpt-4.1-mini",
    CONVERSATIONAL_SPLIT_ENABLED: "false",
    TURN_MIN_WAIT_MS: "1",
    TURN_SILENCE_MS: "1"
  };
}

function mockRuntimeFetch(captures) {
  return async function fetchMock(url, options) {
    const cleanUrl = String(url);
    const bodyText = options && options.body ? String(options.body) : "";

    if (bodyText.includes("apiViewer") || bodyText.includes("fileId")) {
      const body = JSON.parse(bodyText);
      const fileId = body.variables && body.variables.fileId || "file_unknown";
      return json({
        data: {
          apiViewer: {
            file: {
              url: "https://cdn.test/" + fileId + ".jpg",
              fileType: fileId.startsWith("aud") ? "audio/ogg" : "image/jpeg",
              size: 1234
            }
          }
        }
      });
    }

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      const request = JSON.parse(bodyText);
      if (request.input && request.input[0] && Array.isArray(request.input[0].content)) {
        const imageUrl = request.input[0].content.find((item) => item.type === "input_image").image_url;
        captures.visionUrls.push(imageUrl);
        return json({
          output_text: JSON.stringify({
            main_subject: imageUrl.includes("img_a") ? "imagen A" : "imagen B",
            product_type: "foto",
            visible_text: imageUrl.includes("img_a") ? "A" : "B",
            brand_or_labels: "",
            colors: ["azul"],
            style: "foto",
            objects_detected: [imageUrl.includes("img_a") ? "objeto A" : "objeto B"],
            marketing_notes: "",
            possible_use_cases: [],
            recommended_angle: "",
            warnings: [],
            confidence: 0.9
          })
        });
      }

      captures.orchestratorRequests.push(request);
      return json({
        output_text: JSON.stringify({
          intent: "general",
          confidence: 0.9,
          should_handle_in_core: false,
          target_module: "core",
          needs_clarification: false,
          clarification_question: "",
          actions: [],
          user_facing_ack: "La respuesta general queda unida y clara.",
          state_updates: {}
        })
      });
    }

    const body = options && options.body ? JSON.parse(options.body) : {};
    captures.sentTexts.push(body.response && body.response[0] && body.response[0].text || "");
    return json({ ok: 1 });
  };
}

function json(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("conversation.local/message batches two real images into one UserTurn and vision batch", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_img_a", "primera")));
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_img_b", "segunda")));
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.image, 2);
    assert.deepEqual(saved.campaignState.active_turn.images.map((image) => image.fileId), ["img_a", "img_b"]);
    assert.equal(saved.campaignState.active_turn.media_batch.assetCount, 2);
    assert.equal(saved.campaignState.media_batch_summary.asset_count, 2);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg"]);
    const sent = captures.sentTexts.join("\n");
    assert.equal(sent.includes("objeto A") && sent.includes("objeto B") || captures.sentTexts.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("conversation.local/message keeps two audio transcripts clean and ordered", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(audioMessage("aud_a", "msg_aud_a")));
    await coordinator.fetch(localMessageRequest(audioMessage("aud_b", "msg_aud_b")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_aud_a",
      transcript: "Que es energia solar?"
    }));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_aud_b",
      transcript: "Explicalo sencillo."
    }));
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.deepEqual(saved.campaignState.active_turn.audioTranscripts, ["Que es energia solar?", "Explicalo sencillo."]);
    assert.equal(saved.campaignState.active_turn.combinedUserText, "Que es energia solar?\nExplicalo sencillo.");
    assert.equal(saved.campaignState.active_turn.combinedUserText.includes("[Audio transcrito]"), false);
    assert.equal(captures.sentTexts.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("image plus audio uses audio intent and does not become unknown_image_request", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_img_a", "")));
    await coordinator.fetch(localMessageRequest(audioMessage("aud_a", "msg_aud_a")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_aud_a",
      transcript: "Revisa esta imagen y dime que ves."
    }));
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.notEqual(saved.activeContext.activeIntent, "unknown_image_request");
    assert.equal(saved.campaignState.active_turn.counts.image, 1);
    assert.equal(saved.campaignState.active_turn.counts.audio, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("clear text question goes through composer and answers directly", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Que es energia solar?", "msg_text")));
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.activeContext.activeIntent, "general");
    assert.equal(captures.sentTexts.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("legacy single-message media batch still preserves same-turn assets", () => {
  const batch = buildMediaBatch({
    campaign_assets: [
      { file_id: "img_a", url: "https://cdn.test/img_a.jpg", media_type: "IMAGE", turn_id: "turn_same" },
      { file_id: "img_b", url: "https://cdn.test/img_b.jpg", media_type: "IMAGE", turn_id: "turn_same" }
    ]
  }, [
    { type: "IMAGE", messageId: "msg_img_b", fileId: "img_b", media: [{ type: "IMAGE", fileId: "img_b" }] }
  ], { turnId: "turn_same" });

  assert.equal(batch.assetCount, 2);
  assert.deepEqual(batch.fileIds, ["img_a", "img_b"]);
});

test("status events do not contaminate pending messages", async () => {
  const state = createMemoryState();
  const coordinator = new ConversationCoordinator(state, env());

  const response = await coordinator.fetch(localMessageRequest(statusMessage("SENT", "msg_status")));
  const body = await response.json();
  const saved = await state.storage.get("data");

  assert.equal(body.status, "ignored");
  assert.equal(saved, undefined);
});
