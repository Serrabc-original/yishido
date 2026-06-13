import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { redactForLog } from "../src/logger.js";

const EXPECTED_EVENTS = [
  "WEBHOOK_RECEIVED",
  "MESSAGE_NORMALIZED",
  "TURN_CREATED",
  "TURN_BUFFER_READY",
  "ORCHESTRATOR_PROVIDER_SELECTED",
  "ORCHESTRATOR_ACTIONS_SELECTED",
  "USER_RESPONSE_SENT"
];

export function buildBugReport(records, traceId) {
  const relevant = records.filter(function (record) {
    return record.traceId === traceId || record.details && record.details.traceId === traceId;
  });
  const events = relevant.map(function (record) { return record.event; });
  const eventSet = new Set(events);
  const errors = relevant.filter(function (record) {
    return record.level === "error" || String(record.event || "").includes("ERROR") || String(record.event || "").includes("FAILED");
  });
  const fallbacks = relevant.filter(function (record) {
    return record.event === "USER_FALLBACK_SENT" || record.event === "WHATSAPP_INTERACTIVE_FALLBACK_SENT";
  });
  const missingExpectedEvents = EXPECTED_EVENTS.filter(function (event) {
    return !eventSet.has(event);
  });
  const first = relevant[0] || {};
  const last = relevant[relevant.length - 1] || {};

  return redactForLog({
    traceId: traceId,
    turnId: first.turnId || first.details && (first.details.turnId || first.details.turn_id) || "",
    doName: first.doName || first.details && first.details.doName || "",
    timestamps: {
      first: first.ts || "",
      last: last.ts || ""
    },
    eventCount: relevant.length,
    events: relevant,
    errors: errors,
    fallbackSent: fallbacks.length > 0,
    fallbacks: fallbacks,
    missingExpectedEvents: missingExpectedEvents,
    possibleRootCause: inferRootCause(relevant, errors, missingExpectedEvents)
  });
}

export function readLogRecords(logsDir) {
  if (!existsSync(logsDir)) return [];

  const files = readdirSync(logsDir)
    .filter(function (file) {
      return /^agent-.*\.log$/.test(file) || /^errors-.*\.log$/.test(file);
    })
    .sort();
  const records = [];

  for (const file of files) {
    const fullPath = join(logsDir, file);
    const lines = readFileSync(fullPath, "utf8").split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
      const parsed = parseLogLine(line, file);
      if (parsed) records.push(parsed);
    }
  }

  return records;
}

export function exportBugReport(options) {
  const clean = options || {};
  const traceId = clean.traceId;

  if (!traceId) {
    throw new Error("TRACE_ID_REQUIRED");
  }

  const cwd = clean.cwd || process.cwd();
  const logsDir = clean.logsDir || join(cwd, "logs");
  const outDir = clean.outDir || join(cwd, "bug-reports");
  const records = clean.records || readLogRecords(logsDir);
  const report = buildBugReport(records, traceId);

  mkdirSync(outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const safeTraceId = traceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  const filePath = join(outDir, "bug-report-" + safeTraceId + "-" + timestamp + ".json");
  writeFileSync(filePath, JSON.stringify(report, null, 2), "utf8");

  return {
    filePath: filePath,
    report: report
  };
}

function parseLogLine(line, file) {
  const clean = String(line || "").trim();

  if (!clean) return null;

  try {
    return normalizeRecord(JSON.parse(clean), file, clean);
  } catch (error) {
    const match = clean.match(/^([A-Z0-9_]+):\s*(.*)$/);
    if (!match) return null;
    let details = {};
    try {
      details = match[2] ? JSON.parse(match[2]) : {};
    } catch (innerError) {
      details = { message: match[2] || "" };
    }
    return normalizeRecord({
      event: match[1],
      level: match[1].includes("ERROR") || match[1].includes("FAILED") ? "error" : "info",
      details: details
    }, file, clean);
  }
}

function normalizeRecord(record, file, raw) {
  const details = record.details && typeof record.details === "object" ? record.details : {};

  return redactForLog({
    ts: record.ts || record.timestamp || "",
    level: record.level || "info",
    event: record.event || details.event || "",
    traceId: record.traceId || details.traceId || "",
    turnId: record.turnId || details.turnId || details.turn_id || "",
    doName: record.doName || details.doName || "",
    details: details,
    file: file,
    raw: raw
  });
}

function inferRootCause(records, errors, missingExpectedEvents) {
  if (!records.length) {
    return "No log events found for this traceId. Confirm the traceId and log files.";
  }

  if (errors.some(function (record) { return String(record.event).includes("ORCHESTRATOR") || String(record.details && record.details.errorMessage || "").includes("ORCHESTRATOR"); })) {
    return "The orchestrator likely failed or returned invalid JSON.";
  }

  if (errors.some(function (record) { return String(record.event).includes("AUDIO") || String(record.details && record.details.message || "").includes("AUDIO"); })) {
    return "The audio pipeline likely failed before a usable transcript reached the turn.";
  }

  if (errors.some(function (record) { return String(record.event).includes("MEDIA") || String(record.event).includes("IMAGE"); })) {
    return "A media or image-analysis step likely failed. Check campaign_assets and per-asset status.";
  }

  if (missingExpectedEvents.includes("USER_RESPONSE_SENT")) {
    return "The turn appears to have started but no user response was logged.";
  }

  if (missingExpectedEvents.length) {
    return "Some expected lifecycle events are missing: " + missingExpectedEvents.join(", ");
  }

  return "No obvious root cause detected from structured logs.";
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const out = {};

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--traceId") out.traceId = args[i + 1] || "";
  }

  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const args = parseArgs(process.argv);
    const result = exportBugReport({
      traceId: args.traceId
    });
    console.log(JSON.stringify({
      status: "ok",
      filePath: result.filePath,
      eventCount: result.report.eventCount,
      missingExpectedEvents: result.report.missingExpectedEvents
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: "error",
      message: String(error.message || error)
    }, null, 2));
    process.exit(1);
  }
}
