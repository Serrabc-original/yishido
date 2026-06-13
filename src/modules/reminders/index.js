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
  const reminderOffsets = parseReminderOffsets(normalized);
  const recurrence = parseRecurrence(normalized);
  const due = parseDueDate(normalized, now, timezone);
  const title = extractReminderTitle(raw);
  const missingFields = [];

  if (!due.hasDate) missingFields.push("date");
  if (!due.hasTime) missingFields.push("time");
  if (!title) missingFields.push("title");

  const parsed = {
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

export function createReminder(reminders, reminder) {
  try {
    const item = normalizeReminder(reminder);
    const created = Object.assign({}, item, {
      id: item.id || "rem_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
      status: item.status || "scheduled_mock",
      createdAt: item.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    logEvent("REMINDER_CREATE_OK", {
      reminderId: created.id,
      dueAt: created.dueAt,
      title: created.title,
      sendsRealReminders: false
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

  return {
    id: String(clean.id || ""),
    title: String(clean.title || "").trim(),
    dueAt: String(clean.dueAt || ""),
    timezone: String(clean.timezone || "UTC"),
    context: String(clean.context || ""),
    reminderOffsets: Array.isArray(clean.reminderOffsets) ? clean.reminderOffsets.map(String) : [],
    recurrence: clean.recurrence || null,
    confidence: Number(clean.confidence || 0),
    missingFields: Array.isArray(clean.missingFields) ? clean.missingFields.map(String) : []
  };
}

function parseDueDate(normalized, now, timezone) {
  const due = new Date(now);
  let hasDate = false;
  let hasTime = false;

  if (normalized.includes("manana")) {
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
    const meridiem = timeMatch[3] || "";
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
  return String(text || "")
    .replace(/^\s*(recu[eé]rdame|recordarme|anota un recordatorio para|anota recordatorio para|recuerdame)\s*/i, "")
    .replace(/\b(ma[nñ]ana|el viernes|el lunes|el martes|el miercoles|el miércoles|el jueves|el sabado|el sábado|el domingo)\b/gi, "")
    .replace(/\b(a las|a la)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/gi, "")
    .replace(/\b\d+\s*(d[ií]a|dias|días|hora|horas|minuto|minutos)\s+antes\b/gi, "")
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
