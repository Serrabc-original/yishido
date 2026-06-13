import test from "node:test";
import assert from "node:assert/strict";
import { buildLogRecord, createTraceId, redactForLog } from "../src/logger.js";
import worker, { ConversationCoordinator, buildVersionDiagnostic, formatVersionDiagnosticForWhatsApp } from "../src/index.js";
import {
  buildConversationLogEntry,
  buildConversationSummary,
  buildUserStyleProfile,
  getCoreFeatureFlags,
  updateConversationMemory
} from "../src/conversationMemory.js";

test("logger redacts secrets and phone-like fields", () => {
  const record = buildLogRecord("WEBHOOK_RECEIVED", {
    traceId: "trace_test",
    Authorization: "Bearer secret-token",
    OPENAI_API_KEY: "sk-test",
    phone: "+57 300 123 4567",
    nested: {
      GOOGLE_SHEETS_SECRET: "secret"
    }
  });

  assert.equal(record.event, "WEBHOOK_RECEIVED");
  assert.equal(record.details.Authorization, "[REDACTED]");
  assert.equal(record.details.OPENAI_API_KEY, "[REDACTED]");
  assert.match(record.details.phone, /^\[PHONE:/);
  assert.equal(record.details.nested.GOOGLE_SHEETS_SECRET, "[REDACTED]");
});

test("core feature flags are safe by default", () => {
  const flags = getCoreFeatureFlags({});

  assert.equal(flags.debugLogs, false);
  assert.equal(flags.saveConversationLogs, false);
  assert.equal(flags.enableUserStyleProfile, false);
  assert.equal(flags.enableCustomerMemory, false);
  assert.equal(flags.enableReminders, false);
  assert.equal(flags.enableTemplateModule, false);
});

test("conversation memory stores compact sanitized turn data only when enabled", () => {
  const userTurn = {
    turn_id: "turn_1",
    trace_id: createTraceId(["test", "turn_1"]),
    input_types: ["TEXT", "IMAGE"],
    text_count: 1,
    image_count: 2,
    current_turn_text: "Mi email es cliente@example.com y quiero posts para cafe premium",
    media_batch: {
      fileIds: ["file_1", "file_2"],
      assetCount: 2,
      failedAssetCount: 0
    },
    context_policy: "current_turn_only",
    created_at: "2026-06-12T00:00:00.000Z"
  };

  const disabled = updateConversationMemory({}, userTurn, {
    flags: getCoreFeatureFlags({})
  });
  assert.equal(disabled.conversationLog.length, 0);
  assert.equal(disabled.conversationSummary.turn_count, 1);

  const enabled = updateConversationMemory({}, userTurn, {
    flags: {
      saveConversationLogs: true,
      enableUserStyleProfile: true,
      enableCustomerMemory: true
    }
  });

  assert.equal(enabled.conversationLog.length, 1);
  assert.match(enabled.conversationLog[0].textPreview, /\[EMAIL_REDACTED\]/);
  assert.equal(enabled.userStyleProfile.language, "es");
  assert.equal(Array.isArray(enabled.customerMemory.known_business_terms), true);
});

test("style profile captures reusable conversation preferences", () => {
  const entry = buildConversationLogEntry({
    turn_id: "turn_style",
    input_types: ["TEXT"],
    text_count: 1,
    current_turn_text: "Por favor hazme una respuesta corta para soporte. Gracias",
    context_policy: "current_turn_only"
  });
  const summary = buildConversationSummary([entry]);
  const profile = buildUserStyleProfile([entry]);

  assert.equal(summary.turn_count, 1);
  assert.equal(profile.language, "es");
  assert.equal(profile.tone, "friendly");
  assert.equal(profile.prefers_short_answers, true);
});

test("redactForLog does not mutate media arrays", () => {
  const value = redactForLog({
    media: [
      { fileId: "file_1", url: "https://example.test/1.jpg" },
      { fileId: "file_2", url: "https://example.test/2.jpg" }
    ]
  });

  assert.equal(Array.isArray(value.media), true);
  assert.equal(value.media.length, 2);
});

test("version diagnostic exposes safe runtime configuration", () => {
  const diagnostic = buildVersionDiagnostic({
    BUILD_LABEL: "test-build",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "false",
    ENABLE_WHATSAPP_INTERACTIVE: "false",
    DEBUG_LOGS: "true"
  });
  const text = formatVersionDiagnosticForWhatsApp(diagnostic);

  assert.equal(diagnostic.version, "whatsapp-ai-agent-core-v3");
  assert.equal(diagnostic.build_label, "test-build");
  assert.equal(diagnostic.ORCHESTRATOR_PROVIDER, "openai");
  assert.equal(diagnostic.ORCHESTRATOR_MODEL, "gpt-5.4-mini");
  assert.equal(diagnostic.ENABLE_LISTS, "true");
  assert.match(diagnostic.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(text, /version: whatsapp-ai-agent-core-v3/);
  assert.match(text, /ORCHESTRATOR_PROVIDER: openai/);
});

test("GET /version returns version diagnostic JSON", async () => {
  const response = await worker.fetch(new Request("https://example.test/version"), {
    BUILD_LABEL: "test-build",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    ENABLE_LISTS: "false",
    ENABLE_REMINDERS: "false",
    ENABLE_WHATSAPP_INTERACTIVE: "false",
    DEBUG_LOGS: "false"
  }, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.version, "whatsapp-ai-agent-core-v3");
  assert.equal(body.build_label, "test-build");
  assert.equal(body.ORCHESTRATOR_MODEL, "gpt-5.4-mini");
});

test("GET / returns the same current diagnostic metadata as /version", async () => {
  const env = {
    BUILD_LABEL: "root-test-build",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    ENABLE_LISTS: "true",
    ENABLE_REMINDERS: "false",
    ENABLE_WHATSAPP_INTERACTIVE: "false",
    DEBUG_LOGS: "false"
  };
  const rootResponse = await worker.fetch(new Request("https://example.test/"), env, {});
  const versionResponse = await worker.fetch(new Request("https://example.test/version"), env, {});
  const rootBody = await rootResponse.json();
  const versionBody = await versionResponse.json();

  assert.equal(rootResponse.status, 200);
  assert.equal(rootBody.version, "whatsapp-ai-agent-core-v3");
  assert.equal(rootBody.build_label, "root-test-build");
  assert.equal(rootBody.ORCHESTRATOR_PROVIDER, "openai");
  assert.equal(rootBody.ORCHESTRATOR_MODEL, "gpt-5.4-mini");
  assert.equal(rootBody.ENABLE_LISTS, "true");
  assert.equal(Object.hasOwn(rootBody, "architecture"), false);
  assert.equal(Object.hasOwn(rootBody, "service"), false);
  assert.equal(versionBody.version, rootBody.version);
  assert.equal(versionBody.ORCHESTRATOR_PROVIDER, rootBody.ORCHESTRATOR_PROVIDER);
  assert.equal(versionBody.ORCHESTRATOR_MODEL, rootBody.ORCHESTRATOR_MODEL);
});

test("WhatsApp /version uses memberId and does not throw when Woztell returns 500", async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentBodies.push({
      url: String(url),
      body: JSON.parse(options.body)
    });
    return new Response(JSON.stringify({
      ok: 0,
      err: "App could not be found."
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator({
    storage: {
      async get() {
        return undefined;
      },
      async put() {},
      async setAlarm() {}
    }
  }, {
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini"
  });

  try {
    const response = await coordinator.receiveMessage({
      type: "woztell_message",
      doName: "69bd60f353c5bb3f71e01432:593995660220",
      payload: {
        app: "69af3fae2631702e0cb53d3c",
        channel: "69bd60f353c5bb3f71e01432",
        member: "6a0264aae55bbde3a7d5a0a5",
        from: "593995660220",
        type: "TEXT",
        data: {
          text: "/version"
        }
      }
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "version_sent");
    assert.equal(sentBodies.length, 1);
    assert.match(sentBodies[0].url, /sendResponses\?accessToken=/);
    assert.equal(sentBodies[0].body.channelId, "69bd60f353c5bb3f71e01432");
    assert.equal(sentBodies[0].body.memberId, "6a0264aae55bbde3a7d5a0a5");
    assert.equal(sentBodies[0].body.appId, "69af3fae2631702e0cb53d3c");
    assert.equal(Object.hasOwn(sentBodies[0].body, "recipientId"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("normal WhatsApp text does not send generic fallback when OpenAI returns a valid plan", async () => {
  const sentTexts = [];
  const openAiBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const cleanUrl = String(url);

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      openAiBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          intent: "general",
          confidence: 0.9,
          should_handle_in_core: false,
          target_module: "core",
          needs_clarification: false,
          clarification_question: "",
          actions: [],
          user_facing_ack: "Hola, estoy listo para ayudarte.",
          state_updates: {}
        })
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    const body = JSON.parse(options.body);
    sentTexts.push(body.response && body.response[0] && body.response[0].text || "");
    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini"
  });

  try {
    await coordinator.receiveMessage(buildTextWebhookBody("Hola"));
    await coordinator.processBuffer();

    assert.deepEqual(sentTexts, ["Hola, estoy listo para ayudarte."]);
    assert.equal(sentTexts.includes("Tuve un problema procesando tu solicitud. Intenta nuevamente en unos minutos."), false);
    assert.equal(openAiBodies.length, 1);
    assert.equal(openAiBodies[0].reasoning.effort, "low");
    assert.notEqual(openAiBodies[0].reasoning.effort, "minimal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("invalid OPENAI_REASONING_EFFORT is normalized to low", async () => {
  const openAiBodies = [];
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;

  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };

  globalThis.fetch = async (url, options) => {
    const cleanUrl = String(url);

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      openAiBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          intent: "general",
          confidence: 0.9,
          should_handle_in_core: false,
          target_module: "core",
          needs_clarification: false,
          clarification_question: "",
          actions: [],
          user_facing_ack: "Hola.",
          state_updates: {}
        })
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    OPENAI_REASONING_EFFORT: "minimal"
  });

  try {
    await coordinator.receiveMessage(buildTextWebhookBody("Hola"));
    await coordinator.processBuffer();

    assert.equal(openAiBodies.length, 1);
    assert.equal(openAiBodies[0].reasoning.effort, "low");
    assert.equal(logLines.some((line) => line.includes("OPENAI_REASONING_EFFORT_NORMALIZED")), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
});

test("normal WhatsApp text logs clear OpenAI failure cause before generic fallback", async () => {
  const sentTexts = [];
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;

  console.error = (...args) => {
    logLines.push(args.map(String).join(" "));
  };
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };

  globalThis.fetch = async (url, options) => {
    const cleanUrl = String(url);

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      return new Response(JSON.stringify({
        error: {
          message: "model unavailable"
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    const body = JSON.parse(options.body);
    sentTexts.push(body.response && body.response[0] && body.response[0].text || "");
    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini"
  });

  try {
    await coordinator.receiveMessage(buildTextWebhookBody("Hola"));
    await coordinator.processBuffer();

    assert.equal(sentTexts.includes("Tuve un problema procesando tu solicitud. Intenta nuevamente en unos minutos."), true);
    assert.equal(logLines.some((line) => line.includes("OPENAI_REQUEST_FAILED")), true);
    assert.equal(logLines.some((line) => line.includes("FALLBACK_REASON")), true);
    assert.equal(logLines.some((line) => line.includes("gpt-5.4-mini")), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("OpenAI failure skips Claude fallback when ANTHROPIC_API_KEY is missing", async () => {
  const urls = [];
  const logLines = [];
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  const originalLog = console.log;

  console.error = (...args) => {
    logLines.push(args.map(String).join(" "));
  };
  console.log = (...args) => {
    logLines.push(args.map(String).join(" "));
  };

  globalThis.fetch = async (url, options) => {
    const cleanUrl = String(url);
    urls.push(cleanUrl);

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      return new Response(JSON.stringify({
        error: {
          message: "Unsupported value: 'minimal' is not supported."
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    ORCHESTRATOR_FALLBACK_PROVIDER: "claude"
  });

  try {
    await coordinator.receiveMessage(buildTextWebhookBody("Hola"));
    await coordinator.processBuffer();

    assert.equal(urls.some((url) => url.includes("anthropic") || url.includes("claude")), false);
    assert.equal(logLines.some((line) => line.includes("ORCHESTRATOR_FALLBACK_SKIPPED_MISSING_KEY")), true);
    assert.equal(logLines.some((line) => line.includes("FALLBACK_REASON")), true);
  } finally {
    globalThis.fetch = originalFetch;
    console.error = originalError;
    console.log = originalLog;
  }
});

test("/debug-openai uses valid reasoning effort and never falls back to Claude", async () => {
  const urls = [];
  const openAiBodies = [];
  const sentTexts = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url, options) => {
    const cleanUrl = String(url);
    urls.push(cleanUrl);

    if (cleanUrl.includes("api.openai.com/v1/responses")) {
      openAiBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        error: {
          message: "diagnostic model failure"
        }
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }

    const body = JSON.parse(options.body);
    sentTexts.push(body.response && body.response[0] && body.response[0].text || "");
    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    OPENAI_API_KEY: "sk-test",
    WOZTELL_ACCESS_TOKEN: "test-token",
    ORCHESTRATOR_PROVIDER: "openai",
    ORCHESTRATOR_MODEL: "gpt-5.4-mini",
    ORCHESTRATOR_FALLBACK_PROVIDER: "claude",
    OPENAI_REASONING_EFFORT: "minimal"
  });

  try {
    const response = await coordinator.receiveMessage(buildTextWebhookBody("/debug-openai"));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.status, "debug_openai_sent");
    assert.equal(body.ok, false);
    assert.equal(openAiBodies.length, 1);
    assert.equal(openAiBodies[0].reasoning.effort, "low");
    assert.equal(urls.some((url) => url.includes("anthropic") || url.includes("claude")), false);
    assert.equal(sentTexts.some((text) => text.includes("OpenAI debug") && text.includes("status: fail")), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

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
      async setAlarm() {}
    }
  };
}

function buildTextWebhookBody(text) {
  return {
    type: "woztell_message",
    doName: "69bd60f353c5bb3f71e01432:593995660220",
    payload: {
      app: "69af3fae2631702e0cb53d3c",
      channel: "69bd60f353c5bb3f71e01432",
      member: "6a0264aae55bbde3a7d5a0a5",
      from: "593995660220",
      type: "TEXT",
      data: {
        text: text
      }
    }
  };
}
