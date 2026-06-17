import { splitConversationalText } from "./finalResponseComposer.js";

const SMILE = "\u{1F60A}";

export function composeReplyV2(input) {
  const clean = input || {};
  const router = clean.routerResult || clean.intentRouterResult || {};
  const policy = clean.policyDecision || clean.policyGateDecision || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
  const toolResults = Array.isArray(clean.toolResults) ? clean.toolResults : Array.isArray(policy.toolResults) ? policy.toolResults : [];
  const tenant = clean.tenantConfig || {};
  const maxChars = Number(clean.maxChars || tenant.max_reply_chars || tenant.maxReplyChars || 650);

  if (policy.shouldSendBotReply === false || policy.decision === "do_nothing") {
    return buildReply("", false, "do_nothing", maxChars);
  }

  if (policy.decision === "repair" || router.turn_type === "correction") {
    return buildReply(
      "Tienes razon, me confundi. No voy a crear nada todavia. " + SMILE,
      true,
      "repair",
      maxChars
    );
  }

  if (policy.decision === "ask_clarification") {
    return buildReply(buildClarificationReply(tasks, policy), true, "ask_clarification", maxChars);
  }

  if (policy.decision === "ask_confirmation") {
    return buildReply(buildConfirmationReply(tasks, policy), true, "ask_confirmation", maxChars);
  }

  if (toolResults.length && hasUnavailableTool(toolResults)) {
    return buildReply(buildUnavailableToolReply(tasks, toolResults), true, "tool_unavailable", maxChars);
  }

  const executedList = findResult(toolResults, "list.format");
  const executedReminder = findResult(toolResults, "reminder.create");
  if (executedList && executedList.ok && executedReminder && executedReminder.ok) {
    return buildReply(buildExecutedListReminderReply(executedList, executedReminder), true, "execute_and_confirm", maxChars);
  }

  if (executedReminder && executedReminder.ok) {
    return buildReply(buildExecutedReminderReply(executedReminder), true, "execute_and_confirm", maxChars);
  }

  if (executedList && executedList.ok) {
    return buildReply(buildExecutedListReply(executedList), true, "answer_only", maxChars);
  }

  const crmResult = findFirstResult(toolResults, ["crm.search", "crm.create", "crm.update", "crm.delete"]);
  if (crmResult && crmResult.ok) {
    return buildReply(buildCrmResultReply(crmResult), true, "execute_and_confirm", maxChars);
  }

  const documentResult = findFirstResult(toolResults, ["document.search", "document.send_existing"]);
  if (documentResult && documentResult.ok) {
    return buildReply(buildDocumentResultReply(documentResult), true, "execute_and_confirm", maxChars);
  }

  const imageTask = findTask(tasks, "image.edit") || findTask(tasks, "image.generate");
  if (imageTask) {
    return buildReply(buildImageReply(imageTask), true, "execute_and_confirm", maxChars);
  }

  const listTask = findTask(tasks, "list.format");
  const reminderTask = findTask(tasks, "reminder.create");
  if (listTask && reminderTask && reminderTask.status === "ready") {
    return buildReply(buildListReminderReply(listTask, reminderTask), true, "execute_and_confirm", maxChars);
  }

  if (listTask) {
    return buildReply(buildListReply(listTask), true, "answer_only", maxChars);
  }

  if (policy.decision === "execute") {
    return buildReply(buildExecutionAck(tasks, policy), true, "execute_and_confirm", maxChars);
  }

  const strategy = router.reply_strategy || {};
  return buildReply(buildFallbackReply(strategy.human_summary), true, "answer_only", maxChars);
}

function buildReply(text, shouldSend, finalReplyType, maxChars) {
  const cleanText = polishText(text);
  return {
    text: cleanText,
    shouldSend: Boolean(shouldSend && cleanText),
    finalReplyType: finalReplyType,
    splitMessages: splitConversationalText(cleanText, { maxChars: maxChars })
  };
}

function buildClarificationReply(tasks, policy) {
  const question = ensureQuestion(policy.oneQuestionToAsk || policy.one_question_to_ask || "Que dato falta para continuar?");
  const listTask = findTask(tasks, "list.format");
  const reminderTask = findTask(tasks, "reminder.create");

  if (listTask && reminderTask && hasMissingSlot(reminderTask, "due_at")) {
    return "Listo, tengo la lista. " + question;
  }

  return "Claro " + SMILE + " " + question;
}

function buildConfirmationReply(tasks, policy) {
  const deleteTask = findTask(tasks, "crm.delete");
  if (deleteTask) {
    const name = deleteTask.entities && (deleteTask.entities.name || deleteTask.entities.query) || "ese cliente";
    return "Para estar seguros: confirmas que quieres borrar " + name + "?";
  }

  const updateTask = findTask(tasks, "crm.update");
  if (updateTask) {
    const lines = formatCrmFields(updateTask.entities || {});
    const body = lines.length
      ? "Entendi estos datos para actualizar el cliente:\n" + lines.join("\n")
      : "Entendi que quieres actualizar un cliente, pero necesito confirmar los datos.";
    return body + "\nLo guardo asi?";
  }

  const createTask = findTask(tasks, "crm.create");
  if (createTask) {
    const lines = formatCrmFields(createTask.entities || {});
    const body = lines.length
      ? "Entendi estos datos para crear el cliente:\n" + lines.join("\n")
      : "Entendi que quieres crear un cliente, pero necesito confirmar los datos.";
    return body + "\nLo guardo asi?";
  }

  return ensureQuestion(policy.oneQuestionToAsk || policy.one_question_to_ask || "Confirmas que sigo?");
}

function buildImageReply(task) {
  const instruction = normalizeText(task.entities && task.entities.instruction || "");
  if (/\bportada\b/.test(instruction)) {
    return "Dale " + SMILE + " Uso la imagen que me mandaste y la preparo como portada.";
  }
  if (/\b(cute|chevere|otra version|version)\b/.test(instruction)) {
    return "Dale " + SMILE + " Uso la imagen anterior y preparo otra version con ese estilo.";
  }
  return "Dale " + SMILE + " Uso la imagen que ya tengo y preparo ese cambio.";
}

function buildListReminderReply(listTask, reminderTask) {
  const list = buildNumberedList(listTask.entities && listTask.entities.items || []);
  const due = formatRelativeDue(reminderTask.entities && reminderTask.entities.relativeDue || "");
  const intro = "Listo " + SMILE + " Te guarde la lista y te la recuerdo" + (due ? " en " + due : "") + ":";
  return [intro, list].filter(Boolean).join("\n");
}

function buildListReply(listTask) {
  const list = buildNumberedList(listTask.entities && listTask.entities.items || []);
  return ["Listo " + SMILE + " Te ordene la lista:", list].filter(Boolean).join("\n");
}

function buildExecutedListReply(result) {
  const list = buildNumberedList(result.items || []);
  return ["Listo " + SMILE + " Te ordene la lista:", list].filter(Boolean).join("\n");
}

function buildExecutedListReminderReply(listResult, reminderResult) {
  const list = buildNumberedList(listResult.items || []);
  const due = formatRelativeDue(reminderResult.relativeDue || "");
  const intro = "Listo " + SMILE + " Te guarde la lista y te la recuerdo" + (due ? " en " + due : "") + ":";
  return [intro, list].filter(Boolean).join("\n");
}

function buildExecutedReminderReply(result) {
  const due = formatRelativeDue(result.relativeDue || "");
  const title = result.title || "eso";
  return "Listo " + SMILE + " Te recuerdo " + title + (due ? " en " + due : "") + ".";
}

function buildExecutionAck(tasks) {
  const crmSearch = findTask(tasks, "crm.search");
  if (crmSearch) return "Listo " + SMILE + " Busco ese cliente y te paso lo que encuentre.";

  const doc = findTask(tasks, "document.search") || findTask(tasks, "document.send_existing");
  if (doc) return "Claro " + SMILE + " Busco el documento existente y te lo paso si esta disponible.";

  const reminder = findTask(tasks, "reminder.create");
  if (reminder) {
    const title = reminder.entities && reminder.entities.title || "recordatorio";
    const due = formatRelativeDue(reminder.entities && reminder.entities.relativeDue || "");
    return "Listo " + SMILE + " Te recuerdo " + title + (due ? " en " + due : "") + ".";
  }

  return "Listo " + SMILE + " Lo hago y te confirmo.";
}

function buildCrmResultReply(result) {
  if (result.intent === "crm.search") {
    const matches = Array.isArray(result.matches) ? result.matches : [];
    if (!matches.length) return "No encontre ese cliente todavia " + SMILE;
    const lines = matches.slice(0, 3).map(function (match, index) {
      const raw = match.raw || match.client || match || {};
      const name = raw.name || match.name || "Cliente";
      const phone = raw.phone || raw.telefono || "";
      const email = raw.email || raw.correo || "";
      const extra = [phone, email].filter(Boolean).join(" | ");
      return String(index + 1) + ". " + name + (extra ? " - " + extra : "");
    });
    return ["Listo " + SMILE + " Encontre:", lines.join("\n")].join("\n");
  }

  if (result.intent === "crm.create") {
    return "Listo " + SMILE + " Guarde el cliente: " + formatCrmRecordName(result.client) + ".";
  }

  if (result.intent === "crm.update") {
    return "Listo " + SMILE + " Actualice el cliente: " + formatCrmRecordName(result.client) + ".";
  }

  if (result.intent === "crm.delete") {
    return "Listo " + SMILE + " Borre el cliente confirmado.";
  }

  return "Listo " + SMILE + " Actualice el CRM.";
}

function buildDocumentResultReply(result) {
  const document = result.document || {};
  if (!document || !document.name && !document.url && !document.fileId) {
    return "No encontre ese documento existente " + SMILE + " No voy a generar uno nuevo.";
  }
  const name = document.name || "documento";
  const ref = document.url || document.fileId || document.id || "";
  return "Listo " + SMILE + " Encontre el documento existente: " + name + (ref ? "\n" + ref : "");
}

function buildUnavailableToolReply(tasks, toolResults) {
  const unavailable = toolResults.find(function (result) { return result && result.error === "tool_not_connected"; }) || {};
  const intent = unavailable.intent || "";
  const crm = findTask(tasks, "crm.search") || findTask(tasks, "crm.create") || findTask(tasks, "crm.update") || findTask(tasks, "crm.delete");
  if (crm || /^crm\./.test(intent)) {
    return "Claro " + SMILE + " Entendi la solicitud de cliente, pero esa herramienta aun no esta conectada aqui. No voy a guardar ni borrar nada todavia.";
  }
  const doc = findTask(tasks, "document.search") || findTask(tasks, "document.send_existing");
  if (doc || /^document\./.test(intent)) {
    return "Claro " + SMILE + " Puedo buscar un documento existente cuando esa fuente este conectada. No voy a generar un archivo nuevo.";
  }
  return "Claro " + SMILE + " Entendi la solicitud, pero esa herramienta aun no esta conectada aqui.";
}

function buildNumberedList(items) {
  return (Array.isArray(items) ? items : [])
    .map(function (item, index) {
      return String(index + 1) + ". " + capitalizeItem(item);
    })
    .join("\n");
}

function formatCrmFields(entities) {
  const rows = [];
  if (entities.name) rows.push("- Nombre: " + entities.name);
  if (entities.phone) rows.push("- Telefono: " + entities.phone);
  if (entities.email) rows.push("- Email: " + entities.email);
  if (entities.interest || entities.interes) rows.push("- Interes: " + (entities.interest || entities.interes));
  if (entities.stage || entities.etapa) rows.push("- Etapa: " + (entities.stage || entities.etapa));
  if (entities.notes || entities.note) rows.push("- Nota: " + (entities.notes || entities.note));
  return rows;
}

function formatRelativeDue(value) {
  const clean = String(value || "").toUpperCase();
  const match = clean.match(/^P(?:T)?(\d+)([MHD])$/);
  if (!match) return "";
  const amount = Number(match[1]);
  const unit = match[2];
  if (unit === "M") return amount + " minuto" + (amount === 1 ? "" : "s");
  if (unit === "H") return amount + " hora" + (amount === 1 ? "" : "s");
  return amount + " dia" + (amount === 1 ? "" : "s");
}

function findTask(tasks, intent) {
  return (Array.isArray(tasks) ? tasks : []).find(function (task) {
    return task && (task.intent === intent || task.task_id === intent || task.taskId === intent);
  }) || null;
}

function findResult(results, intent) {
  return (Array.isArray(results) ? results : []).find(function (result) {
    return result && result.intent === intent;
  }) || null;
}

function findFirstResult(results, intents) {
  const wanted = new Set(Array.isArray(intents) ? intents : []);
  return (Array.isArray(results) ? results : []).find(function (result) {
    return result && wanted.has(result.intent);
  }) || null;
}

function hasUnavailableTool(results) {
  return (Array.isArray(results) ? results : []).some(function (result) {
    return result && result.error === "tool_not_connected";
  });
}

function hasMissingSlot(task, slot) {
  const missing = Array.isArray(task && task.missing_slots) ? task.missing_slots : [];
  return missing.includes(slot);
}

function ensureQuestion(text) {
  const clean = String(text || "").trim().replace(/[.!\s]+$/g, "");
  return clean.endsWith("?") ? clean : clean + "?";
}

function capitalizeItem(value) {
  const clean = String(value || "").trim();
  if (!clean) return "";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function polishText(text) {
  return String(text || "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\bResponder sin herramienta\.?/ig, "Claro, te ayudo.")
    .replace(/\bNo hay intencion clara\.?/ig, "No tengo claro que necesitas.")
    .trim();
}

function formatCrmRecordName(record) {
  return record && (record.name || record.clientName || record.client_name) || "cliente";
}

function buildFallbackReply(summary) {
  const clean = String(summary || "").trim();
  if (!clean || /responder sin herramienta|no hay intencion clara/i.test(clean)) {
    return "Claro " + SMILE + " No tengo claro si quieres que haga algo o solo te responda. Me explicas un poco mas?";
  }
  return clean;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
