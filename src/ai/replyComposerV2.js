import { splitConversationalText } from "./finalResponseComposer.js";

const SMILE = "\u{1F60A}";

export function composeReplyV2(input) {
  const clean = input || {};
  const router = clean.routerResult || clean.intentRouterResult || {};
  const policy = clean.policyDecision || clean.policyGateDecision || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
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
  return buildReply(strategy.human_summary || "Claro, te ayudo.", true, "answer_only", maxChars);
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
    .trim();
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
