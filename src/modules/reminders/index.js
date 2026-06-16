import { captureError, logEvent } from "../../logger.js";

export const REMINDERS_MODULE = {
  name: "reminders",
  enabledBy: "ENABLE_REMINDERS",
  status: "base",
  sendsRealReminders: false
};

export function parseReminderRequest(text, userTimezone, options) {
  logEvent("REMINDER_PARSE_START", {
    textPreview: String(text || "").slice(0, 240),
    timezone: userTimezone || ""
  });

  const now = options && options.now ? new Date(options.now) : new Date();
  const timezone = userTimezone || "UTC";
  const raw = stripInputPrefixes(String(text || "").trim());
  const normalized = normalizeText(raw);
  const action = inferReminderAction(normalized);
  const reminderOffsets = parseReminderOffsets(normalized);
  const recurrence = parseRecurrence(normalized);
  const due = parseDueDate(normalized, now, timezone);
  const title = action === "cancel" ? extractCancelTitle(raw) : extractReminderTitle(raw);
  const missingFields = [];

  if (action === "create") {
    if (!due.hasDate) missingFields.push("date");
    if (!due.hasTime) missingFields.push("time");
    if (!title) missingFields.push("title");
  } else if (action === "cancel" && !title) {
    missingFields.push("title");
  }

  const parsed = {
    action: action,
    title: title,
    dueAt: due.dueAt ? due.dueAt.toISOString() : "",
    timezone: timezone,
    context: raw,
    reminderOffsets: reminderOffsets,
    recurrence: recurrence,
    confidence: calculateReminderConfidence(title, due, reminderOffsets),
    missingFields: missingFields
  };

  logEvent(missingFields.length ? "REMINDER_PARSE_MISSING_FIELDS" : "REMINDER_PARSE_OK", parsed);
  return parsed;
}

export function createMemoryReminderStore(initial) {
  let reminders = Array.isArray(initial) ? initial.slice() : [];

  return {
    async createReminder(reminder) {
      const created = createReminder(reminders, reminder);
      reminders = reminders.concat([created]);
      return created;
    },
    async listReminders(filter) {
      return listReminders(reminders, filter);
    },
    async cancelReminder(reminderId) {
      reminders = cancelReminder(reminders, reminderId);
      return reminders.find(function (item) { return item.id === reminderId; }) || null;
    },
    async markReminderDone(reminderId) {
      reminders = markReminderDone(reminders, reminderId);
      return reminders.find(function (item) { return item.id === reminderId; }) || null;
    },
    snapshot() {
      return reminders.slice();
    }
  };
}

function inferReminderAction(normalized) {
  if (/\b(cancelar|cancela|elimina|quita)\b.*\brecordatorio\b/.test(normalized)) return "cancel";
  if (/\b(muestrame|mostrar|lista|ver)\b.*\brecordatorios?\b/.test(normalized)) return "list";
  return "create";
}

export function createReminder(reminders, reminder) {
  try {
    const item = normalizeReminder(reminder);
    const reminderId = item.reminderId || item.id || "rem_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    const created = Object.assign({}, item, {
      id: reminderId,
      reminderId: reminderId,
      status: item.status || (item.deliveryMode === "alarm" ? "scheduled_alarm" : "scheduled_mock"),
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    logEvent("REMINDER_CREATED", {
      reminderId: created.reminderId || created.id,
      userId: created.userId,
      dueAt: created.dueAt,
      deliveryMode: created.deliveryMode,
      requiresTemplateIfOutside24h: created.requiresTemplateIfOutside24h
    });
    logEvent("REMINDER_CREATE_OK", {
      reminderId: created.id,
      dueAt: created.dueAt,
      title: created.title,
      sendsRealReminders: created.deliveryMode === "alarm"
    });

    return created;
  } catch (error) {
    captureError(error, { stage: "createReminder" });
    logEvent("REMINDER_CREATE_FAILED", {
      message: String(error.message || error)
    }, { level: "error" });
    throw error;
  }
}

export function listReminders(reminders, filter) {
  const cleanFilter = filter || {};
  const items = (Array.isArray(reminders) ? reminders : []).filter(function (item) {
    if (cleanFilter.status && item.status !== cleanFilter.status) return false;
    return true;
  });

  logEvent("REMINDER_LIST_OK", {
    count: items.length,
    status: cleanFilter.status || ""
  });

  return items;
}

export function cancelReminder(reminders, reminderId) {
  const updated = (Array.isArray(reminders) ? reminders : []).map(function (item) {
    if (item.id !== reminderId) return item;
    return Object.assign({}, item, {
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
  });

  logEvent("REMINDER_CANCEL_OK", {
    reminderId: reminderId
  });

  return updated;
}

export function markReminderDone(reminders, reminderId) {
  return (Array.isArray(reminders) ? reminders : []).map(function (item) {
    if (item.id !== reminderId) return item;
    return Object.assign({}, item, {
      status: "done",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  });
}

function normalizeReminder(reminder) {
  const clean = reminder || {};
  if (!clean.title) throw new Error("REMINDER_TITLE_REQUIRED");
  const deliveryMode = String(clean.deliveryMode || clean.delivery_mode || "mock").toLowerCase();
  const message = String(clean.message || clean.title || "").trim();

  return {
    id: String(clean.id || ""),
    reminderId: String(clean.reminderId || clean.reminder_id || clean.id || ""),
    userId: String(clean.userId || clean.user_id || ""),
    channelId: String(clean.channelId || clean.channel_id || ""),
    memberId: String(clean.memberId || clean.member_id || ""),
    appId: String(clean.appId || clean.app_id || ""),
    recipientId: String(clean.recipientId || clean.recipient_id || ""),
    title: String(clean.title || "").trim(),
    message: message,
    dueAt: String(clean.dueAt || ""),
    timezone: String(clean.timezone || "UTC"),
    context: String(clean.context || ""),
    sourceContext: clean.sourceContext || clean.source_context || null,
    lastUserInteractionAt: String(clean.lastUserInteractionAt || clean.last_user_interaction_at || clean.createdAt || new Date().toISOString()),
    deliveryMode: deliveryMode,
    requiresTemplateIfOutside24h: clean.requiresTemplateIfOutside24h !== false,
    reminderOffsets: Array.isArray(clean.reminderOffsets) ? clean.reminderOffsets.map(String) : [],
    recurrence: clean.recurrence || null,
    confidence: Number(clean.confidence || 0),
    missingFields: Array.isArray(clean.missingFields) ? clean.missingFields.map(String) : [],
    status: String(clean.status || "")
  };
}

export function selectReminderDeliveryPath(reminder, env, options) {
  const clean = reminder || {};
  const now = options && options.now ? new Date(options.now) : new Date();
  const lastInteraction = clean.lastUserInteractionAt ? new Date(clean.lastUserInteractionAt) : now;
  const within24h = Number.isFinite(lastInteraction.getTime())
    ? now.getTime() - lastInteraction.getTime() <= 24 * 60 * 60 * 1000
    : false;
  const template = getReminderTemplateConfig(env || {});

  if (within24h) {
    return {
      path: "session_message",
      within24h: true,
      templateConfigured: Boolean(template.name),
      status: "ready_session_message",
      template: template
    };
  }

  if (!template.name) {
    return {
      path: "blocked_template_required",
      within24h: false,
      templateConfigured: false,
      status: "blocked_template_required",
      template: template
    };
  }

  return {
    path: "template_message",
    within24h: false,
    templateConfigured: true,
    status: "ready_template_message",
    template: template
  };
}

export function getReminderTemplateConfig(env) {
  return {
    name: String(env && env.REMINDER_TEMPLATE_NAME || ""),
    language: String(env && env.REMINDER_TEMPLATE_LANGUAGE || "es"),
    namespace: String(env && env.REMINDER_TEMPLATE_NAMESPACE || ""),
    paramMode: String(env && env.REMINDER_TEMPLATE_PARAM_MODE || "body_text")
  };
}

function parseDueDate(normalized, now, timezone) {
  const due = new Date(now);
  let hasDate = false;
  let hasTime = false;
  const relativeMatches = Array.from(normalized.matchAll(/\b(?:para\s+)?(?:en|dentro de)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h|dia|dias|d)\b/g));
  const relativeMatch = relativeMatches.length ? relativeMatches[relativeMatches.length - 1] : null;

  if (relativeMatch) {
    const value = parseSpokenNumber(relativeMatch[1]);
    const unit = relativeMatch[2];
    if (unit === "min" || unit === "m" || unit.startsWith("minuto")) due.setMinutes(due.getMinutes() + value);
    else if (unit === "h" || unit.startsWith("hora")) due.setHours(due.getHours() + value);
    else due.setDate(due.getDate() + value);
    hasDate = true;
    hasTime = true;
  }

  if (!hasDate && normalized.includes("manana")) {
    due.setDate(due.getDate() + 1);
    hasDate = true;
  }

  const weekday = parseWeekday(normalized);
  if (weekday !== null) {
    const current = due.getDay();
    const delta = (weekday - current + 7) % 7 || 7;
    due.setDate(due.getDate() + delta);
    hasDate = true;
  }

  const dayMatch = normalized.match(/\b(?:el|dia)\s+([0-3]?\d)\b/);
  if (!hasDate && dayMatch && Number(dayMatch[1]) >= 1 && Number(dayMatch[1]) <= 31) {
    const day = Number(dayMatch[1]);
    due.setDate(day);
    if (due < now) due.setMonth(due.getMonth() + 1);
    hasDate = true;
  }

  const timeMatch = normalized.match(/\b(?:a\s+las\s+|a\s+la\s+|at\s+)?([01]?\d|2[0-3])(?::([0-5]\d))?\s*(am|pm)?\b/);
  if (timeMatch && normalized.match(/\b(a\s+las|a\s+la|am|pm|:\d{2})\b/)) {
    let hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] || 0);
    const meridiem = timeMatch[3] || inferSpanishDaypart(normalized);
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    setTimeForTimezone(due, hour, minute, timezone);
    hasTime = true;
  }

  return {
    dueAt: hasDate || hasTime ? due : null,
    hasDate: hasDate,
    hasTime: hasTime
  };
}

function parseSpokenNumber(value) {
  const clean = String(value || "").toLowerCase();
  const words = {
    un: 1,
    una: 1,
    uno: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10,
    quince: 15,
    veinte: 20,
    treinta: 30
  };
  const parsed = Number(clean);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return words[clean] || 0;
}

function inferSpanishDaypart(normalized) {
  const clean = String(normalized || "");
  if (/\b(de la tarde|por la tarde|tarde|de la noche|por la noche|noche)\b/.test(clean)) return "pm";
  if (/\b(de la manana|de la ma[ñn]ana|por la manana|por la ma[ñn]ana)\b/.test(clean)) return "am";
  return "";
}

function setTimeForTimezone(date, hour, minute, timezone) {
  const offsetHours = getTimezoneOffsetHours(timezone);
  date.setTime(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    hour - offsetHours,
    minute,
    0,
    0
  ));
}

function getTimezoneOffsetHours(timezone) {
  const clean = String(timezone || "").toLowerCase();
  const offsets = {
    "america/bogota": -5,
    "america/lima": -5,
    "america/quito": -5,
    "america/mexico_city": -6,
    "america/new_york": -5,
    "utc": 0
  };

  return Object.prototype.hasOwnProperty.call(offsets, clean) ? offsets[clean] : 0;
}

function parseReminderOffsets(normalized) {
  const offsets = [];
  const pattern = /(\d+)\s*(dia|dias|d|hora|horas|h|minuto|minutos|m)\s+antes/g;
  let match;

  while ((match = pattern.exec(normalized))) {
    const value = match[1];
    const unit = match[2];
    if (unit.startsWith("dia") || unit === "d") offsets.push(value + "d");
    else if (unit.startsWith("hora") || unit === "h") offsets.push(value + "h");
    else offsets.push(value + "m");
  }

  return Array.from(new Set(offsets));
}

function parseRecurrence(normalized) {
  if (normalized.includes("cada dia") || normalized.includes("diario")) return "daily";
  if (normalized.includes("cada semana") || normalized.includes("semanal")) return "weekly";
  if (normalized.includes("cada mes") || normalized.includes("mensual")) return "monthly";
  return null;
}

function extractReminderTitle(text) {
  const inferredTitle = extractSmartReminderTitle(text);
  if (inferredTitle) return inferredTitle;

  return String(text || "")
    .replace(/^\s*(ya,?\s*)?gracias[,.]?\s*/i, "")
    .replace(/^\s*(me\s+puedes\s+poner|puedes\s+ponerme|ponme|pon|crea|agrega|hazme|hacerme)\s+(otro\s+)?(un\s+)?recordatorio(?:\s+(de|para)\b)?\??\s*/i, "")
    .replace(/\b(me\s+puedes\s+poner|puedes\s+ponerme|ponme|pon|crea|agrega|hazme|hacerme)\s+(otro\s+)?(un\s+)?recordatorio(?:\s+(de|para)\b)?\??\s*/gi, " ")
    .replace(/^\s*(hazme acuerdo|av[ií]same|avisame)\s*/i, "")
    .replace(/^\s*(recu[eé]rdame|recordarme|anota un recordatorio para|anota recordatorio para|recuerdame)\s*/i, "")
    .replace(/\ben\s+\d+\s*(minuto|minutos|hora|horas|d[ií]a|dias|días)\b/gi, "")
    .replace(/\b(ma[nñ]ana|el viernes|el lunes|el martes|el miercoles|el miércoles|el jueves|el sabado|el sábado|el domingo)\b/gi, "")
    .replace(/\b(a las|a la)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, "")
    .replace(/\b\d+\s*(d[ií]a|dias|días|hora|horas|minuto|minutos)\s+antes\b/gi, "")
    .replace(/\b(?:para\s+)?(?:en|dentro de)\s+\d+\s*(min|minuto|minutos|m|hora|horas|h|d[iÃ­]a|dias|dÃ­as|d)\b/gi, "")
    .replace(/\b(vi\s+que\s+)?(tengo|tenia|debo|necesito)\s+que\s+/gi, "")
    .replace(/\bpara\s+(?=(llamar|comprar|pagar|hacer|enviar|revisar|mandar|escribir|actualizar)\b)/gi, "")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:?\s]+|[,.;:?\s]+$/g, "")
    .trim();
}

function extractSmartReminderTitle(text) {
  const raw = String(text || "").replace(/\s+/g, " ");
  const explicitShoppingList = raw.match(/\b(?:esta\s+)?lista\s+(?:necesito\s+que\s+)?(?:son|sean)\s+([^.!?]{3,240})/i);
  if (explicitShoppingList) return cleanupReminderTitle("comprar " + explicitShoppingList[1]);

  const shopping = raw.match(/\b(?:lista|cosas)\s+que\s+(?:tengo\s+que\s+)?comprar\b[^.?!]*?(?:son|sean)\s+([^.!?]{3,240})/i);
  if (shopping) return cleanupReminderTitle("comprar " + shopping[1]);

  const purposeMatches = Array.from(raw.matchAll(/\bpara\s+(?:yo\s+poder\s+)?((?:llamar|comprar|pagar|hacer|enviar|revisar|mandar|escribir|actualizar)\b[^.?!,;]{0,160})/gi));
  if (purposeMatches.length) return cleanupReminderTitle(purposeMatches[purposeMatches.length - 1][1]);

  const actionMatches = Array.from(raw.matchAll(/\b((?:llamar|comprar|pagar|hacer|enviar|revisar|mandar|escribir|actualizar)\b[^.?!,;]{0,160})/gi));
  if (actionMatches.length) return cleanupReminderTitle(actionMatches[actionMatches.length - 1][1]);

  return "";
}

function cleanupReminderTitle(text) {
  return String(text || "")
    .replace(/\b(ma[ñn]ana|hoy|pasado ma[ñn]ana)\b/gi, "")
    .replace(/\b(?:para\s+)?(?:en|dentro de)\s+(\d+|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta)\s*(min|minuto|minutos|m|hora|horas|h|d[ií]a|dias|días|d)\b/gi, "")
    .replace(/\b(a las|a la)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, "")
    .replace(/\b(de la tarde|por la tarde|de la noche|por la noche|de la manana|de la ma[ñn]ana|por la manana|por la ma[ñn]ana)\b/gi, "")
    .replace(/\b(por favor|entonces|necesito ese recordatorio|ese recordatorio|mejor|que digo|qu[eé] digo|no importa)\b/gi, " ")
    .replace(/\bno,?\s+no\s+tienes\s+que\s+.+$/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[,.;:?\s]+|[,.;:?\s]+$/g, "")
    .trim();
}

function extractCancelTitle(text) {
  return String(text || "")
    .replace(/^\s*(cancelar|cancela|elimina|quita)\s+(el\s+)?recordatorio\s+(de\s+|para\s+)?/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function calculateReminderConfidence(title, due, offsets) {
  let score = 0.2;
  if (title) score += 0.25;
  if (due.hasDate) score += 0.25;
  if (due.hasTime) score += 0.2;
  if (offsets.length) score += 0.1;
  return Number(Math.min(score, 1).toFixed(2));
}

function parseWeekday(normalized) {
  const weekdays = [
    ["domingo", 0],
    ["lunes", 1],
    ["martes", 2],
    ["miercoles", 3],
    ["jueves", 4],
    ["viernes", 5],
    ["sabado", 6]
  ];

  for (const [name, index] of weekdays) {
    if (normalized.includes(name)) return index;
  }

  return null;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripInputPrefixes(text) {
  return String(text || "")
    .replace(/^\s*\[Audio transcrito\]:\s*/i, "")
    .replace(/^\s*\[Texto adicional\]:\s*/i, "")
    .trim();
}
