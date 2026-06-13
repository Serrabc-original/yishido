import test from "node:test";
import assert from "node:assert/strict";
import { buildLogRecord, createTraceId, redactForLog } from "../src/logger.js";
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
