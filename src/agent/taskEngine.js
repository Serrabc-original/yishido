import { logEvent, redactForLog } from "../logger.js";
import { normalizeTaskContract } from "../contracts/assistantContracts.js";

const TASK_STATUSES = new Set(["open", "paused", "cancelled", "closed"]);
const TASK_TYPES = new Set(["follow_up", "call", "lead", "review_media", "report", "support", "order", "general"]);

export function normalizeTaskState(state) {
  const clean = state && typeof state === "object" ? state : {};
  return {
    tasks: normalizeTasks(clean.tasks || clean.items || []),
    leads: normalizeLeads(clean.leads || []),
    clients: normalizeClients(clean.clients || clean.clientMemory || []),
    metrics: normalizeTaskMetrics(clean.metrics || {})
  };
}

export function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .map(normalizeTaskContract)
    .filter(function (task) { return task.taskId && task.title; })
    .slice(-100);
}

export function executeTaskAction(state, actionContract, context) {
  const taskState = normalizeTaskState(state);
  const action = actionContract || {};
  const now = context && context.now || new Date().toISOString();
  let result = {
    ok: false,
    state: taskState,
    action: action.action || "",
    userFacingSummary: "",
    task: null
  };

  if (action.action === "create_task") {
    result = createTask(taskState, action.entities || {}, context);
  } else if (action.action === "update_task") {
    result = updateTask(taskState, action.entities || {}, now);
  } else if (action.action === "pause_task") {
    result = setTaskStatus(taskState, action.entities || {}, "paused", now);
  } else if (action.action === "cancel_task") {
    result = setTaskStatus(taskState, action.entities || {}, "cancelled", now);
  } else if (action.action === "close_task") {
    result = setTaskStatus(taskState, action.entities || {}, "closed", now);
  } else if (action.action === "list_tasks") {
    result = {
      ok: true,
      state: taskState,
      action: action.action,
      userFacingSummary: formatTasksForWhatsApp(taskState.tasks),
      task: null
    };
  } else if (action.action === "save_lead") {
    result = saveLead(taskState, action.entities || {}, context);
  } else if (action.action === "update_client_memory") {
    result = updateClientMemory(taskState, action.entities || {}, context);
  }

  logEvent(result.ok ? "TASK_ENGINE_ACTION_OK" : "TASK_ENGINE_ACTION_SKIPPED", {
    action: action.action || "",
    taskId: result.task && result.task.taskId || "",
    taskCount: result.state.tasks.length
  });

  return result;
}

export function buildTaskActionFromTurn(userTurn, route, options) {
  const text = extractTaskText(userTurn);
  const normalized = normalizeText(text);
  const now = options && options.now || new Date().toISOString();
  const mediaRefs = buildTaskMediaRefs(userTurn);

  if (!normalized) return null;
  if (isListTasksRequest(normalized)) return buildAction("list_tasks", {}, 0.9);
  if (isCloseTaskRequest(normalized)) return buildAction("close_task", { title: extractTaskReference(text) }, 0.76);
  if (isPauseTaskRequest(normalized)) return buildAction("pause_task", { title: extractTaskReference(text) }, 0.74);
  if (isCancelTaskRequest(normalized)) return buildAction("cancel_task", { title: extractTaskReference(text) }, 0.74);
  if (isSaveLeadRequest(normalized)) {
    return buildAction("save_lead", {
      name: extractLeadName(text),
      note: text,
      source: "whatsapp",
      mediaRefs: mediaRefs
    }, 0.78);
  }
  if (isClientMemoryRequest(normalized)) {
    return buildAction("update_client_memory", {
      clientName: extractLeadName(text),
      note: text,
      mediaRefs: mediaRefs
    }, 0.72);
  }
  if (isTaskCreateRequest(normalized, route)) {
    return buildAction("create_task", {
      type: inferTaskType(normalized, userTurn),
      title: extractTaskTitle(text),
      description: text,
      dueAt: inferDueAt(normalized, now),
      priority: inferPriority(normalized),
      mediaRefs: mediaRefs,
      leadName: extractLeadName(text)
    }, calculateTaskConfidence(normalized, mediaRefs));
  }

  return null;
}

export function formatTasksForWhatsApp(tasks) {
  const active = normalizeTasks(tasks).filter(function (task) {
    return task.status === "open" || task.status === "paused";
  });

  if (!active.length) return "No tienes tareas abiertas por ahora.";

  return ["Tareas abiertas"].concat(active.slice(-10).map(function (task, index) {
    const due = task.dueAt ? " | " + task.dueAt.slice(0, 16).replace("T", " ") : "";
    const status = task.status === "paused" ? " | pausada" : "";
    return String(index + 1) + ". " + task.title + due + status;
  })).join("\n");
}

export function buildTaskMemoryReadModel(taskState) {
  const state = normalizeTaskState(taskState);
  const openTasks = state.tasks.filter(function (task) { return task.status === "open"; });
  const pausedTasks = state.tasks.filter(function (task) { return task.status === "paused"; });

  return {
    openTaskCount: openTasks.length,
    pausedTaskCount: pausedTasks.length,
    leadCount: state.leads.length,
    clientCount: state.clients.length,
    recentTasks: state.tasks.slice(-8).map(function (task) {
      return {
        taskId: task.taskId,
        type: task.type,
        status: task.status,
        title: task.title,
        dueAt: task.dueAt
      };
    })
  };
}

function createTask(state, entities, context) {
  const now = context && context.now || new Date().toISOString();
  const normalized = normalizeTaskContract({
    taskId: entities.taskId || buildTaskId(),
    type: entities.type || "general",
    status: "open",
    title: entities.title || entities.description || "Tarea pendiente",
    description: entities.description || entities.title || "",
    clientId: entities.clientId || "",
    leadId: entities.leadId || "",
    dueAt: entities.dueAt || "",
    priority: entities.priority || "normal",
    mediaRefs: entities.mediaRefs || {},
    createdAt: now,
    updatedAt: now
  });
  const next = Object.assign({}, state, {
    tasks: state.tasks.concat([normalized]).slice(-100),
    metrics: incrementMetric(state.metrics, "created")
  });

  return {
    ok: true,
    state: next,
    action: "create_task",
    userFacingSummary: "Listo, creé la tarea: " + normalized.title,
    task: normalized
  };
}

function updateTask(state, entities, now) {
  const found = findTask(state.tasks, entities);
  if (!found) return missingTaskResult(state, "update_task");
  const tasks = state.tasks.map(function (task) {
    if (task.taskId !== found.taskId) return task;
    return normalizeTaskContract(Object.assign({}, task, {
      title: entities.title || task.title,
      description: entities.description || task.description,
      dueAt: entities.dueAt || task.dueAt,
      priority: entities.priority || task.priority,
      updatedAt: now
    }));
  });
  const updated = tasks.find(function (task) { return task.taskId === found.taskId; });
  return {
    ok: true,
    state: Object.assign({}, state, { tasks: tasks, metrics: incrementMetric(state.metrics, "updated") }),
    action: "update_task",
    userFacingSummary: "Listo, actualicé la tarea: " + updated.title,
    task: updated
  };
}

function setTaskStatus(state, entities, status, now) {
  const found = findTask(state.tasks, entities);
  if (!found) return missingTaskResult(state, status + "_task");
  const tasks = state.tasks.map(function (task) {
    if (task.taskId !== found.taskId) return task;
    return normalizeTaskContract(Object.assign({}, task, {
      status: status,
      updatedAt: now
    }));
  });
  const updated = tasks.find(function (task) { return task.taskId === found.taskId; });
  return {
    ok: true,
    state: Object.assign({}, state, { tasks: tasks, metrics: incrementMetric(state.metrics, status) }),
    action: status + "_task",
    userFacingSummary: formatStatusSummary(status, updated.title),
    task: updated
  };
}

function saveLead(state, entities, context) {
  const now = context && context.now || new Date().toISOString();
  const lead = {
    leadId: String(entities.leadId || buildId("lead")),
    name: String(entities.name || entities.clientName || "Lead sin nombre").slice(0, 120),
    note: String(entities.note || "").slice(0, 500),
    source: String(entities.source || "whatsapp"),
    mediaRefs: normalizeMediaRefs(entities.mediaRefs || {}),
    createdAt: now,
    updatedAt: now
  };
  return {
    ok: true,
    state: Object.assign({}, state, {
      leads: state.leads.concat([lead]).slice(-100),
      metrics: incrementMetric(state.metrics, "leadsSaved")
    }),
    action: "save_lead",
    userFacingSummary: "Listo, guardé el lead: " + lead.name,
    task: null
  };
}

function updateClientMemory(state, entities, context) {
  const now = context && context.now || new Date().toISOString();
  const name = String(entities.clientName || entities.name || "cliente").slice(0, 120);
  const existing = state.clients.find(function (client) {
    return normalizeText(client.name) === normalizeText(name);
  });
  const client = {
    clientId: existing && existing.clientId || String(entities.clientId || buildId("client")),
    name: name,
    notes: (existing && existing.notes || []).concat([String(entities.note || "").slice(0, 500)]).filter(Boolean).slice(-12),
    mediaRefs: normalizeMediaRefs(entities.mediaRefs || existing && existing.mediaRefs || {}),
    updatedAt: now,
    createdAt: existing && existing.createdAt || now
  };
  const clients = state.clients.filter(function (item) { return item.clientId !== client.clientId; }).concat([client]).slice(-100);
  return {
    ok: true,
    state: Object.assign({}, state, {
      clients: clients,
      metrics: incrementMetric(state.metrics, "clientsUpdated")
    }),
    action: "update_client_memory",
    userFacingSummary: "Listo, actualicé la memoria de cliente: " + client.name,
    task: null
  };
}

function normalizeLeads(leads) {
  return (Array.isArray(leads) ? leads : []).map(function (lead) {
    return redactForLog({
      leadId: String(lead.leadId || lead.lead_id || buildId("lead")),
      name: String(lead.name || "Lead sin nombre").slice(0, 120),
      note: String(lead.note || "").slice(0, 500),
      source: String(lead.source || "whatsapp"),
      mediaRefs: normalizeMediaRefs(lead.mediaRefs || lead.media_refs || {}),
      createdAt: String(lead.createdAt || lead.created_at || new Date().toISOString()),
      updatedAt: String(lead.updatedAt || lead.updated_at || new Date().toISOString())
    });
  }).slice(-100);
}

function normalizeClients(clients) {
  return (Array.isArray(clients) ? clients : []).map(function (client) {
    return redactForLog({
      clientId: String(client.clientId || client.client_id || buildId("client")),
      name: String(client.name || "cliente").slice(0, 120),
      notes: Array.isArray(client.notes) ? client.notes.map(String).slice(-12) : [],
      mediaRefs: normalizeMediaRefs(client.mediaRefs || client.media_refs || {}),
      createdAt: String(client.createdAt || client.created_at || new Date().toISOString()),
      updatedAt: String(client.updatedAt || client.updated_at || new Date().toISOString())
    });
  }).slice(-100);
}

function normalizeTaskMetrics(metrics) {
  return {
    created: Number(metrics.created || 0),
    updated: Number(metrics.updated || 0),
    paused: Number(metrics.paused || 0),
    cancelled: Number(metrics.cancelled || 0),
    closed: Number(metrics.closed || 0),
    leadsSaved: Number(metrics.leadsSaved || 0),
    clientsUpdated: Number(metrics.clientsUpdated || 0)
  };
}

function incrementMetric(metrics, key) {
  const next = normalizeTaskMetrics(metrics || {});
  next[key] = Number(next[key] || 0) + 1;
  return next;
}

function findTask(tasks, entities) {
  const taskId = String(entities.taskId || entities.task_id || "");
  const title = normalizeText(entities.title || entities.query || entities.description || "");
  const active = normalizeTasks(tasks).filter(function (task) {
    return task.status === "open" || task.status === "paused";
  });
  if (taskId) return active.find(function (task) { return task.taskId === taskId; }) || null;
  if (title) {
    return active.slice().reverse().find(function (task) {
      const taskTitle = normalizeText(task.title);
      return taskTitle.includes(title) || title.includes(taskTitle);
    }) || null;
  }
  return active.length ? active[active.length - 1] : null;
}

function missingTaskResult(state, action) {
  return {
    ok: false,
    state: state,
    action: action,
    userFacingSummary: "No encontré una tarea abierta que coincida.",
    task: null
  };
}

function buildAction(action, entities, confidence) {
  return {
    action: action,
    module: action === "save_lead" || action === "update_client_memory" ? "crmLite" : "tasks",
    entities: entities || {},
    missingFields: [],
    confidence: confidence,
    requiresApproval: false,
    status: "planned",
    userFacingSummary: ""
  };
}

function buildTaskMediaRefs(userTurn) {
  const batch = userTurn && (userTurn.media_batch || userTurn.mediaBatch) || {};
  const assets = Array.isArray(batch.assets) ? batch.assets : [];
  return normalizeMediaRefs({
    fileIds: Array.isArray(batch.fileIds) ? batch.fileIds : assets.map(function (asset) { return asset.file_id || asset.fileId; }),
    assetIds: assets.map(function (asset) { return asset.asset_id || asset.assetId; })
  });
}

function normalizeMediaRefs(refs) {
  const clean = refs || {};
  return {
    fileIds: uniqueStrings(clean.fileIds || clean.file_ids || []),
    assetIds: uniqueStrings(clean.assetIds || clean.asset_ids || [])
  };
}

function uniqueStrings(values) {
  return Array.from(new Set((Array.isArray(values) ? values : []).map(String).filter(Boolean)));
}

function extractTaskText(userTurn) {
  const turn = userTurn || {};
  return String(turn.current_turn_text || turn.currentTurnText || turn.text || "").trim();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isListTasksRequest(text) {
  return /\b(muestra|muestrame|ver|lista|listar)\b.*\b(tareas|pendientes|seguimientos)\b/.test(text);
}

function isTaskCreateRequest(text, route) {
  if (route && route.intent === "task") return true;
  return /\b(tarea|pendiente|seguimiento|seguimiento manana|hacer seguimiento|llama|llamar|revisa|revisar|reporte diario)\b/.test(text);
}

function isSaveLeadRequest(text) {
  return /\b(guarda|guardar|registra|registrar)\b.*\b(lead|cliente|prospecto|contacto)\b/.test(text);
}

function isClientMemoryRequest(text) {
  return /\b(actualiza|guarda|anota)\b.*\b(cliente|contacto)\b/.test(text) && !isSaveLeadRequest(text);
}

function isCloseTaskRequest(text) {
  return /\b(cierra|cerrar|termina|terminar|completa|completar|listo)\b.*\b(tarea|pendiente|seguimiento)\b/.test(text);
}

function isPauseTaskRequest(text) {
  return /\b(pausa|pausar|deten|detener)\b.*\b(tarea|pendiente|seguimiento)\b/.test(text);
}

function isCancelTaskRequest(text) {
  return /\b(cancela|cancelar|elimina|eliminar)\b.*\b(tarea|pendiente|seguimiento)\b/.test(text);
}

function inferTaskType(text, userTurn) {
  const imageCount = Number(userTurn && (userTurn.image_count || userTurn.counts && userTurn.counts.image) || 0);
  if (/\b(llama|llamar|llamada)\b/.test(text)) return "call";
  if (/\b(lead|prospecto|cliente|contacto)\b/.test(text)) return "lead";
  if (imageCount > 0 || /\b(foto|fotos|imagen|imagenes|captura|capturas|revisa)\b/.test(text)) return "review_media";
  if (/\b(reporte|informe)\b/.test(text)) return "report";
  if (/\b(soporte|ticket|reclamo|problema)\b/.test(text)) return "support";
  if (/\b(pedido|orden|delivery)\b/.test(text)) return "order";
  if (/\b(seguimiento|seguir)\b/.test(text)) return "follow_up";
  return "general";
}

function inferDueAt(text, nowIso) {
  const now = new Date(nowIso || Date.now());
  if (!Number.isFinite(now.getTime())) return "";
  if (/\bmanana\b/.test(text)) {
    now.setDate(now.getDate() + 1);
    return now.toISOString();
  }
  if (/\bhoy\b/.test(text)) return now.toISOString();
  return "";
}

function inferPriority(text) {
  return /\b(urgente|prioridad|importante|ya)\b/.test(text) ? "high" : "normal";
}

function extractTaskTitle(text) {
  return String(text || "")
    .replace(/^\s*(crea|crear|agrega|agregar|haz|hacer|guarda|guardar|pon|anota)\s+(una\s+|un\s+)?(tarea|pendiente)\s*(de|para)?\s*/i, "")
    .replace(/^\s*(por favor|porfa),?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160) || "Tarea pendiente";
}

function extractTaskReference(text) {
  return extractTaskTitle(text)
    .replace(/^(cierra|cerrar|pausa|pausar|cancela|cancelar|termina|terminar|completa|completar)\s+/i, "")
    .trim();
}

function extractLeadName(text) {
  const raw = String(text || "");
  const explicit = raw.match(/\b(?:lead|cliente|prospecto|contacto)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'-]+){0,3})/);
  if (explicit) return explicit[1].trim();
  const named = raw.match(/\b(?:se llama|llamado|llamada)\s+([A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'-]+(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'-]+){0,3})/);
  return named ? named[1].trim() : "";
}

function calculateTaskConfidence(text, mediaRefs) {
  let score = 0.55;
  if (/\b(tarea|pendiente|seguimiento|llama|llamar)\b/.test(text)) score += 0.2;
  if (/\b(hoy|manana|urgente|cliente|lead)\b/.test(text)) score += 0.1;
  if (mediaRefs && mediaRefs.fileIds && mediaRefs.fileIds.length) score += 0.1;
  return Number(Math.min(score, 0.95).toFixed(2));
}

function formatStatusSummary(status, title) {
  if (status === "paused") return "Listo, pausé la tarea: " + title;
  if (status === "cancelled") return "Listo, cancelé la tarea: " + title;
  if (status === "closed") return "Listo, cerré la tarea: " + title;
  return "Listo, actualicé la tarea: " + title;
}

function buildTaskId() {
  return buildId("task");
}

function buildId(prefix) {
  return prefix + "_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

export function isValidTaskStatus(status) {
  return TASK_STATUSES.has(status);
}

export function isValidTaskType(type) {
  return TASK_TYPES.has(type);
}
