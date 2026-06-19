import test from "node:test";
import assert from "node:assert/strict";
import worker, { ConversationCoordinator, buildMediaBatch } from "../src/index.js";

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

function createMemoryKV(initial) {
  const storage = new Map(Object.entries(initial || {}));
  return {
    async get(key) {
      return storage.get(key) || null;
    },
    async put(key, value) {
      storage.set(key, value);
    },
    dump() {
      return Object.fromEntries(storage.entries());
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

function v2Env(extra) {
  return Object.assign(env(), {
    INTENT_ROUTER_V2_ENABLED: "true",
    POLICY_GATE_ENABLED: "true",
    REPLY_COMPOSER_V2_ENABLED: "true"
  }, extra || {});
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
          user_facing_ack: captures.forceNoImage ? "No veo la imagen en este turno." : captures.forceOnlyOneImage ? "Me llego solo una imagen, reenviame la otra." : captures.forceBadGeneric
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

function assertNoCustomerTechnicalLeak(text) {
  assert.doesNotMatch(text, /Durable Object/i);
  assert.doesNotMatch(text, /scheduled_alarm|scheduled_mock/i);
  assert.doesNotMatch(text, /modo:\s*alarm/i);
  assert.doesNotMatch(text, /scheduler/i);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
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

test("single image without user intent asks what to do without vision description", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471250000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_lonely", "msg_lonely_img", "")));
    assert.equal(captures.visionUrls.length, 0);
    assert.equal(captures.sentTexts.length, 0);

    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    const sent = captures.sentTexts.join("\n");
    assert.equal(saved.campaignState.active_turn.counts.image, 1);
    assert.equal(captures.visionUrls.length, 0);
    assert.match(sent, /Recibi la imagen|analice|texto visible|compare|puntual/i);
    assert.doesNotMatch(sent, /imagen A|objeto A|captura de/i);
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

test("three images across different turnIds plus listo use recent media fallback", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471500000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    for (const item of [
      ["img_a", "msg_split_a"],
      ["img_b", "msg_split_b"],
      ["img_c", "msg_split_c"]
    ]) {
      await coordinator.fetch(localMessageRequest(imageMessage(item[0], item[1], "")));
      clock.tick(100);
      await coordinator.processBuffer();
      clock.tick(1000);
    }

    let saved = await state.storage.get("data");
    assert.equal(saved.recentMediaAssets.length, 3);
    assert.equal(new Set(saved.recentMediaAssets.map((asset) => asset.turnId)).size, 3);

    captures.visionUrls.length = 0;
    captures.sentTexts.length = 0;
    await coordinator.fetch(localMessageRequest(textMessage("Listo", "msg_split_done")));
    clock.tick(100);
    await coordinator.processBuffer();
    saved = await state.storage.get("data");

    assert.equal(saved.campaignState.active_turn.counts.image, 3);
    assert.deepEqual(saved.campaignState.active_turn.images.map((image) => image.fileId).sort(), ["img_a", "img_b", "img_c"]);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg", "https://cdn.test/img_c.jpg"]);
    const byFileId = new Map(saved.campaignState.campaign_assets.map((asset) => [asset.file_id, asset]));
    assert.equal(byFileId.get("img_a").analysis.visible_text, "A");
    assert.equal(byFileId.get("img_b").analysis.visible_text, "B");
    assert.equal(byFileId.get("img_c").analysis.visible_text, "C");
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("unsupported 131051 plus split image turns still use recent media fallback", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471600000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    const unsupported = await coordinator.fetch(localMessageRequest(unsupportedMediaContainer("msg_split_album_hint")));
    assert.equal((await unsupported.json()).status, "ignored");

    for (const item of [
      ["img_a", "msg_split_album_a"],
      ["img_b", "msg_split_album_b"],
      ["img_c", "msg_split_album_c"]
    ]) {
      await coordinator.fetch(localMessageRequest(imageMessage(item[0], item[1], "")));
      clock.tick(100);
      await coordinator.processBuffer();
      clock.tick(1000);
    }

    captures.visionUrls.length = 0;
    await coordinator.fetch(localMessageRequest(textMessage("esas son", "msg_split_album_done")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.image, 3);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg", "https://cdn.test/img_c.jpg"]);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("affirmative follow-up reuses recent image batch after visual offer", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471650000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_follow_a", "")));
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_follow_b", "")));
    clock.tick(100);
    await coordinator.processBuffer();

    let saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.image, 2);
    assert.equal(saved.activeContext.lastOfferedAction, "image_ocr");

    captures.visionUrls.length = 0;
    captures.sentTexts.length = 0;
    await coordinator.fetch(localMessageRequest(textMessage("sí, porfa", "msg_follow_yes")));
    clock.tick(100);
    await coordinator.processBuffer();
    saved = await state.storage.get("data");

    assert.equal(saved.campaignState.active_turn.counts.image, 2);
    assert.deepEqual(captures.visionUrls.sort(), ["https://cdn.test/img_a.jpg", "https://cdn.test/img_b.jpg"]);
    const byFileId = new Map(saved.campaignState.campaign_assets.map((asset) => [asset.file_id, asset]));
    assert.equal(byFileId.get("img_a").analysis.visible_text, "A");
    assert.equal(byFileId.get("img_b").analysis.visible_text, "B");
    assert.doesNotMatch(captures.sentTexts.join("\n"), /que quieres|qué quieres/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("image design request with recent media enqueues uploaded image edit without reasking", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [], imageJobs: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471680000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const runtimeEnv = Object.assign(env(), {
    IMAGE_QUEUE: {
      async send(job) {
        captures.imageJobs.push(job);
      }
    }
  });
  const coordinator = new ConversationCoordinator(state, runtimeEnv);

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_design_img", "")));
    clock.tick(100);
    await coordinator.processBuffer();

    captures.sentTexts.length = 0;
    captures.visionUrls.length = 0;
    captures.orchestratorRequests.length = 0;
    await coordinator.fetch(localMessageRequest(textMessage("Diseñame una imagen bonita con esta foto", "msg_design_text")));
    clock.tick(100);
    await coordinator.processBuffer();

    assert.deepEqual(captures.visionUrls, ["https://cdn.test/img_a.jpg"]);
    assert.equal(captures.orchestratorRequests.length, 0);
    assert.equal(captures.imageJobs.length, 1);
    assert.equal(captures.imageJobs[0].type, "edit_image");
    assert.equal(captures.imageJobs[0].source, "uploaded_image");
    assert.doesNotMatch(captures.sentTexts.join("\n"), /reenv[ií]a|no veo|qu[eé] quieres/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("audio that refers to recent image uses recent media fallback", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471700000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_recent_img", "")));
    clock.tick(100);
    await coordinator.processBuffer();

    captures.visionUrls.length = 0;
    await coordinator.fetch(localMessageRequest(audioMessage("aud_recent", "msg_recent_audio")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_recent_audio",
      transcript: "Revisa esta imagen y dime lo importante."
    }));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.campaignState.active_turn.counts.audio, 1);
    assert.equal(saved.campaignState.active_turn.counts.image, 1);
    assert.deepEqual(captures.visionUrls, ["https://cdn.test/img_a.jpg"]);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("false no-image and only-one replies are blocked when recent media exists", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [], forceNoImage: true };
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const clock = installFakeClock(1781471800000);
  globalThis.fetch = mockRuntimeFetch(captures);
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_guard_a", "")));
    clock.tick(100);
    await coordinator.processBuffer();
    captures.sentTexts.length = 0;

    await coordinator.fetch(localMessageRequest(textMessage("Dame una opinion corta", "msg_guard_text")));
    clock.tick(100);
    await coordinator.processBuffer();

    let sent = captures.sentTexts.join("\n");
    assert.equal(/No veo la imagen/i.test(sent), false);
    assert.equal(logLines.some((line) => line.includes("FALSE_NO_IMAGE_REPLY_BLOCKED")), true);
    assert.equal(logLines.some((line) => line.includes("RECENT_MEDIA_USED_TO_REPAIR_IMAGE_REPLY")), true);

    captures.forceNoImage = false;
    captures.forceOnlyOneImage = true;
    captures.sentTexts.length = 0;
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_guard_b", "")));
    clock.tick(100);
    await coordinator.processBuffer();
    captures.sentTexts.length = 0;

    await coordinator.fetch(localMessageRequest(textMessage("Dame otra opinion corta", "msg_guard_two")));
    clock.tick(100);
    await coordinator.processBuffer();

    sent = captures.sentTexts.join("\n");
    assert.equal(/solo una imagen|reenviame la otra/i.test(sent), false);
    assert.equal(logLines.some((line) => line.includes("FALSE_ONLY_ONE_IMAGE_REPLY_BLOCKED")), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
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

test("multi-image OCR sends one WhatsApp message per image", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781475200000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Lee el texto visible de estas imagenes", "msg_ocr_text_multi")));
    await coordinator.fetch(localMessageRequest(imageMessage("img_a", "msg_ocr_a", "")));
    await coordinator.fetch(localMessageRequest(imageMessage("img_b", "msg_ocr_b", "")));
    clock.tick(100);
    await coordinator.processBuffer();

    const imageMessages = captures.sentTexts.filter((text) => /^Imagen \d+/i.test(text));
    assert.equal(imageMessages.length, 2);
    assert.match(imageMessages[0], /Texto visible:\nA/i);
    assert.match(imageMessages[1], /Texto visible:\nB/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime handles simple list before legacy orchestration", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781475300000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, v2Env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Hazme una lista de leche, pan y huevos", "msg_v2_simple_list")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Listo/);
    assert.match(sent, /1\. Leche/);
    assert.match(sent, /2\. Pan/);
    assert.match(sent, /3\. Huevos/);
    assert.equal(captures.orchestratorRequests.length, 0);

    const saved = await state.storage.get("data");
    assert.equal(saved.traceEvents.some((event) => event.event === "INTENT_ROUTER_V2_DECISION"), true);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime creates list reminder without copying audio filler", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-17T22:00:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, v2Env({ REMINDERS_DELIVERY_MODE: "alarm" }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Gracias eh a ver queria que me ayudes a generar una lista y que esa lista me hagas acuerdo en diez minutos ah esta lista eh es para unas compras de eh Supermaxi entonces lo que necesito es pollo, carne, pescado, aceite ah comida para peces, sal, y pan. Eso necesito comprar, pero acuerdame diez minutos.", "msg_v2_audio_supermaxi")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Te guarde la lista y te la recuerdo en 10 minutos/i);
    assert.match(sent, /1\. Pollo/);
    assert.match(sent, /5\. Comida para peces/);
    assert.doesNotMatch(sent, /Gracias eh|queria que me ayudes|creo que eso/i);
    assert.equal(captures.orchestratorRequests.length, 0);

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.equal(saved.coreUtilityState.reminders[0].title, "lista super");
    assert.match(saved.coreUtilityState.reminders[0].message, /pollo, carne, pescado, aceite, comida para peces, sal, pan/i);
    assert.doesNotMatch(saved.coreUtilityState.reminders[0].message, /Gracias eh|queria que me ayudes/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime remembers ephemeral list for follow-up reminder", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-17T22:10:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, v2Env({ REMINDERS_DELIVERY_MODE: "alarm" }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("me puedes caer una lista quiero hacer eh una lista para Supermaxi que sea de huevos, pan, carne, queso ah leche crema zanahoria en blanca ah y creo que eso", "msg_v2_supermaxi_list")));
    clock.tick(100);
    await coordinator.processBuffer();

    await coordinator.fetch(localMessageRequest(textMessage("Me puedes hacer acuerdo de esa lista en 20 minutos??", "msg_v2_supermaxi_followup")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /1\. Huevos/);
    assert.match(sent, /7\. Zanahoria en blanca/);
    assert.match(sent, /Te recuerdo lista super en 20 minutos/i);
    assert.doesNotMatch(sent, /actualice tu lista de en 20 minutos|lista de en 20 minutos/i);
    assert.equal(captures.orchestratorRequests.length, 0);

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.equal(saved.coreUtilityState.reminders[0].title, "lista super");
    assert.match(saved.coreUtilityState.reminders[0].message, /huevos, pan, carne, queso, leche, crema, zanahoria en blanca/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime completes pending reminder clarification", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-17T22:20:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, v2Env({ REMINDERS_DELIVERY_MODE: "alarm" }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Oye me puedes hacer acuerdo de un correo que debo enviar a un cliente que diga que le estoy haciendo seguimiento para poder dar la reunion entonces ahi le puedes mandar mi link por favor", "msg_v2_email_reminder")));
    clock.tick(100);
    await coordinator.processBuffer();

    let saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.pendingReminderDraft.title, "correo de seguimiento al cliente");

    await coordinator.fetch(localMessageRequest(textMessage("me lo puedes recordar en dos minutos por favor y tambien me puedes enviar el correo", "msg_v2_email_reminder_time")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Cuando quieres que te lo recuerde/i);
    assert.match(sent, /Te recuerdo correo de seguimiento al cliente en 2 minutos/i);
    assert.doesNotMatch(sent, /Responder sin herramienta|No hay intencion clara/i);
    assert.equal(captures.orchestratorRequests.length, 0);

    saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.pendingReminderDraft, null);
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.equal(saved.coreUtilityState.reminders[0].title, "correo de seguimiento al cliente");
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime repairs correction without creating tools", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781475310000);
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      pendingReminderDraft: {
        action: "create",
        title: "hacer un recordatorio",
        missingFields: ["dueAt"]
      },
      reminders: []
    }
  });
  const coordinator = new ConversationCoordinator(state, v2Env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("No no te estoy preguntando en cuantos minutos me vas a hacer acuerdo", "msg_v2_correction")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Tienes razon/);
    assert.match(sent, /No voy a crear nada todavia/);
    assert.equal(captures.orchestratorRequests.length, 0);

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.pendingReminderDraft, null);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime applies confirmed CRM update locally", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781475320000);
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      clients: [],
      pendingCrmAction: {
        intent: "crm.update",
        entities: {
          name: "Juan Perez",
          email: "nuevo@test.com",
          phone: "0999999999",
          notes: "quiere plan premium"
        },
        status: "awaiting_confirmation"
      }
    }
  });
  const coordinator = new ConversationCoordinator(state, v2Env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("si guardalo", "msg_v2_crm_confirm")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Actualice el cliente: Juan Perez/i);
    assert.equal(captures.orchestratorRequests.length, 0);

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.pendingCrmAction, null);
    assert.equal(saved.coreUtilityState.clients.length, 1);
    assert.equal(saved.coreUtilityState.clients[0].email, "nuevo@test.com");
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("IntentRouterV2 runtime returns existing document references without generation", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781475330000);
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      documents: [{
        id: "doc_catalogo",
        name: "Catalogo actualizado",
        url: "https://docs.test/catalogo.pdf"
      }]
    }
  });
  const coordinator = new ConversationCoordinator(state, v2Env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Pasame el catalogo actualizado", "msg_v2_document")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Encontre el documento existente/i);
    assert.match(sent, /https:\/\/docs\.test\/catalogo\.pdf/i);
    assert.doesNotMatch(sent, /generar/i);
    assert.equal(captures.orchestratorRequests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("alarm delivery sends due reminders in production alarm mode", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-06-15T15:00:00.000Z");
  const clock = installFakeClock(now);
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      reminders: [{
        id: "rem_due",
        reminderId: "rem_due",
        title: "comprar huevos",
        message: "comprar huevos",
        dueAt: "2026-06-15T15:00:00.000Z",
        status: "scheduled_alarm",
        deliveryMode: "alarm",
        channelId: "channel_runtime",
        recipientId: "593995660220",
        memberId: "member_runtime",
        appId: "app_runtime",
        lastUserInteractionAt: "2026-06-15T14:50:00.000Z"
      }]
    }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    REMINDERS_DELIVERY_MODE: "alarm"
  }));

  try {
    await coordinator.alarm();
    assert.equal(captures.sentTexts.some((text) => /Recordatorio: comprar huevos/i.test(text)), true);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("daily usage report sends usage summary after configured hour", async () => {
  const state = createMemoryState();
  const usageKey = "usage:daily:2026-06-15:channel_runtime:593995660220";
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const now = Date.parse("2026-06-15T23:01:00.000Z");
  const clock = installFakeClock(now);
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: { reminders: [], usageReports: {} }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    REMINDERS_DELIVERY_MODE: "alarm",
    DAILY_USAGE_REPORT_ENABLED: "true",
    DAILY_USAGE_REPORT_HOUR: "18",
    USER_TIMEZONE: "America/Bogota",
    SESSIONS_KV: createMemoryKV({
      [usageKey]: JSON.stringify({
        doName: "channel_runtime:593995660220",
        reportDate: "2026-06-15",
        callCount: 3,
        estimatedUsd: 0.0123,
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        byPurpose: { orchestrator: { calls: 2, estimatedUsd: 0.01 }, vision_analysis: { calls: 1, estimatedUsd: 0.0023 } }
      })
    })
  }));

  try {
    await coordinator.alarm();
    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /Reporte diario de créditos IA/i);
    assert.match(sent, /Llamadas IA: 3/i);
    assert.match(sent, /Costo estimado: \$0\.0123/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("reminder follow-up uses compact latest audio summary as title", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-15T23:55:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    customerMemory: {
      last_audio_summary: "llamar al cliente"
    },
    coreUtilityState: {
      reminders: [],
      pendingReminderDraft: {
        action: "create",
        title: "",
        dueAt: "2026-06-16T00:00:00.000Z",
        timezone: "America/Bogota",
        context: "En 5 min",
        reminderOffsets: [],
        recurrence: null,
        confidence: 0.65,
        missingFields: ["title"],
        hasDate: true,
        hasTime: true
      },
      usageReports: {}
    }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_REMINDERS: "true",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Lo que te dije en el audio", "msg_audio_ref_title")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    const sent = captures.sentTexts.join("\n");
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.equal(saved.coreUtilityState.reminders[0].title, "llamar al cliente");
    assert.equal(saved.coreUtilityState.pendingReminderDraft, null);
    assert.match(sent, /Listo, guard[ée] el recordatorio/i);
    assert.doesNotMatch(sent, /Qu[eé] quieres que te recuerde/i);
    assert.equal(captures.orchestratorRequests.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("reminder time follow-up keeps previous pending title instead of generic relative wording", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T05:22:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      reminders: [],
      pendingReminderDraft: {
        action: "create",
        title: "llamar a un cliente para hacerle seguimiento",
        dueAt: "",
        timezone: "America/Bogota",
        context: "Recordatorio: llamar a un cliente para hacerle seguimiento",
        reminderOffsets: [],
        recurrence: null,
        confidence: 0.65,
        missingFields: ["date", "time"],
        hasDate: false,
        hasTime: false
      },
      usageReports: {}
    }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_REMINDERS: "true",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Para en dentro de 5min", "msg_time_followup")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.equal(saved.coreUtilityState.reminders[0].title, "llamar a un cliente para hacerle seguimiento");
    assert.match(saved.coreUtilityState.reminders[0].dueAt, /^2026-06-16T05:27:00/);
    assert.doesNotMatch(captures.sentTexts.join("\n"), /Asunto: Para en/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("reminder title follow-up can resolve the active shopping list", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T05:12:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    coreUtilityState: {
      reminders: [],
      listsState: {
        lists: {
          compras: {
            name: "compras",
            items: [
              { id: "item_1", text: "huevos", done: false },
              { id: "item_2", text: "pan", done: false },
              { id: "item_3", text: "leche", done: false }
            ]
          }
        }
      },
      lists: {
        compras: {
          name: "compras",
          items: [
            { id: "item_1", text: "huevos", done: false },
            { id: "item_2", text: "pan", done: false },
            { id: "item_3", text: "leche", done: false }
          ]
        }
      },
      activeList: "compras",
      pendingReminderDraft: {
        action: "create",
        title: "",
        dueAt: "2026-06-16T05:17:00.000Z",
        timezone: "America/Bogota",
        context: "en 5 minutos",
        reminderOffsets: [],
        recurrence: null,
        confidence: 0.65,
        missingFields: ["title"],
        hasDate: true,
        hasTime: true
      },
      usageReports: {}
    }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_REMINDERS: "true",
    ENABLE_LISTS: "true",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Si, pero el asunto es la lista que me anotaste", "msg_list_ref_title")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.match(saved.coreUtilityState.reminders[0].title, /lista compras: huevos, pan, leche/i);
    assert.doesNotMatch(captures.sentTexts.join("\n"), /lista .*est[aá] vac[ií]a/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("audio list plus reminder creates the shopping list before scheduling the reminder", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T17:48:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "true",
    REMINDERS_DELIVERY_MODE: "alarm",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(audioMessage("aud_list_reminder", "msg_audio_list_reminder")));
    await coordinator.fetch(toolResultRequest({
      type: "audio_transcribed",
      messageId: "msg_audio_list_reminder",
      transcript: "Hazme una lista de compras con huevos, leche, pan y queso y hazme acuerdo en 10 minutos."
    }));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    const list = saved.coreUtilityState.lists && saved.coreUtilityState.lists.compras;
    const listItems = list && Array.isArray(list.items) ? list.items.map((item) => item.text) : [];
    const sent = captures.sentTexts.join("\n");

    assert.deepEqual(listItems, ["huevos", "leche", "pan", "queso"]);
    assert.equal(listItems.includes("hazme acuerdo en 10 minutos"), false);
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.match(saved.coreUtilityState.reminders[0].title, /lista compras: huevos, leche, pan, queso/i);
    assert.equal(saved.coreUtilityState.pendingReminderDraft, null);
    assert.equal(captures.orchestratorRequests.length, 0);
    assertNoCustomerTechnicalLeak(sent);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("text list plus reminder creates both artifacts without storing reminder wording as a list item", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T17:48:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "true",
    REMINDERS_DELIVERY_MODE: "alarm",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Ayudame a comprar huevos, leche, pan, queso, ponme una lista y hazme acuerdo en 10 minutos.", "msg_text_list_reminder")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    const list = saved.coreUtilityState.lists && saved.coreUtilityState.lists.compras;
    const listItems = list && Array.isArray(list.items) ? list.items.map((item) => item.text) : [];
    const sent = captures.sentTexts.join("\n");

    assert.deepEqual(listItems, ["huevos", "leche", "pan", "queso"]);
    assert.equal(listItems.includes("hazme acuerdo en 10 minutos"), false);
    assert.equal(saved.coreUtilityState.reminders.length, 1);
    assert.match(saved.coreUtilityState.reminders[0].title, /lista compras: huevos, leche, pan, queso/i);
    assert.equal(saved.coreUtilityState.pendingReminderDraft, null);
    assert.equal(captures.orchestratorRequests.length, 0);
    assertNoCustomerTechnicalLeak(sent);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("asking which list was given after a compound request returns the real saved list", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T17:48:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "true",
    REMINDERS_DELIVERY_MODE: "alarm",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Hazme una lista de compras con huevos, leche, pan y queso y hazme acuerdo en 10 minutos.", "msg_compound_before_followup")));
    clock.tick(100);
    await coordinator.processBuffer();

    captures.sentTexts.length = 0;
    await coordinator.fetch(localMessageRequest(textMessage("Cual era la lista que te di??", "msg_which_list")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /huevos/i);
    assert.match(sent, /leche/i);
    assert.match(sent, /pan/i);
    assert.match(sent, /queso/i);
    assert.doesNotMatch(sent, /lista .*est[aá] vac[ií]a/i);
    assert.equal(saved.coreUtilityState.activeList, "compras");
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("audio-list repair does not answer empty when compact memory contains the recent audio list", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T17:58:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  await state.storage.put("data", {
    doName: "channel_runtime:593995660220",
    channel: "channel_runtime",
    phone: "593995660220",
    member: "member_runtime",
    app: "app_runtime",
    customerMemory: {
      last_audio_summary: "lista de compras con huevos, leche, pan y queso"
    },
    conversationLog: [{
      turnId: "turn_recent_audio",
      role: "user",
      textPreview: "[Audio transcrito]: Hazme una lista de compras con huevos, leche, pan y queso",
      audioTranscripts: ["Hazme una lista de compras con huevos, leche, pan y queso"],
      media: { fileIds: [], assetCount: 0, failedAssetCount: 0 }
    }],
    coreUtilityState: {
      reminders: [],
      usageReports: {}
    }
  });
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "true",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Te di la lista por audio", "msg_audio_list_repair")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.doesNotMatch(sent, /lista .*est[aá] vac[ií]a/i);
    assert.match(sent, /huevos|leche|pan|queso|confirm/i);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("alarm reminder creation uses human customer text and hides infrastructure details", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(Date.parse("2026-06-16T17:48:00.000Z"));
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, Object.assign(env(), {
    ENABLE_REMINDERS: "true",
    REMINDERS_DELIVERY_MODE: "alarm",
    USER_TIMEZONE: "America/Bogota"
  }));

  try {
    await coordinator.fetch(localMessageRequest(textMessage("Recuerdame en 10 minutos comprar huevos", "msg_human_alarm_reminder")));
    clock.tick(100);
    await coordinator.processBuffer();

    const sent = captures.sentTexts.join("\n");
    assert.match(sent, /te lo recordar[eé]|te recordar[eé]|WhatsApp/i);
    assertNoCustomerTechnicalLeak(sent);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("runtime commands /version and /reset keep short-circuit behavior", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471900000);
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

    await coordinator.fetch(localMessageRequest(imageMessage("img_debug_media", "msg_debug_media", "")));
    saved = await state.storage.get("data");
    assert.equal(saved.recentMediaAssets.length, 1);

    const debugResponse = await coordinator.fetch(localMessageRequest(textMessage("/debug-media", "msg_debug_media_cmd")));
    const debugBody = await debugResponse.json();
    const debugText = captures.sentTexts[captures.sentTexts.length - 1] || "";
    assert.equal(debugBody.status, "debug_media_sent");
    assert.match(debugText, /recentMediaAssets count: 1/);
    assert.match(debugText, /img_d...edia|img_debug_media/);
    assert.equal(debugText.includes("https://cdn.test"), false);

    const resetResponse = await coordinator.fetch(localMessageRequest(textMessage("/reset", "msg_reset")));
    const resetBody = await resetResponse.json();
    saved = await state.storage.get("data");

    assert.equal(resetBody.status, "reset_done");
    assert.equal(saved.pendingMessages.length, 0);
    assert.equal(saved.recentMediaAssets.length, 0);
    assert.equal(saved.currentTurnId, "");
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
  }
});

test("runtime commands /debug-logs and /health expose compact trace diagnostics", async () => {
  const state = createMemoryState();
  const captures = { sentTexts: [], visionUrls: [], orchestratorRequests: [] };
  const originalFetch = globalThis.fetch;
  const clock = installFakeClock(1781471950000);
  globalThis.fetch = mockRuntimeFetch(captures);
  const coordinator = new ConversationCoordinator(state, env());

  try {
    await coordinator.fetch(localMessageRequest(textMessage("agrega huevos y pan a mi lista de compras", "msg_diag_text")));
    clock.tick(100);
    await coordinator.processBuffer();

    const saved = await state.storage.get("data");
    assert.equal(Array.isArray(saved.traceEvents), true);
    assert.equal(saved.traceEvents.some((event) => event.event === "USER_TURN_READY"), true);
    assert.equal(saved.traceEvents.some((event) => event.event === "AGENT_EXECUTION_PLAN_CREATED"), true);
    assert.equal(saved.traceEvents.some((event) => event.event === "TURN_PROCESSING_DONE"), true);

    const debugResponse = await coordinator.fetch(localMessageRequest(textMessage("/debug-logs", "msg_debug_logs")));
    const debugBody = await debugResponse.json();
    const debugText = captures.sentTexts[captures.sentTexts.length - 1] || "";
    assert.equal(debugBody.status, "debug_logs_sent");
    assert.match(debugText, /Debug logs de esta conversacion/);
    assert.match(debugText, /TURN_PROCESSING_DONE/);
    assert.equal(debugText.includes("https://cdn.test"), false);

    const healthResponse = await coordinator.fetch(localMessageRequest(textMessage("/health", "msg_health")));
    const healthBody = await healthResponse.json();
    const healthText = captures.sentTexts[captures.sentTexts.length - 1] || "";
    assert.equal(healthBody.status, "health_sent");
    assert.match(healthText, /Estado del asistente/);
    assert.match(healthText, /mensajes pendientes: 0/);
    assert.match(healthText, /errores recientes: 0/);
  } finally {
    globalThis.fetch = originalFetch;
    clock.restore();
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

test("livechat text exits before buffering, LLM calls, and bot replies", async () => {
  const state = createMemoryState();
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url) {
    fetchCalls.push(String(url));
    throw new Error("livechat early exit should not call external fetch");
  };
  const coordinator = new ConversationCoordinator(state, env());
  const message = textMessage("Hola, estoy hablando con un asesor", "msg_livechat_text");
  message.payload.data.liveChat = true;

  try {
    const response = await coordinator.fetch(localMessageRequest(message));
    const body = await response.json();
    const saved = await state.storage.get("data");

    assert.equal(body.status, "livechat_early_exit");
    assert.equal(body.conversationMode, "live_chat");
    assert.equal(saved.conversationMode, "live_chat");
    assert.equal(saved.pendingMessages.length, 0);
    assert.deepEqual(saved.processedMessageIds, ["msg_livechat_text"]);

    await coordinator.processBuffer();
    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("livechat audio webhook skips audio queue after coordinator early exit", async () => {
  const doCalls = [];
  const audioJobs = [];
  const payload = basePayload("AUDIO", {
    messageId: "msg_livechat_audio",
    fileId: "aud_livechat",
    mimeType: "audio/ogg",
    liveChat: true
  });
  payload.eventType = "INBOUND";

  const response = await worker.fetch(new Request("https://worker.test/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }), Object.assign(env(), {
    CONVERSATION_DO: {
      idFromName(name) {
        return name;
      },
      get(id) {
        return {
          async fetch(url, options) {
            doCalls.push({
              id: id,
              url: String(url),
              body: JSON.parse(String(options && options.body || "{}"))
            });
            return json({
              status: "livechat_early_exit",
              conversationMode: "live_chat",
              messageId: "msg_livechat_audio"
            });
          }
        };
      }
    },
    AUDIO_QUEUE: {
      async send(job) {
        audioJobs.push(job);
      }
    }
  }), {
    waitUntil(promise) {
      return promise;
    }
  });
  const body = await response.json();

  assert.equal(body.status, "livechat_early_exit");
  assert.equal(doCalls.length, 1);
  assert.equal(audioJobs.length, 0);
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
