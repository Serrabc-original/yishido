import { createReminder } from "../modules/reminders/index.js";
import {
  getLatestListFromCoreUtilityState,
  normalizeListItems,
  storeLastEphemeralList
} from "../ai/taskStateManager.js";
import {
  hasIntentRouterV2LocalWork,
  shouldDelegateIntentRouterV2TaskToLegacy,
  summarizeToolContract
} from "./toolContracts.js";

export function executeIntentRouterV2Tools(input) {
  const clean = input || {};
  const router = clean.routerResult || {};
  const policy = clean.policyDecision || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
  const data = cloneData(clean.data || {});
  const env = clean.env || {};
  const now = clean.now || new Date().toISOString();
  const coreState = normalizeCoreUtilityState(data.coreUtilityState);
  data.coreUtilityState = coreState;

  const executableTasks = policy.shouldExecuteTools
    ? tasks.filter(function (task) { return task && task.status === "ready"; })
    : tasks.filter(function (task) {
      return task && (task.status === "ready" && task.intent === "list.format" ||
        task.intent === "reminder.create" && task.status === "needs_clarification");
    });

  if (!executableTasks.length) {
    return {
      handled: false,
      shouldContinueLegacyFlow: true,
      updatedData: data,
      toolResults: [],
      executedTools: [],
      blockedTools: []
    };
  }

  if (!hasIntentRouterV2LocalWork(executableTasks)) {
    if (executableTasks.every(shouldDelegateIntentRouterV2TaskToLegacy)) {
      return {
        handled: false,
        shouldContinueLegacyFlow: true,
        updatedData: data,
        toolResults: executableTasks.map(function (task) {
          return buildDelegatedResult(task);
        }),
        executedTools: [],
        blockedTools: []
      };
    }
  }

  const results = [];
  const executedTools = [];
  const blockedTools = [];
  let latestList = getLatestListFromCoreUtilityState(coreState);

  for (const task of executableTasks) {
    if (task.intent === "reminder.create" && task.status === "needs_clarification") {
      const result = storePendingReminderDraft(task, coreState, now);
      results.push(result);
      continue;
    }

    const contract = summarizeToolContract(task);
    if (contract.mode === "legacy") {
      results.push(buildDelegatedResult(task));
      continue;
    }
    if (contract.mode === "unavailable") {
      const unavailable = buildUnavailableResult(task);
      results.push(unavailable);
      blockedTools.push(unavailable.intent);
      continue;
    }

    if (task.intent === "list.format") {
      const result = executeListFormat(task, now);
      if (result.ok) {
        coreState.lastEphemeralList = result.list;
        latestList = result.list;
        data.coreUtilityState = storeLastEphemeralList(coreState, result.list);
        executedTools.push("list.format");
      }
      results.push(result);
      continue;
    }

    if (task.intent === "reminder.create") {
      const result = executeReminderCreate(task, {
        coreState: coreState,
        data: data,
        env: env,
        now: now,
        router: router,
        latestList: latestList,
        userTurn: clean.userTurn || {}
      });
      if (result.ok) {
        coreState.reminders = coreState.reminders.concat([result.reminder]);
        data.coreUtilityState = coreState;
        executedTools.push("reminder.create");
      } else {
        blockedTools.push("reminder.create");
      }
      results.push(result);
    }
  }

  data.coreUtilityState = coreState;

  return {
    handled: true,
    shouldContinueLegacyFlow: false,
    updatedData: data,
    toolResults: results,
    executedTools: executedTools,
    blockedTools: blockedTools
  };
}

function storePendingReminderDraft(task, coreState, now) {
  const entities = task.entities || {};
  const title = cleanReminderTitle(entities.title || entities.subject || "recordatorio");
  const message = cleanReminderMessage(entities.message || entities.body || title);
  coreState.pendingReminderDraft = {
    action: "create",
    intent: "reminder.create",
    title: title,
    message: message,
    timezone: entities.timezone || "America/Guayaquil",
    missingFields: Array.isArray(task.missing_slots) ? task.missing_slots.slice() : ["due_at"],
    updatedAt: now,
    source: "intent_router_v2"
  };
  return {
    intent: "reminder.create",
    ok: true,
    stateOnly: true,
    pending: true,
    title: title,
    message: message,
    userVisibleSummary: "Recordatorio pendiente guardado para aclaracion."
  };
}

function executeListFormat(task, now) {
  const entities = task.entities || {};
  const items = normalizeListItems(entities.items || []);
  const listName = String(entities.listName || entities.list_name || "compras").trim() || "compras";
  if (!items.length) {
    return {
      intent: "list.format",
      ok: false,
      error: "missing_items",
      userVisibleSummary: "No encontre elementos claros para la lista."
    };
  }
  const list = {
    name: listName,
    title: "lista " + listName,
    items: items,
    createdAt: now,
    source: "intent_router_v2"
  };
  return {
    intent: "list.format",
    ok: true,
    listName: listName,
    items: items,
    list: list,
    persisted: false,
    userVisibleSummary: "Lista ordenada en memoria corta de conversacion."
  };
}

function executeReminderCreate(task, context) {
  const entities = task.entities || {};
  const latestList = context.latestList || null;
  const dueAt = resolveDueAt(entities, context.now);
  if (!dueAt) {
    return {
      intent: "reminder.create",
      ok: false,
      error: "missing_due_at",
      missingSlots: ["due_at"],
      userVisibleSummary: "Falta cuando recordar."
    };
  }

  const listItems = normalizeListItems(entities.items || entities.listItems || entities.list_items || []);
  const effectiveItems = listItems.length ? listItems : latestList && latestList.items || [];
  const title = cleanReminderTitle(
    entities.title || entities.subject || (effectiveItems.length ? "lista " + (latestList && latestList.name || "compras") : "recordatorio")
  );
  const message = cleanReminderMessage(
    entities.message || entities.body || (effectiveItems.length ? effectiveItems.join(", ") : title)
  );
  const deliveryMode = String(context.env && context.env.REMINDERS_DELIVERY_MODE || "mock").toLowerCase();
  const reminder = createReminder(context.coreState.reminders, {
    userId: context.data.phone || context.data.doName || "",
    channelId: context.data.channel || "",
    memberId: context.data.member || "",
    appId: context.data.app || "",
    recipientId: context.data.phone || "",
    title: title,
    message: message,
    dueAt: dueAt,
    timezone: entities.timezone || context.router.timezone || context.env.USER_TIMEZONE || "America/Guayaquil",
    context: String(context.userTurn && context.userTurn.current_turn_text || context.userTurn && context.userTurn.combinedUserText || ""),
    sourceContext: {
      turnId: context.userTurn && (context.userTurn.turn_id || context.userTurn.turnId) || "",
      traceId: context.userTurn && (context.userTurn.trace_id || context.userTurn.traceId) || "",
      currentTurnText: context.userTurn && (context.userTurn.current_turn_text || context.userTurn.combinedUserText) || ""
    },
    lastUserInteractionAt: context.data.lastMessageAt || context.now,
    deliveryMode: deliveryMode,
    requiresTemplateIfOutside24h: true,
    status: deliveryMode === "alarm" ? "scheduled_alarm" : "scheduled_mock",
    confidence: Number(task.confidence || 0.86)
  });

  return {
    intent: "reminder.create",
    ok: true,
    title: reminder.title,
    message: reminder.message,
    dueAt: reminder.dueAt,
    relativeDue: entities.relativeDue || entities.relative_due || "",
    reminder: reminder,
    userVisibleSummary: "Recordatorio creado."
  };
}

function resolveDueAt(entities, now) {
  const direct = entities.dueAt || entities.due_at || "";
  if (direct && Number.isFinite(Date.parse(direct))) return new Date(direct).toISOString();
  const relative = String(entities.relativeDue || entities.relative_due || "").toUpperCase();
  const base = new Date(now || Date.now());
  if (!Number.isFinite(base.getTime())) return "";
  const match = relative.match(/^P(?:(\d+)D|T(?:(\d+)H)?(?:(\d+)M)?)$/);
  if (!match) return "";
  const days = Number(match[1] || 0);
  const hours = Number(match[2] || 0);
  const minutes = Number(match[3] || 0);
  if (!days && !hours && !minutes) return "";
  base.setDate(base.getDate() + days);
  base.setHours(base.getHours() + hours);
  base.setMinutes(base.getMinutes() + minutes);
  return base.toISOString();
}

function buildDelegatedResult(task) {
  return {
    intent: String(task && task.intent || ""),
    ok: false,
    delegatedToLegacy: true,
    userVisibleSummary: "Se delega al flujo existente."
  };
}

function buildUnavailableResult(task) {
  return {
    intent: String(task && task.intent || ""),
    ok: false,
    error: "tool_not_connected",
    userVisibleSummary: "La herramienta aun no esta conectada en este flujo."
  };
}

function normalizeCoreUtilityState(state) {
  const clean = state && typeof state === "object" ? state : {};
  return Object.assign({}, clean, {
    reminders: Array.isArray(clean.reminders) ? clean.reminders : []
  });
}

function cloneData(data) {
  return Object.assign({}, data || {}, {
    campaignState: Object.assign({}, data && data.campaignState || {}),
    activeContext: Object.assign({}, data && data.activeContext || {}),
    coreUtilityState: Object.assign({}, data && data.coreUtilityState || {})
  });
}

function cleanReminderTitle(value) {
  return String(value || "recordatorio")
    .replace(/^recordatorio:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim() || "recordatorio";
}

function cleanReminderMessage(value) {
  return String(value || "")
    .replace(/^recordatorio:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}
