import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildWhatsAppInteractiveResponse, sendWhatsAppInteractiveMessage } from "../src/whatsapp/sendInteractiveMessage.js";
import { parseReminderRequest, createMemoryReminderStore } from "../src/modules/reminders/index.js";
import { addListItems, createList, listItems, markListItemDone, parseListCommand, removeListItems } from "../src/modules/lists/index.js";
import { routeCoreUtilityIntent } from "../src/coreUtilityRouter.js";
import { exportBugReport } from "../scripts/export-bug-report.js";

test("interactive messages build quick replies and list fallback for many buttons", () => {
  const quick = buildWhatsAppInteractiveResponse({
    text: "Elige",
    buttons: [
      { id: "approve", title: "Aprobar" },
      { id: "edit", title: "Editar" },
      { id: "cancel", title: "Cancelar" }
    ]
  });
  const list = buildWhatsAppInteractiveResponse({
    text: "Elige",
    buttons: [
      { id: "one", title: "Uno" },
      { id: "two", title: "Dos" },
      { id: "three", title: "Tres" },
      { id: "four", title: "Cuatro" }
    ]
  });

  assert.equal(quick[0].type, "QUICK_REPLY");
  assert.equal(quick[0].quickReplies.length, 3);
  assert.equal(list[0].type, "LIST");
  assert.equal(list[0].sections[0].rows.length, 4);
});

test("interactive message falls back to text when disabled", async () => {
  const sent = [];
  const result = await sendWhatsAppInteractiveMessage({}, {
    channelId: "channel",
    recipientId: "user",
    text: "Quieres aprobar?",
    buttons: [{ id: "approve", title: "Aprobar" }],
    fallbackText: "Responde Aprobar o Editar"
  }, {
    transport: async (payload) => {
      sent.push(payload);
      return { ok: true };
    }
  });

  assert.equal(result.mode, "fallback");
  assert.equal(sent[0].response[0].type, "TEXT");
});

test("reminder parser handles tomorrow, offsets, missing date and missing time", () => {
  const now = "2026-06-12T12:00:00.000Z";
  const tomorrow = parseReminderRequest("Recuérdame mañana a las 9 llamar a Juan", "America/Bogota", { now });
  const offsets = parseReminderRequest("Recuérdame 1 día antes y 1 hora antes de la reunión", "America/Bogota", { now });
  const missingDate = parseReminderRequest("Recuérdame a las 9 llamar a Juan", "America/Bogota", { now });
  const missingTime = parseReminderRequest("Recuérdame el viernes comprar medicina", "America/Bogota", { now });

  assert.equal(tomorrow.missingFields.length, 0);
  assert.match(tomorrow.dueAt, /^2026-06-13T14:00:00/);
  assert.deepEqual(offsets.reminderOffsets, ["1d", "1h"]);
  assert.equal(missingDate.missingFields.includes("date"), true);
  assert.equal(missingTime.missingFields.includes("time"), true);
});

test("reminder memory store creates and lists mock reminders", async () => {
  const store = createMemoryReminderStore();
  await store.createReminder({
    title: "llamar a Juan",
    dueAt: "2026-06-13T09:00:00.000Z",
    timezone: "America/Bogota"
  });
  const reminders = await store.listReminders();

  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].status, "scheduled_mock");
});

test("lists create, add, remove, mark done and list items", () => {
  let state = createList({}, "super");
  state = addListItems(state, "super", ["leche", "pan", "huevos"]);
  state = removeListItems(state, "super", ["huevos"]);
  state = markListItemDone(state, "super", "pan");
  const list = listItems(state, "super");

  assert.deepEqual(list.items.map((item) => item.text), ["leche", "pan"]);
  assert.equal(list.items.find((item) => item.text === "pan").done, true);
});

test("list parser extracts action, list name and items", () => {
  const parsed = parseListCommand("Anota leche, pan y huevos en mi lista del súper");

  assert.equal(parsed.action, "add");
  assert.equal(parsed.listName.toLowerCase().includes("súper") || parsed.listName.toLowerCase().includes("super"), true);
  assert.deepEqual(parsed.items, ["leche", "pan", "huevos"]);
});

test("bug report exports trace bundle, redacts secrets and detects missing events", () => {
  const dir = mkdtempSync(join(tmpdir(), "yishido-bug-report-"));
  const logsDir = join(dir, "logs");
  const outDir = join(dir, "bug-reports");

  try {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "agent-2026-06-12.log"), [
      JSON.stringify({ ts: "1", event: "WEBHOOK_RECEIVED", traceId: "trace_test", details: { Authorization: "Bearer secret" } }),
      JSON.stringify({ ts: "2", event: "TURN_CREATED", traceId: "trace_test", turnId: "turn_1", doName: "channel:user", details: { phone: "+573001234567" } }),
      JSON.stringify({ ts: "3", level: "error", event: "ERROR_CAPTURED", traceId: "trace_test", details: { errorMessage: "ORCHESTRATOR_PLAN_NOT_JSON" } })
    ].join("\n"), "utf8");

    const result = exportBugReport({
      traceId: "trace_test",
      cwd: dir,
      logsDir,
      outDir
    });
    const saved = JSON.parse(readFileSync(result.filePath, "utf8"));

    assert.equal(saved.traceId, "trace_test");
    assert.equal(saved.errors.length, 1);
    assert.equal(saved.missingExpectedEvents.includes("USER_RESPONSE_SENT"), true);
    assert.equal(JSON.stringify(saved).includes("secret"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("core utility router classifies reminder, list, marketing and general", () => {
  const reminder = routeCoreUtilityIntent({ current_turn_text: "Recuérdame mañana a las 9 llamar a Juan" }, {
    flags: { enableReminders: true },
    now: "2026-06-12T12:00:00.000Z"
  });
  const list = routeCoreUtilityIntent({ current_turn_text: "Agrega cargadores tipo C a lista de inventario" }, {
    flags: { enableLists: true }
  });
  const marketing = routeCoreUtilityIntent({ current_turn_text: "Hazme un post para Instagram" });
  const general = routeCoreUtilityIntent({ current_turn_text: "Qué significa este mensaje?" });

  assert.equal(reminder.intent, "reminder");
  assert.equal(reminder.shouldHandleInCore, true);
  assert.equal(list.intent, "list");
  assert.equal(marketing.intent, "marketing");
  assert.equal(general.intent, "general");
});
