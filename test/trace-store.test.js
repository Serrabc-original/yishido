import test from "node:test";
import assert from "node:assert/strict";
import {
  appendTraceEvent,
  buildProductHealthSnapshot,
  buildTraceSnapshot,
  formatProductHealthForWhatsApp,
  formatTraceSnapshotForWhatsApp,
  normalizeTraceEvents
} from "../src/observability/traceStore.js";

test("trace store caps events and redacts raw payloads, secrets and media URLs", () => {
  let data = {};

  data = appendTraceEvent(data, "EVENT_ONE", { traceId: "trace_a" }, { maxEvents: 3 });
  data = appendTraceEvent(data, "EVENT_TWO", { traceId: "trace_a" }, { maxEvents: 3 });
  data = appendTraceEvent(data, "EVENT_THREE", { traceId: "trace_a" }, { maxEvents: 3 });
  data = appendTraceEvent(data, "OPENAI_REQUEST_FAILED", {
    traceId: "trace_a",
    Authorization: "Bearer secret-token",
    OPENAI_API_KEY: "sk-test",
    phone: "+593 99 555 6611",
    imageUrl: "https://cdn.test/private/image.jpg?access_token=secret-token",
    rawPayload: { user: "raw body should not stay" },
    errorMessage: "model failed"
  }, {
    level: "error",
    traceId: "trace_a",
    maxEvents: 3
  });

  assert.equal(data.traceEvents.length, 3);
  assert.equal(data.traceEvents[0].event, "EVENT_TWO");
  assert.equal(data.traceEvents[2].level, "error");

  const serialized = JSON.stringify(data.traceEvents);
  assert.equal(serialized.includes("secret-token"), false);
  assert.equal(serialized.includes("raw body should not stay"), false);
  assert.equal(serialized.includes("access_token"), false);
  assert.match(serialized, /\[URL:cdn\.test/);
  assert.match(serialized, /\[PHONE:/);
});

test("trace snapshot and WhatsApp formatting summarize recent health", () => {
  const data = {
    currentTraceId: "trace_a",
    currentTurnId: "turn_a"
  };
  const withEvents = appendTraceEvent(appendTraceEvent(data, "TURN_BUFFER_READY", {
    traceId: "trace_a",
    turnId: "turn_a",
    messageCount: 2,
    contextPolicy: "current_turn_only"
  }), "TURN_PROCESSING_FAILED", {
    traceId: "trace_a",
    turnId: "turn_a",
    reason: "ORCHESTRATOR_PLAN_NOT_JSON"
  }, {
    level: "error",
    traceId: "trace_a",
    turnId: "turn_a"
  });

  const snapshot = buildTraceSnapshot(withEvents, { limit: 10, traceId: "trace_a" });
  const text = formatTraceSnapshotForWhatsApp(snapshot);

  assert.equal(snapshot.health.status, "needs_review");
  assert.equal(snapshot.health.errors, 1);
  assert.equal(snapshot.returned, 2);
  assert.match(text, /Debug logs de esta conversacion/);
  assert.match(text, /TURN_PROCESSING_FAILED/);
  assert.match(text, /errores: 1/);
});

test("product health snapshot exposes compact state without raw trace detail", () => {
  const data = appendTraceEvent({
    processing: false,
    pendingMessages: [{ messageId: "msg_1" }],
    hasMedia: true,
    currentTraceId: "trace_product",
    currentTurnId: "turn_product",
    recentMediaAssets: [{ fileId: "img_1", url: "https://cdn.test/img.jpg?token=secret" }],
    conversationLog: [{ turnId: "turn_1" }],
    memoryPolicy: { longTerm: { enabled: true, mode: "kv" } },
    coreUtilityState: {
      lists: { compras: { name: "compras" } },
      reminders: [{ id: "rem_1" }],
      tasks: [{ id: "task_1" }]
    },
    campaignState: {
      campaign_assets: [{ file_id: "img_1" }]
    }
  }, "TURN_PROCESSING_DONE", {
    traceId: "trace_product",
    turnId: "turn_product"
  });

  const health = buildProductHealthSnapshot(data, { BUILD_LABEL: "test-build" });
  const text = formatProductHealthForWhatsApp(health);
  const normalized = normalizeTraceEvents(data.traceEvents);

  assert.equal(health.status, "ok");
  assert.equal(health.pendingMessages, 1);
  assert.equal(health.recentMediaAssets, 1);
  assert.equal(health.campaignAssets, 1);
  assert.equal(normalized.length, 1);
  assert.match(text, /Estado del asistente/);
  assert.match(text, /memoria larga: kv/);
  assert.equal(text.includes("https://cdn.test"), false);
});
