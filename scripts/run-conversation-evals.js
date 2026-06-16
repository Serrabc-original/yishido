import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { routeCoreUtilityIntent } from "../src/coreUtilityRouter.js";
import { runAgentRuntime } from "../src/agent/agentRuntime.js";

const evalDir = join(process.cwd(), "test", "evals", "conversations");
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
    const result = runEvalCase(item);
    if (result.ok) {
      passed += 1;
    } else {
      failed += 1;
      console.error("EVAL_FAILED", JSON.stringify({
        id: item.id,
        reason: result.reason,
        expected: item.expected,
        actual: result.actual
      }));
    }
  }
}

console.log("CONVERSATION_EVALS_DONE", JSON.stringify({
  files: files.length,
  passed: passed,
  failed: failed
}));

if (failed) process.exit(1);

function runEvalCase(item) {
  const userTurn = buildUserTurn(item);
  const route = routeCoreUtilityIntent(userTurn, {
    flags: { enableLists: true, enableReminders: true },
    now: item.now || "2026-06-16T12:00:00.000Z",
    timezone: "America/Bogota"
  });
  const runtimeResult = runAgentRuntime({
    data: { coreUtilityState: item.initialCoreUtilityState || {} },
    userTurn: userTurn,
    utilityRoute: route,
    now: item.now || "2026-06-16T12:00:00.000Z"
  });
  const actual = {
    routeIntent: route.intent,
    handled: runtimeResult.handled,
    action: runtimeResult.action && runtimeResult.action.action || "",
    taskCount: runtimeResult.data.coreUtilityState && runtimeResult.data.coreUtilityState.tasks && runtimeResult.data.coreUtilityState.tasks.length || 0,
    leadCount: runtimeResult.data.coreUtilityState && runtimeResult.data.coreUtilityState.leads && runtimeResult.data.coreUtilityState.leads.length || 0,
    responseText: runtimeResult.responseText || "",
    mediaFileIds: runtimeResult.data.coreUtilityState && runtimeResult.data.coreUtilityState.tasks && runtimeResult.data.coreUtilityState.tasks[0]
      ? runtimeResult.data.coreUtilityState.tasks[0].mediaRefs.fileIds
      : []
  };
  const expected = item.expected || {};

  for (const key of Object.keys(expected)) {
    if (key === "responseIncludes") {
      if (!String(actual.responseText).includes(expected[key])) return fail("response missing " + expected[key], actual);
      continue;
    }
    if (key === "mediaFileIds") {
      if (JSON.stringify(actual.mediaFileIds) !== JSON.stringify(expected[key])) return fail("media refs mismatch", actual);
      continue;
    }
    if (actual[key] !== expected[key]) return fail("field mismatch: " + key, actual);
  }

  return { ok: true, actual: actual };
}

function buildUserTurn(item) {
  const media = item.media || [];
  return {
    turn_id: item.id || "eval_turn",
    trace_id: "trace_" + (item.id || "eval"),
    current_turn_text: item.text || "",
    image_count: media.filter(function (asset) { return asset.mediaType === "IMAGE" || asset.media_type === "IMAGE"; }).length,
    audio_count: item.audioTranscripts ? item.audioTranscripts.length : 0,
    audio_transcripts: item.audioTranscripts || [],
    media_batch: {
      fileIds: media.map(function (asset) { return asset.fileId || asset.file_id; }).filter(Boolean),
      assets: media.map(function (asset, index) {
        return {
          asset_id: asset.assetId || asset.asset_id || "asset_" + (index + 1),
          file_id: asset.fileId || asset.file_id || "",
          media_type: asset.mediaType || asset.media_type || "IMAGE",
          status: asset.status || "received",
          analysis_error: asset.analysisError || asset.analysis_error || ""
        };
      })
    }
  };
}

function fail(reason, actual) {
  return {
    ok: false,
    reason: reason,
    actual: actual
  };
}
