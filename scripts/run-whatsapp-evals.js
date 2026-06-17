import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeCoreUtilityIntent } from "../src/coreUtilityRouter.js";
import { buildAgentExecutionPlan } from "../src/agent/agentOrchestrationPipeline.js";
import {
  extractWoztellMessage,
  normalizeIncomingMessage,
  normalizeWoztellInboundEvent,
  shouldIgnoreWoztellInboundEvent
} from "../src/channels/woztell/eventNormalizer.js";
import { buildUserTurn } from "../src/index.js";
import { buildSeenMessageIds, isDuplicateMessage } from "../src/core/idempotencyStore.js";

const evalDir = join(process.cwd(), "test", "evals", "whatsapp");
const files = readdirSync(evalDir).filter(function (file) {
  return file.endsWith(".jsonl");
});
let passed = 0;
let failed = 0;

for (const file of files) {
  const lines = readFileSync(join(evalDir, file), "utf8")
    .split(/\r?\n/)
    .map(function (line) { return line.trim(); })
    .filter(Boolean);

  for (const line of lines) {
    const item = JSON.parse(line);
    const result = runWhatsappEvalCase(item);
    if (result.ok) {
      passed += 1;
    } else {
      failed += 1;
      console.error("WHATSAPP_EVAL_FAILED", JSON.stringify({
        id: item.id,
        reason: result.reason,
        expected: item.expected,
        actual: result.actual
      }));
    }
  }
}

console.log("WHATSAPP_EVALS_DONE", JSON.stringify({
  files: files.length,
  passed: passed,
  failed: failed
}));

if (failed) process.exit(1);

function runWhatsappEvalCase(item) {
  const data = { processedMessageIds: [], pendingMessages: [] };
  const messages = [];
  const ignored = [];
  const duplicates = [];
  const campaignState = { campaign_assets: [] };

  for (const event of item.events || []) {
    const payload = event.payload || event;
    const inbound = normalizeWoztellInboundEvent(payload, { traceId: "trace_" + item.id });
    const ignore = shouldIgnoreWoztellInboundEvent(inbound, buildSeenMessageIds(data), { traceId: "trace_" + item.id });
    if (ignore.ignore) {
      ignored.push({ messageId: inbound.messageId, reason: ignore.reason });
      if (isDedupeIgnore(ignore)) duplicates.push(inbound.messageId);
      continue;
    }

    const parsed = extractWoztellMessage(payload);
    const messageId = parsed.messageId || inbound.messageId || payload.messageId || "";
    if (isDuplicateMessage(data, messageId)) {
      duplicates.push(messageId);
      continue;
    }

    const normalized = normalizeIncomingMessage(parsed, payload, {
      messageId: messageId,
      traceId: "trace_" + item.id,
      receivedAt: event.receivedAt || "2026-06-16T12:00:00.000Z"
    });

    if (event.transcript) {
      normalized.text = event.transcript;
      normalized.audioTranscript = event.transcript;
      normalized.audioStatus = "transcribed";
      normalized.awaitingTranscription = false;
      normalized.audio = normalized.audio.map(function (audio) {
        return Object.assign({}, audio, {
          status: "transcribed",
          transcript: event.transcript
        });
      });
    }

    data.pendingMessages.push(normalized);
    messages.push(normalized);
    for (const media of normalized.media || []) {
      campaignState.campaign_assets.push({
        asset_id: "asset_" + media.fileId,
        file_id: media.fileId,
        media_type: media.type || "IMAGE",
        status: event.mediaStatus || "received",
        turn_id: item.id
      });
    }
  }

  const userTurn = buildUserTurn(messages, campaignState, {
    turnId: item.id,
    traceId: "trace_" + item.id
  });
  const route = routeCoreUtilityIntent(userTurn, {
    flags: { enableLists: true, enableReminders: true },
    now: item.now || "2026-06-16T12:00:00.000Z",
    timezone: item.timezone || "America/Bogota"
  });
  const executionPlan = buildAgentExecutionPlan({
    data: { coreUtilityState: item.initialCoreUtilityState || {} },
    userTurn: userTurn,
    utilityRoute: route,
    now: item.now || "2026-06-16T12:00:00.000Z"
  });
  const actual = {
    normalizedCount: messages.length,
    ignoredCount: ignored.length,
    duplicateCount: duplicates.length,
    messageIds: messages.map(function (message) { return message.messageId; }),
    textCount: userTurn.counts && userTurn.counts.text || userTurn.text_count || 0,
    audioCount: userTurn.counts && userTurn.counts.audio || userTurn.audio_count || 0,
    imageCount: userTurn.counts && userTurn.counts.image || userTurn.image_count || 0,
    videoCount: userTurn.counts && userTurn.counts.video || userTurn.video_count || 0,
    fileCount: userTurn.counts && userTurn.counts.file || userTurn.file_count || 0,
    mediaFileIds: userTurn.media_batch && userTurn.media_batch.fileIds || [],
    captions: userTurn.captions || [],
    routeIntent: route.intent,
    listAction: route.parsed && route.parsed.list
      ? route.parsed.list.action || ""
      : route.parsed && route.intent === "list"
        ? route.parsed.action || ""
        : "",
    listItems: route.parsed && route.parsed.list
      ? route.parsed.list.items || []
      : route.parsed && route.intent === "list"
        ? route.parsed.items || []
        : [],
    listMissingFields: route.parsed && route.parsed.list
      ? route.parsed.list.missingFields || []
      : route.parsed && route.intent === "list"
        ? route.parsed.missingFields || []
        : [],
    reminderTitle: route.parsed && route.parsed.reminder
      ? route.parsed.reminder.title || ""
      : route.parsed && route.intent === "reminder"
        ? route.parsed.title || ""
        : "",
    executionMode: executionPlan.executionMode,
    plannedToolAction: executionPlan.toolPlan && executionPlan.toolPlan.actions && executionPlan.toolPlan.actions[0]
      ? executionPlan.toolPlan.actions[0].action
      : "",
    toolPermissionStatus: executionPlan.toolPermission && executionPlan.toolPermission.status || "",
    shouldHandleInCore: Boolean(route.shouldHandleInCore)
  };
  const expected = item.expected || {};

  for (const key of Object.keys(expected)) {
    if (Array.isArray(expected[key])) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) return fail("field mismatch: " + key, actual);
      continue;
    }
    if (actual[key] !== expected[key]) return fail("field mismatch: " + key, actual);
  }

  return { ok: true, actual: actual };
}

function fail(reason, actual) {
  return {
    ok: false,
    reason: reason,
    actual: actual
  };
}

function isDedupeIgnore(ignore) {
  const reason = String(ignore && ignore.reason || "").toLowerCase();
  return reason.includes("duplicate") || reason.includes("dedupe");
}
