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

function audioReplyMessage(fileId, messageId, quotedMessageId) {
  const message = audioMessage(fileId, messageId);
  message.payload.data.context = { messageId: quotedMessageId };
  message.parsedMessage.context = { messageId: quotedMessageId };
  return message;
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

function unsupportedMediaContainer(messageId) {
  return {
    type: "woztell_message",
    doName: "channel_runtime:593995660220",
    traceId: "trace_runtime",
    payload: basePayload("", {
      messageId: messageId,
      errorCode: "131051",
      error: { code: "131051", message: "Message type unknown" }
    })
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
    TURN_SILENCE_MS: "1",
    TURN_MAX_WAIT_MS: "50",
    IMAGE_MESSAGE_WAIT_SECONDS: "1",
    BUFFER_MAX_WAIT_SECONDS: "1"
  };
}

function mockRuntimeFetch(captures) {
  return async function fetchMock(url, options) {
    const cleanUrl = String(url);
    const bodyText = options && options.body ? String(options.body) : "";

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      const request = JSON.parse(bodyText);
      const content = request.input && request.input[0] && Array.isArray(request.input[0].content)
        ? request.input[0].content
        : [];
      const imageInput = content.find((item) => item.type === "input_image");
      if (imageInput) {
        const imageUrl = imageInput.image_url;
        captures.visionUrls.push(imageUrl);
        return json({
          output_text: JSON.stringify({
            main_subject: captures.forceVisionNoImageText && imageUrl.includes("img_a")
              ? "captura con texto visible: No veo ninguna imagen adjunta en este turno"
              : imageUrl.includes("img_a") ? "imagen A" : imageUrl.includes("img_b") ? "imagen B" : "imagen C",
            product_type: "foto",
            visible_text: captures.forceVisionNoImageText && imageUrl.includes("img_a")
              ? "No veo ninguna imagen adjunta en este turno. Puedes reenviarla?"
              : imageUrl.includes("img_a") ? "A" : imageUrl.includes("img_b") ? "B" : "C",
            brand_or_labels: "",
            colors: ["azul"],
            style: "foto",
            objects_detected: [imageUrl.includes("img_a") ? "objeto A" : imageUrl.includes("img_b") ? "objeto B" : "objeto C"],
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
          user_facing_ack: captures.forceNoImage ? "No veo la imagen en este turno." : captures.forceBadGeneric
            ? "¿Quieres que lo explique, lo resuma o revise algún detalle puntual?"
            : "La respuesta general queda unida y clara.",
          state_updates: {}
        })
      });
    }

    if (bodyText.includes("apiViewer")) {
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

function installFakeClock(start) {
  const originalNow = Date.now;
  let now = start;
  Date.now = () => now;
  return {
    tick(ms) {
      now += ms;
    },
    restore() {
      Date.now = originalNow;
    }
  };
}

test("concurrent WhatsApp images append atomically into one pending turn", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const clock = installFakeClock(1781471000000);
  globalThis.fetch = mockRuntimeFetch(captures);
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
    originalLog(...args);
  };
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await Promise.all([
      coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_conc_a", "a"))),
      coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_conc_b", "b"))),
      coordinator.fetch(localMessageRequest(imageMessage("img_c", "msg_conc_c", "c")))
    ]);

    let saved = await state.storage.get("data");
    assert.equal(saved.pendingMessages.length, 3);
    assert.equal(new Set(saved.pendingMessages.map((message) => message.turnId)).size, 1);
    assert.equal(logLines.filter((line) => line.includes("TURN_REUSED_FOR_EVENT")).length >= 2, true);

    clock.tick(100);
    await coordinator.processBuffer();
    saved = await state.storage.get("data");

    assert.equal(saved.campaignState.active_turn.counts.image, 3);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg", "https://cdn.test/img_c.jpg"]);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    clock.restore();
  }
});

test("three images plus listo closes the same pending turn", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471100000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await Promise.all([
      coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_done_a", ""))),
      coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_done_b", ""))),
      coordinator.fetch(localMessageRequest(imageMessage("img_c", "msg_done_c", "")))
    ]);
    let saved = await state.storage.get("data");
    const turnId = saved.currentTurnId;

    await coordinator.fetch(localMessageRequest(textMessage("Listo", "msg_done_text")));
    saved = await state.storage.get("data");

    assert.equal(saved.campaignState.active_turn.turn_id, turnId);
    assert.equal(saved.campaignState.active_turn.counts.image, 3);
    assert.equal(saved.pendingMessages.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("unsupported 131051 before concurrent images does not contaminate batch", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471200000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    const unsupported = await coordinator.fetch(localMessageRequest(unsupportedMediaContainer("msg_album_hint")));
    const unsupportedBody = await unsupported.json();
    assert.equal(unsupportedBody.status, "ignored");

    await Promise.all([
      coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_album_a", ""))),
      coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_album_b", ""))),
      coordinator.fetch(localMessageRequest(imageMessage("img_c", "msg_album_c", "")))
    ]);

    let saved = await state.storage.get("data");
    assert.equal(saved.pendingMessages.length, 3);
    assert.equal(saved.pendingMessages.some((message) => message.type === "UNSUPPORTED"), false);
    clock.tick(100);
    await coordinator.processBuffer();
    saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.image, 3);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("audio reply to a quoted image carries referenced media into UserTurn", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [], forceNoImage: true };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471300000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_ref_img", "referencia")));
    clock.tick(100);
    await coordinator.processBuffer();

    await coordinator.fetch(localMessageRequest(audioReplyMessage("aud_ref", "msg_ref_audio", "msg_ref_img")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_ref_audio",
      transcript: "Revisa esta imagen y dime lo importante."
    }));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.audio, 1);
    assert.equal(saved.campaignState.active_turn.counts.image, 1);
    assert.equal(captures.sentTexts.join("\n").includes("No veo la imagen"), false);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("concurrent audio messages share one pending turn and combine transcripts", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471400000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await Promise.all([
      coordinator.fetch(localMessageRequest(audioMessage("aud_a", "msg_conc_aud_a"))),
      coordinator.fetch(localMessageRequest(audioMessage("aud_b", "msg_conc_aud_b")))
    ]);

    let saved = await state.storage.get("data");
    assert.equal(saved.pendingMessages.length, 2);
    assert.equal(new Set(saved.pendingMessages.map((message) => message.turnId)).size, 1);

    await coordinator.fetch(toolResultRequest({ type: "audio_transcribed", messageId: "msg_conc_aud_a", transcript: "Primera pregunta." }));
    await coordinator.fetch(toolResultRequest({ type: "audio_transcribed", messageId: "msg_conc_aud_b", transcript: "Segunda pregunta." }));
    clock.tick(100);
    await coordinator.processBuffer();

    saved = await state.storage.get("data");
    assert.deepEqual(saved.campaignState.active_turn.audioTranscripts, ["Primera pregunta.", "Segunda pregunta."]);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("conversation.local/message batches three images only after turn max wait", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781466000000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_img_a", "primera")));
    clock.tick(5);
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_img_b", "segunda")));
    clock.tick(5);
    await coordinator.fetch(localMessageRequest(imageMessage("img_c", "msg_img_c", "tercera")));

    let saved = await state.storage.get("data");
    assert.equal(new Set(saved.pendingMessages.map((message) => message.turnId)).size, 1);
    assert.equal(saved.pendingMessages.length, 3);
    assert.equal(captures.visionUrls.length, 0);
    assert.equal(captures.sentTexts.length, 0);

    await coordinator.processBuffer();
    saved = await state.storage.get("data");
    assert.equal(saved.pendingMessages.length, 3);
    assert.equal(captures.visionUrls.length, 0);
    assert.equal(captures.sentTexts.length, 0);

    clock.tick(100);
    await coordinator.processBuffer();

    saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.image, 3);
    assert.deepEqual(saved.campaignState.active_turn.images.map((image) => image.fileId), ["img_a", "img_b", "img_c"]);
    assert.equal(saved.campaignState.active_turn.media_batch.assetCount, 3);
    assert.equal(saved.campaignState.media_batch_summary.asset_count, 3);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg", "https://cdn.test/img_c.jpg"]);
    assert.equal(captures.sentTexts.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("conversation.local/message batches two real images into one UserTurn and vision batch", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781466100000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_img_a", "primera")));
    clock.tick(5);
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_img_b", "segunda")));
    assert.equal(captures.visionUrls.length, 0);
    assert.equal(captures.sentTexts.length, 0);
    clock.tick(100);
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
    clock.restore();
  }
});

test("conversation.local/message keeps two audio transcripts clean and ordered", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781466200000);
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
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.deepEqual(saved.campaignState.active_turn.audioTranscripts, ["Que es energia solar?", "Explicalo sencillo."]);
    assert.equal(saved.campaignState.active_turn.combinedUserText, "Que es energia solar?\nExplicalo sencillo.");
    assert.equal(saved.campaignState.active_turn.combinedUserText.includes("[Audio transcrito]"), false);
    assert.equal(captures.sentTexts.length > 0, true);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("two images plus audio use audio intent and vision receives both images", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781466300000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_img_a", "")));
    clock.tick(5);
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_img_b", "")));
    clock.tick(5);
    await coordinator.fetch(localMessageRequest(audioMessage("aud_a", "msg_aud_a")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_aud_a",
      transcript: "Revisa esta imagen y dime que ves."
    }));
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.notEqual(saved.activeContext.activeIntent, "unknown_image_request");
    assert.equal(saved.campaignState.active_turn.counts.image, 2);
    assert.equal(saved.campaignState.active_turn.counts.audio, 1);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg"]);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
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

test("bad generic reply is blocked for clear text request", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [], forceBadGeneric: true };
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = mockRuntimeFetch(captures);
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Que opinas de este libro y que ingredientes le pongo al aguacate molido?", "msg_text_bad")));
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.equal(sent.includes("¿Quieres que lo explique"), false);
    assert.match(sent, /aguacate|ingredientes/i);
    assert.equal(logLines.some((line) => line.includes("BAD_GENERIC_REPLY_BLOCKED")), true);
    assert.equal(logLines.some((line) => line.includes("DIRECT_GENERAL_ANSWER_FORCED")), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("visible OCR text that says no image does not trigger false no-image guardrail", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [], forceVisionNoImageText: true };
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const clock = installFakeClock(1781475200000);
  globalThis.fetch = mockRuntimeFetch(captures);
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Lee el texto visible de esta imagen", "msg_ocr_text")));
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_ocr_image", "")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /No veo ninguna imagen adjunta/i);
    assert.equal(logLines.some((line) => line.includes("FALSE_NO_IMAGE_REPLY_BLOCKED")), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    clock.restore();
  }
});

test("runtime commands /version and /reset keep short-circuit behavior", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    const versionResponse = await coordinator.fetch(localMessageRequest(textMessage("/version", "msg_version")));
    const versionBody = await versionResponse.json();
    assert.equal(versionBody.status, "version_sent");
    assert.equal(captures.sentTexts.length, 1);

    await coordinator.fetch(localMessageRequest(textMessage("texto pendiente", "msg_pending")));
    let saved = await state.storage.get("data");
    assert.equal(saved.pendingMessages.length, 1);

    const resetResponse = await coordinator.fetch(localMessageRequest(textMessage("/reset", "msg_reset")));
    const resetBody = await resetResponse.json();
    saved = await state.storage.get("data");

    assert.equal(resetBody.status, "reset_done");
    assert.equal(saved.pendingMessages.length, 0);
    assert.equal(saved.currentTurnId, "");
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
