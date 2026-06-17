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

test("core feature flags are active in local safe modes by default", () => {
  const flags = getCoreFeatureFlags({});

  assert.equal(flags.debugLogs, true);
  assert.equal(flags.saveConversationLogs, true);
  assert.equal(flags.enableUserStyleProfile, true);
  assert.equal(flags.enableCustomerMemory, true);
  assert.equal(flags.enableReminders, true);
  assert.equal(flags.enableLists, true);
  assert.equal(flags.enableWhatsAppInteractive, true);
  assert.equal(flags.enableTemplateModule, true);
  assert.equal(flags.coreUtilitiesSandbox, true);
  assert.equal(flags.remindersDeliveryMode, "mock");
  assert.equal(flags.interactiveDeliveryMode, "safe");
  assert.equal(flags.memoryRetentionMode, "summarized");
  assert.equal(flags.logCaptureMode, "console_and_file");
});

test("Google OAuth start builds authorization URL with exact redirect URI", async () => {
  const response = await worker.fetch(new Request("http://localhost:8787/auth/google/start"), {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_REDIRECT_URI: "http://localhost:8787/auth/google/callback"
  }, {});

  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(location.searchParams.get("client_id"), "client-id");
  assert.equal(location.searchParams.get("redirect_uri"), "http://localhost:8787/auth/google/callback");
  assert.equal(location.searchParams.get("scope"), "https://www.googleapis.com/auth/gmail.send");
  assert.equal(location.searchParams.get("access_type"), "offline");
  assert.equal(location.searchParams.get("prompt"), "consent");
  assert.equal(location.searchParams.get("include_granted_scopes"), "true");
});

test("Google OAuth callback rejects missing code", async () => {
  const response = await worker.fetch(new Request("http://localhost:8787/auth/google/callback"), {
    GOOGLE_CLIENT_ID: "client-id",
    GOOGLE_CLIENT_SECRET: "client-secret",
    GOOGLE_REDIRECT_URI: "http://localhost:8787/auth/google/callback"
  }, {});
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, "missing_code");
});

test("Google OAuth callback exchanges code and returns refresh token only in local development", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function (url, options) {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    const form = new URLSearchParams(options.body);
    assert.equal(form.get("client_id"), "client-id");
    assert.equal(form.get("client_secret"), "client-secret");
    assert.equal(form.get("redirect_uri"), "http://localhost:8787/auth/google/callback");
    assert.equal(form.get("grant_type"), "authorization_code");
    return new Response(JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "https://www.googleapis.com/auth/gmail.send"
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await worker.fetch(new Request("http://localhost:8787/auth/google/callback?code=abc"), {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:8787/auth/google/callback"
    }, {});
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.hasRefreshToken, true);
    assert.equal(body.refreshToken, "refresh-token");
    assert.equal(body.redirectUriUsed, "http://localhost:8787/auth/google/callback");
    assert.equal(body.redirectUriMatchesEnv, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Google OAuth callback maps invalid_grant errors safely", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    return new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "Bad Request"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const response = await worker.fetch(new Request("http://localhost:8787/auth/google/callback?code=abc"), {
      GOOGLE_CLIENT_ID: "client-id",
      GOOGLE_CLIENT_SECRET: "client-secret",
      GOOGLE_REDIRECT_URI: "http://localhost:8787/auth/google/callback"
    }, {});
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, "invalid_grant");
    assert.equal(body.details.googleError, "invalid_grant");
    assert.equal(Object.prototype.hasOwnProperty.call(body, "refreshToken"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
    flags: getCoreFeatureFlags({
      SAVE_CONVERSATION_LOGS: "false",
      ENABLE_USER_STYLE_PROFILE: "false",
      ENABLE_CUSTOMER_MEMORY: "false"
    })
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
    ENABLE_REMINDERS: "true",
    ENABLE_WHATSAPP_INTERACTIVE: "true",
    DEBUG_LOGS: "true",
    CORE_UTILITIES_SANDBOX: "true",
    REMINDERS_DELIVERY_MODE: "mock",
    INTERACTIVE_DELIVERY_MODE: "safe",
    MEMORY_RETENTION_MODE: "summarized",
    LOG_CAPTURE_MODE: "console_and_file"
  });
  const text = formatVersionDiagnosticForWhatsApp(diagnostic);

  assert.equal(diagnostic.version, "whatsapp-ai-agent-core-v3");
  assert.equal(diagnostic.build_label, "test-build");
  assert.equal(diagnostic.ORCHESTRATOR_PROVIDER, "openai");
  assert.equal(diagnostic.ORCHESTRATOR_MODEL, "gpt-5.4-mini");
  assert.equal(diagnostic.ENABLE_LISTS, "true");
  assert.equal(diagnostic.ENABLE_REMINDERS, "true");
  assert.equal(diagnostic.ENABLE_WHATSAPP_INTERACTIVE, "true");
  assert.equal(diagnostic.REMINDERS_DELIVERY_MODE, "mock");
  assert.equal(diagnostic.REMINDERS_STATUS, "mock_safe_no_real_delivery");
  assert.equal(diagnostic.REMINDER_TEMPLATE_STATUS, "not_required_for_current_mode");
  assert.equal(diagnostic.INTERACTIVE_DELIVERY_MODE, "safe");
  assert.equal(diagnostic.MEMORY_RETENTION_MODE, "summarized");
  assert.equal(diagnostic.LOG_CAPTURE_MODE, "console_and_file");
  assert.match(diagnostic.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(text, /version: whatsapp-ai-agent-core-v3/);
  assert.match(text, /ORCHESTRATOR_PROVIDER: openai/);
  assert.match(text, /REMINDERS_STATUS: mock_safe_no_real_delivery/);
  assert.match(text, /REMINDER_TEMPLATE_STATUS: not_required_for_current_mode/);
});

test("version diagnostic exposes missing reminder template for outside 24h delivery", () => {
  const diagnostic = buildVersionDiagnostic({
    REMINDERS_DELIVERY_MODE: "alarm",
    REMINDER_TEMPLATE_NAME: ""
  });
  const text = formatVersionDiagnosticForWhatsApp(diagnostic);

  assert.equal(diagnostic.REMINDER_TEMPLATE_CONFIGURED, "false");
  assert.equal(diagnostic.REMINDER_TEMPLATE_STATUS, "outside_24h_blocked_template_missing");
  assert.match(text, /REMINDER_TEMPLATE_STATUS: outside_24h_blocked_template_missing/);
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

test("control commands expose interactive, lists and reminders safely", async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentBodies.push({
      url: String(url),
      body: JSON.parse(options.body)
    });
    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const state = createMemoryState();
  await state.storage.put("data", {
    coreUtilityState: {
      reminders: [{
        id: "rem_1",
        title: "comprar leche",
        dueAt: "2026-06-13T14:00:00.000Z",
        status: "scheduled_mock"
      }],
      listsState: {
        lists: {
          super: {
            name: "super",
            items: [{ id: "item_1", text: "pan", done: false }]
          }
        }
      },
      lists: {
        super: {
          name: "super",
          items: [{ id: "item_1", text: "pan", done: false }]
        }
      },
      activeList: "super",
      tasks: [{
        taskId: "task_1",
        type: "follow_up",
        status: "open",
        title: "hacer seguimiento a Juan",
        description: "seguimiento comercial",
        dueAt: "2026-06-17T10:00:00.000Z",
        mediaRefs: { fileIds: [], assetIds: [] },
        createdAt: "2026-06-16T10:00:00.000Z",
        updatedAt: "2026-06-16T10:00:00.000Z"
      }]
    }
  });

  const coordinator = new ConversationCoordinator(state, {
    WOZTELL_ACCESS_TOKEN: "test-token",
    ENABLE_WHATSAPP_INTERACTIVE: "true",
    INTERACTIVE_DELIVERY_MODE: "safe",
    REMINDERS_DELIVERY_MODE: "mock"
  });

  try {
    const debug = await coordinator.receiveMessage(buildTextWebhookBody("/debug-interactive"));
    const lists = await coordinator.receiveMessage(buildTextWebhookBody("/lists"));
    const reminders = await coordinator.receiveMessage(buildTextWebhookBody("/reminders"));
    const tasks = await coordinator.receiveMessage(buildTextWebhookBody("/tasks"));
    const memory = await coordinator.receiveMessage(buildTextWebhookBody("/memory"));
    const memoryOn = await coordinator.receiveMessage(buildTextWebhookBody("/memory-on"));
    const memoryOff = await coordinator.receiveMessage(buildTextWebhookBody("/memory-off"));
    const clearReminders = await coordinator.receiveMessage(buildTextWebhookBody("/clear-reminders"));
    const saved = await state.storage.get("data");

    assert.equal((await debug.json()).status, "debug_interactive_sent");
    assert.equal((await lists.json()).status, "lists_sent");
    assert.equal((await reminders.json()).status, "reminders_sent");
    assert.equal((await tasks.json()).status, "tasks_sent");
    assert.equal((await memory.json()).status, "memory_sent");
    assert.equal((await memoryOn.json()).status, "long_term_memory_consent_granted");
    assert.equal((await memoryOff.json()).status, "long_term_memory_consent_revoked");
    assert.equal((await clearReminders.json()).status, "reminders_cleared");
    assert.equal(saved.coreUtilityState.reminders.length, 0);
    assert.equal(saved.memoryConsent.longTerm.status, "revoked");
    assert.equal(sentBodies.some((item) => item.body.response && item.body.response[0].type === "QUICK_REPLY"), true);
    assert.equal(sentBodies.some((item) => JSON.stringify(item.body).includes("Listas guardadas")), true);
    assert.equal(sentBodies.some((item) => JSON.stringify(item.body).includes("Recordatorios pendientes")), true);
    assert.equal(sentBodies.some((item) => JSON.stringify(item.body).includes("Tareas abiertas")), true);
    assert.equal(sentBodies.some((item) => JSON.stringify(item.body).includes("Memoria guardada")), true);
    assert.equal(sentBodies.some((item) => JSON.stringify(item.body).includes("memoria larga opcional")), true);
    const reminderBody = sentBodies.find((item) => JSON.stringify(item.body).includes("Recordatorios pendientes"));
    const reminderText = JSON.stringify(reminderBody && reminderBody.body || {});
    assert.match(reminderText, /comprar leche/);
    assert.doesNotMatch(reminderText, /scheduled_|modo:|scheduler|Durable Object/i);
    assert.doesNotMatch(reminderText, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("core list response sends primary text before optional interactive buttons", async () => {
  const sentBodies = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: 1 }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  };

  const coordinator = new ConversationCoordinator(createMemoryState(), {
    WOZTELL_ACCESS_TOKEN: "test-token",
    ENABLE_LISTS: "true",
    ENABLE_WHATSAPP_INTERACTIVE: "true",
    INTERACTIVE_DELIVERY_MODE: "safe"
  });

  try {
    await coordinator.receiveMessage(buildTextWebhookBody("[Audio transcrito]: Me puedes ayudar a generar una lista de huevos, pan, leche y carne."));
    await coordinator.processBuffer();

    assert.equal(sentBodies.length >= 2, true);
    assert.equal(sentBodies[0].response[0].type, "TEXT");
    assert.match(sentBodies[0].response[0].text, /Listo, actualicé tu lista de compras con: huevos, pan, leche, carne\./);
    assert.equal(sentBodies[1].response[0].type, "QUICK_REPLY");
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
