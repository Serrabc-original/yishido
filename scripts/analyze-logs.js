import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const logsDir = join(process.cwd(), "logs");
const maxLines = Number(process.argv[2] || 5000);

const result = {
  status: "ok",
  logsDir: logsDir,
  filesRead: [],
  totals: {
    lines: 0,
    parsed: 0,
    errors: 0,
    fallbacksSent: 0,
    audioTimeouts: 0,
    failedImages: 0,
    invalidOrchestratorJson: 0,
    openAiFailures: 0,
    woztellSendFailures: 0,
    staleMediaTurns: 0,
    contextSwitches: 0,
    reminderIssues: 0,
    interactiveFailures: 0
  },
  repeatedErrors: [],
  fallbacksSent: [],
  audiosWithTimeout: [],
  failedImages: [],
  turnsWithoutResponse: [],
  turnsWithPendingAudio: [],
  turnsWithPendingMedia: [],
  invalidOrchestratorJson: [],
  openAiFailures: [],
  woztellSendFailures: [],
  staleMediaTurns: [],
  contextSwitches: [],
  reminderIssues: [],
  interactiveFailures: [],
  errorsByTraceId: {},
  latestProblemConversations: []
};

if (!existsSync(logsDir)) {
  result.status = "no_logs_dir";
  result.message = "No logs directory found. logs:analyze is ready; add JSON lines under logs/agent-YYYY-MM-DD.log or logs/errors-YYYY-MM-DD.log.";
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

const files = readdirSync(logsDir)
  .filter(function (file) { return file.endsWith(".log"); })
  .sort()
  .slice(-8);

const records = [];

for (const file of files) {
  const fullPath = join(logsDir, file);
  const lines = readFileSync(fullPath, "utf8").split(/\r?\n/).filter(Boolean).slice(-maxLines);
  result.filesRead.push(file);

  for (const line of lines) {
    result.totals.lines += 1;
    const record = parseLogLine(line, file);
    if (record) {
      result.totals.parsed += 1;
      records.push(record);
    }
  }
}

const turns = new Map();
const errorCounts = new Map();
const problems = [];

for (const record of records) {
  const details = record.details || {};
  const event = record.event || details.event || "";
  const traceId = record.traceId || details.traceId || "";
  const turnId = record.turnId || details.turnId || details.turn_id || traceId || "unknown";
  const doName = record.doName || details.doName || "";

  if (!turns.has(turnId)) {
    turns.set(turnId, {
      turnId: turnId,
      traceId: traceId,
      doName: doName,
      firstTs: record.ts || "",
      lastTs: record.ts || "",
      received: false,
      bufferReady: false,
      responseSent: false,
      pendingAudio: false,
      pendingMedia: false,
      events: []
    });
  }

  const turn = turns.get(turnId);
  turn.traceId = turn.traceId || traceId;
  turn.doName = turn.doName || doName;
  turn.lastTs = record.ts || turn.lastTs;
  turn.events.push(event);

  if (event === "TURN_CREATED" || event === "WEBHOOK_RECEIVED") turn.received = true;
  if (event === "TURN_BUFFER_READY") turn.bufferReady = true;
  if (event === "USER_RESPONSE_SENT" || event === "TURN_PROCESSING_DONE") turn.responseSent = true;

  if (event === "TURN_BUFFER_STARTED" && details.reason === "waiting_audio_transcription") {
    turn.pendingAudio = true;
  }

  if (event === "MEDIA_BATCH_CREATED" && Number(details.assetCount || details.asset_count || 0) > Number(details.analyzedAssetCount || details.analyzed_asset_count || 0)) {
    turn.pendingMedia = true;
  }

  if (record.level === "error" || event.includes("ERROR") || event === "ERROR_CAPTURED") {
    result.totals.errors += 1;
    const message = details.errorMessage || details.message || details.body || event;
    const key = [event, String(message).slice(0, 160)].join(" | ");
    errorCounts.set(key, (errorCounts.get(key) || 0) + 1);
    if (traceId) {
      result.errorsByTraceId[traceId] = result.errorsByTraceId[traceId] || [];
      result.errorsByTraceId[traceId].push({
        ts: record.ts || "",
        event: event,
        message: String(message).slice(0, 500)
      });
    }
    problems.push(problem(record, "error", String(message).slice(0, 500)));
  }

  if (event === "USER_FALLBACK_SENT") {
    result.totals.fallbacksSent += 1;
    result.fallbacksSent.push(problem(record, "fallback", details.reason || "fallback_sent"));
    problems.push(problem(record, "fallback", details.reason || "fallback_sent"));
  }

  if (event === "AUDIO_TIMEOUT" || event.includes("AUDIO") && String(details.message || details.errorMessage || "").includes("TIMEOUT")) {
    result.totals.audioTimeouts += 1;
    result.audiosWithTimeout.push(problem(record, "audio_timeout", details.message || details.errorMessage || event));
    problems.push(problem(record, "audio_timeout", details.message || details.errorMessage || event));
  }

  if (event === "MEDIA_ASSET_ANALYSIS_FAILED" || event === "MEDIA_BATCH_ALL_FAILED" || event === "IMAGE_PIPELINE_ERROR") {
    result.totals.failedImages += 1;
    result.failedImages.push(problem(record, "failed_image", details.message || event));
    problems.push(problem(record, "failed_image", details.message || event));
  }

  if (event === "ORCHESTRATOR_JSON_INVALID" || String(details.errorMessage || details.message || "").includes("ORCHESTRATOR_PLAN_NOT_JSON")) {
    result.totals.invalidOrchestratorJson += 1;
    result.invalidOrchestratorJson.push(problem(record, "invalid_orchestrator_json", details.textPreview || details.errorMessage || event));
    problems.push(problem(record, "invalid_orchestrator_json", details.textPreview || details.errorMessage || event));
  }

  if (event === "OPENAI_REQUEST_FAILED" || String(details.message || details.errorMessage || "").toLowerCase().includes("openai")) {
    result.totals.openAiFailures += 1;
    result.openAiFailures.push(problem(record, "openai_failure", details.message || details.errorMessage || event));
    problems.push(problem(record, "openai_failure", details.message || details.errorMessage || event));
  }

  if (event === "WOZTELL_SEND_FAILED" || event === "WHATSAPP_SEND_FAILED" || event.includes("WOZTELL") && event.includes("FAILED")) {
    result.totals.woztellSendFailures += 1;
    result.woztellSendFailures.push(problem(record, "woztell_send_failure", details.message || details.errorMessage || event));
    problems.push(problem(record, "woztell_send_failure", details.message || details.errorMessage || event));
  }

  if (event === "WHATSAPP_INTERACTIVE_SEND_FAILED" || event === "WHATSAPP_INTERACTIVE_FALLBACK_SENT") {
    result.totals.interactiveFailures += 1;
    result.interactiveFailures.push(problem(record, "interactive_issue", details.reason || details.message || event));
    problems.push(problem(record, "interactive_issue", details.reason || details.message || event));
  }

  if (event === "TURN_CONTEXT_POLICY" && Number(details.staleMedia || details.stale_media || 0) > 0) {
    result.totals.staleMediaTurns += 1;
    result.staleMediaTurns.push(problem(record, "stale_media", "staleMedia=" + Number(details.staleMedia || details.stale_media || 0)));
    problems.push(problem(record, "stale_media", "staleMedia=" + Number(details.staleMedia || details.stale_media || 0)));
  }

  if (event === "TURN_CONTEXT_RESET_REASON" || event === "TURN_CONTEXT_POLICY" && details.policy && details.policy !== "use_previous_context") {
    result.totals.contextSwitches += 1;
    result.contextSwitches.push(problem(record, "context_switch", details.reason || details.policy || event));
  }

  if (event.startsWith("REMINDER_") && (event.includes("FAILED") || event.includes("MISSING") || event.includes("CANCEL"))) {
    result.totals.reminderIssues += 1;
    result.reminderIssues.push(problem(record, "reminder_issue", details.message || details.errorMessage || event));
    if (event.includes("FAILED") || event.includes("MISSING")) {
      problems.push(problem(record, "reminder_issue", details.message || details.errorMessage || event));
    }
  }
}

result.repeatedErrors = Array.from(errorCounts.entries())
  .filter(function (entry) { return entry[1] > 1; })
  .sort(function (a, b) { return b[1] - a[1]; })
  .slice(0, 20)
  .map(function (entry) {
    return { count: entry[1], signature: entry[0] };
  });

for (const turn of turns.values()) {
  if (turn.bufferReady && !turn.responseSent) {
    result.turnsWithoutResponse.push(turnSummary(turn));
  }
  if (turn.pendingAudio && !turn.responseSent) {
    result.turnsWithPendingAudio.push(turnSummary(turn));
  }
  if (turn.pendingMedia && !turn.responseSent) {
    result.turnsWithPendingMedia.push(turnSummary(turn));
  }
}

result.latestProblemConversations = problems
  .slice(-20)
  .reverse();

console.log(JSON.stringify(result, null, 2));

function parseLogLine(line, file) {
  const clean = String(line || "").trim();

  if (!clean) return null;

  try {
    const parsed = JSON.parse(clean);
    return normalizeRecord(parsed, file, clean);
  } catch (error) {
    const match = clean.match(/^([A-Z0-9_]+):\s*(.*)$/);
    if (!match) return null;

    const event = match[1];
    const rest = match[2];
    let details = {};

    try {
      details = rest ? JSON.parse(rest) : {};
    } catch (innerError) {
      details = { message: rest };
    }

    return normalizeRecord({
      ts: "",
      level: event.includes("ERROR") || event.includes("FAILED") ? "error" : "info",
      event: event,
      details: details
    }, file, clean);
  }
}

function normalizeRecord(record, file, raw) {
  const details = record.details && typeof record.details === "object" ? record.details : {};

  return {
    ts: record.ts || record.timestamp || "",
    level: record.level || "info",
    event: record.event || details.event || "",
    traceId: record.traceId || details.traceId || "",
    turnId: record.turnId || details.turnId || details.turn_id || "",
    doName: record.doName || details.doName || "",
    details: details,
    file: file,
    raw: raw
  };
}

function problem(record, type, message) {
  return {
    ts: record.ts || "",
    type: type,
    event: record.event || "",
    traceId: record.traceId || "",
    turnId: record.turnId || "",
    doName: record.doName || "",
    message: String(message || "").slice(0, 500),
    file: record.file || ""
  };
}

function turnSummary(turn) {
  return {
    turnId: turn.turnId,
    traceId: turn.traceId,
    doName: turn.doName,
    firstTs: turn.firstTs,
    lastTs: turn.lastTs,
    events: Array.from(new Set(turn.events)).slice(-20)
  };
}
