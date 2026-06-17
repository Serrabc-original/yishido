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
        task.intent === "reminder.create" && task.status === "needs_clarification" ||
        isPendingCrmStateTask(task));
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

    if (isPendingCrmStateTask(task)) {
      const result = storePendingCrmAction(task, coreState, now);
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
      continue;
    }

    if (task.intent === "crm.search") {
      const result = executeCrmSearch(task, coreState);
      executedTools.push("crm.search");
      results.push(result);
      continue;
    }

    if (task.intent === "crm.create") {
      const result = executeCrmCreate(task, coreState, now);
      if (result.ok) executedTools.push("crm.create");
      else blockedTools.push("crm.create");
      results.push(result);
      continue;
    }

    if (task.intent === "crm.update") {
      const result = executeCrmUpdate(task, coreState, now);
      if (result.ok) executedTools.push("crm.update");
      else blockedTools.push("crm.update");
      results.push(result);
      continue;
    }

    if (task.intent === "crm.delete") {
      const result = executeCrmDelete(task, coreState);
      if (result.ok) executedTools.push("crm.delete");
      else blockedTools.push("crm.delete");
      results.push(result);
      continue;
    }

    if (task.intent === "document.search" || task.intent === "document.send_existing") {
      const result = executeDocumentSearch(task, {
        coreState: coreState,
        data: data,
        tenantConfig: clean.tenantConfig || {},
        userTurn: clean.userTurn || {}
      });
      executedTools.push(task.intent);
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

function isPendingCrmStateTask(task) {
  return task && /^crm\./.test(String(task.intent || "")) && task.status === "needs_confirmation";
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

function storePendingCrmAction(task, coreState, now) {
  const entities = normalizeCrmEntities(task.entities || {});
  coreState.pendingCrmAction = {
    intent: String(task.intent || ""),
    entities: entities,
    status: "awaiting_confirmation",
    updatedAt: now,
    source: "intent_router_v2"
  };
  return {
    intent: String(task.intent || ""),
    ok: true,
    stateOnly: true,
    pending: true,
    entities: entities,
    userVisibleSummary: "Accion CRM pendiente de confirmacion."
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

function executeCrmSearch(task, coreState) {
  const query = buildCrmQuery(task.entities || {});
  const matches = findCrmRecords(coreState, query);
  return {
    intent: "crm.search",
    ok: true,
    query: query,
    matches: matches.slice(0, 5),
    count: matches.length,
    userVisibleSummary: matches.length ? "Cliente encontrado." : "No encontre clientes con ese dato."
  };
}

function executeCrmCreate(task, coreState, now) {
  const entities = normalizeCrmEntities(task.entities || {});
  const identifier = entities.cedula || entities.phone || entities.email || entities.name;
  if (!identifier) {
    return {
      intent: "crm.create",
      ok: false,
      error: "missing_client_identifier",
      missingSlots: ["client_identifier"],
      userVisibleSummary: "Falta identificar el cliente."
    };
  }

  const client = buildClientRecord(entities, now);
  coreState.clients = upsertClient(coreState.clients || [], client);
  coreState.pendingCrmAction = null;
  return {
    intent: "crm.create",
    ok: true,
    client: client,
    userVisibleSummary: "Cliente creado."
  };
}

function executeCrmUpdate(task, coreState, now) {
  const entities = normalizeCrmEntities(task.entities || {});
  const identifier = entities.clientId || entities.cedula || entities.phone || entities.email || entities.name;
  if (!identifier) {
    return {
      intent: "crm.update",
      ok: false,
      error: "missing_client_identifier",
      missingSlots: ["client_identifier"],
      userVisibleSummary: "Falta identificar el cliente."
    };
  }

  const current = findCrmRecords(coreState, entities)[0] || null;
  const client = buildClientRecord(Object.assign({}, current && current.raw || {}, entities), now, current && current.id);
  coreState.clients = upsertClient(coreState.clients || [], client);
  coreState.pendingCrmAction = null;
  return {
    intent: "crm.update",
    ok: true,
    client: client,
    created: !current,
    userVisibleSummary: current ? "Cliente actualizado." : "Cliente creado desde actualizacion confirmada."
  };
}

function executeCrmDelete(task, coreState) {
  const entities = normalizeCrmEntities(task.entities || {});
  const matches = findCrmRecords(coreState, entities);
  if (!matches.length) {
    return {
      intent: "crm.delete",
      ok: false,
      error: "client_not_found",
      userVisibleSummary: "No encontre ese cliente para borrar."
    };
  }
  const ids = new Set(matches.map(function (match) { return match.id; }).filter(Boolean));
  coreState.clients = (coreState.clients || []).filter(function (client) {
    return !ids.has(getCrmRecordId(client, "client"));
  });
  coreState.leads = (coreState.leads || []).filter(function (lead) {
    return !ids.has(getCrmRecordId(lead, "lead"));
  });
  coreState.pendingCrmAction = null;
  return {
    intent: "crm.delete",
    ok: true,
    deletedCount: ids.size,
    deleted: matches.slice(0, 5),
    userVisibleSummary: "Cliente borrado."
  };
}

function executeDocumentSearch(task, context) {
  const entities = task.entities || {};
  const query = String(entities.query || entities.documentName || entities.document_name || "").trim();
  const documents = collectExistingDocuments(context);
  const matches = findDocuments(documents, query);
  const found = matches[0] || null;
  return {
    intent: String(task.intent || "document.search"),
    ok: true,
    query: query,
    count: matches.length,
    document: found,
    matches: matches.slice(0, 5),
    generated: false,
    userVisibleSummary: found ? "Documento existente encontrado." : "No encontre un documento existente con ese nombre."
  };
}

function collectExistingDocuments(context) {
  const coreState = context.coreState || {};
  const tenant = context.tenantConfig || {};
  const data = context.data || {};
  const campaignState = data.campaignState || {};
  return []
    .concat(normalizeDocumentRecords(coreState.documents || []))
    .concat(normalizeDocumentRecords(coreState.documentCatalog || coreState.document_catalog || []))
    .concat(normalizeDocumentRecords(tenant.documents || tenant.document_catalog || tenant.documentCatalog || []))
    .concat(normalizeDocumentRecords(data.documents || data.documentCatalog || []))
    .concat(normalizeCampaignFileDocuments(campaignState.campaign_assets || []));
}

function normalizeCampaignFileDocuments(assets) {
  return (Array.isArray(assets) ? assets : []).filter(function (asset) {
    return String(asset && (asset.media_type || asset.mediaType) || "").toUpperCase() === "FILE";
  }).map(function (asset, index) {
    return {
      id: String(asset.asset_id || asset.assetId || asset.file_id || asset.fileId || "document_" + (index + 1)),
      name: String(asset.name || asset.filename || asset.file_name || asset.caption || asset.file_id || "documento existente"),
      url: String(asset.url || ""),
      fileId: String(asset.file_id || asset.fileId || ""),
      source: "campaign_assets"
    };
  });
}

function normalizeDocumentRecords(documents) {
  return (Array.isArray(documents) ? documents : []).map(function (item, index) {
    const clean = item || {};
    return {
      id: String(clean.id || clean.documentId || clean.document_id || clean.fileId || clean.file_id || "document_" + (index + 1)),
      name: String(clean.name || clean.title || clean.documentName || clean.document_name || clean.filename || "documento existente"),
      url: String(clean.url || clean.webUrl || clean.web_url || clean.downloadUrl || clean.download_url || ""),
      fileId: String(clean.fileId || clean.file_id || ""),
      source: String(clean.source || "document_catalog")
    };
  }).filter(function (doc) { return doc.id || doc.name || doc.url || doc.fileId; });
}

function findDocuments(documents, query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return documents.slice(0, 5);
  const queryTokens = normalizedQuery.split(" ").filter(function (token) { return token.length > 2; });
  return documents.map(function (doc) {
    const haystack = normalizeSearchText([doc.name, doc.id, doc.fileId, doc.source].join(" "));
    const score = queryTokens.reduce(function (total, token) {
      return total + (haystack.includes(token) ? 1 : 0);
    }, haystack.includes(normalizedQuery) ? 2 : 0);
    return { doc: doc, score: score };
  }).filter(function (item) { return item.score > 0; })
    .sort(function (a, b) { return b.score - a.score; })
    .map(function (item) { return item.doc; });
}

function normalizeCrmEntities(entities) {
  const clean = entities || {};
  return {
    clientId: String(clean.clientId || clean.client_id || "").trim(),
    leadId: String(clean.leadId || clean.lead_id || "").trim(),
    name: String(clean.name || clean.clientName || clean.client_name || "").trim(),
    cedula: normalizeDigits(clean.cedula || clean.document || clean.documento || clean.dni || ""),
    phone: normalizeDigits(clean.phone || clean.telefono || clean.telefonoNuevo || clean.telefono_nuevo || ""),
    email: String(clean.email || clean.correo || "").trim(),
    interest: String(clean.interest || clean.interes || "").trim(),
    stage: String(clean.stage || clean.etapa || "").trim(),
    notes: String(clean.notes || clean.note || clean.nota || "").trim(),
    source: String(clean.source || clean.fuente || "whatsapp").trim(),
    responsible: String(clean.responsible || clean.responsable || "").trim()
  };
}

function buildCrmQuery(entities) {
  const clean = normalizeCrmEntities(entities);
  const query = String(entities.query || entities.q || "").trim();
  return Object.assign({}, clean, { query: query });
}

function findCrmRecords(coreState, query) {
  const cleanQuery = normalizeCrmEntities(query || {});
  const textQuery = normalizeSearchText(query && query.query || "");
  const records = normalizeCrmRecords(coreState);
  return records.filter(function (record) {
    const raw = record.raw || {};
    if (cleanQuery.clientId && String(raw.clientId || raw.client_id || "") === cleanQuery.clientId) return true;
    if (cleanQuery.leadId && String(raw.leadId || raw.lead_id || "") === cleanQuery.leadId) return true;
    if (cleanQuery.cedula && normalizeDigits(raw.cedula || raw.document || raw.documento || raw.dni || "") === cleanQuery.cedula) return true;
    if (cleanQuery.phone && normalizeDigits(raw.phone || raw.telefono || "") === cleanQuery.phone) return true;
    if (cleanQuery.email && normalizeSearchText(raw.email || raw.correo || "") === normalizeSearchText(cleanQuery.email)) return true;
    if (cleanQuery.name && normalizeSearchText(raw.name || raw.clientName || "").includes(normalizeSearchText(cleanQuery.name))) return true;
    if (textQuery) return normalizeSearchText(JSON.stringify(raw)).includes(textQuery);
    return false;
  });
}

function normalizeCrmRecords(coreState) {
  const clients = Array.isArray(coreState.clients) ? coreState.clients : [];
  const leads = Array.isArray(coreState.leads) ? coreState.leads : [];
  return clients.map(function (client) {
    return {
      id: getCrmRecordId(client, "client"),
      type: "client",
      name: client.name || "",
      raw: client
    };
  }).concat(leads.map(function (lead) {
    return {
      id: getCrmRecordId(lead, "lead"),
      type: "lead",
      name: lead.name || "",
      raw: lead
    };
  }));
}

function getCrmRecordId(record, prefix) {
  return String(record && (record.clientId || record.client_id || record.leadId || record.lead_id || record.id) || prefix + "_" + normalizeSearchText(record && record.name || ""));
}

function buildClientRecord(entities, now, existingId) {
  const clean = normalizeCrmEntities(entities || {});
  const id = String(existingId || clean.clientId || "client_" + stableCrmKey(clean));
  return {
    clientId: id,
    name: clean.name || "Cliente sin nombre",
    cedula: clean.cedula,
    phone: clean.phone,
    email: clean.email,
    interest: clean.interest,
    stage: clean.stage,
    notes: clean.notes ? [clean.notes] : [],
    source: clean.source || "whatsapp",
    responsible: clean.responsible,
    createdAt: String(entities.createdAt || entities.created_at || now),
    updatedAt: now
  };
}

function upsertClient(clients, client) {
  const id = getCrmRecordId(client, "client");
  const next = (Array.isArray(clients) ? clients : []).filter(function (item) {
    return getCrmRecordId(item, "client") !== id;
  });
  next.push(client);
  return next.slice(-100);
}

function stableCrmKey(entities) {
  const source = entities.cedula || entities.phone || entities.email || entities.name || String(Date.now());
  return normalizeSearchText(source).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "nuevo";
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D+/g, "");
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    reminders: Array.isArray(clean.reminders) ? clean.reminders : [],
    leads: Array.isArray(clean.leads) ? clean.leads : [],
    clients: Array.isArray(clean.clients) ? clean.clients : [],
    documents: Array.isArray(clean.documents) ? clean.documents : [],
    pendingCrmAction: clean.pendingCrmAction || clean.pending_crm_action || null
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
