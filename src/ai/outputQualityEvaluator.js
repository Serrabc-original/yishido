export function evaluateCustomerReplyQuality(input) {
  const clean = input || {};
  const replyText = String(clean.replyText || "").trim();
  const userTurn = clean.userTurn || {};
  const intent = String(clean.intent || "").toLowerCase();
  const memoryReadModel = clean.memoryReadModel || {};
  const recentMediaAssets = Array.isArray(clean.recentMediaAssets) ? clean.recentMediaAssets : [];
  const reasons = [];
  const userText = getUserTurnText(userTurn);
  const normalizedReply = normalizeText(replyText);
  const imageCount = getImageCount(userTurn);
  const recentImageCount = recentMediaAssets.filter(function (asset) {
    return String(asset.mediaType || asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
  }).length;

  if (!replyText) reasons.push("empty_reply");
  if (looksLikeFalseMissingMedia(normalizedReply) && (imageCount > 0 || recentImageCount > 0 || hasRetrievedMedia(memoryReadModel))) {
    reasons.push("asks_reupload_when_media_exists");
  }
  if (!isReminderIntent(intent) && looksLikeStaleReminderReply(normalizedReply, userText)) {
    reasons.push("stale_reminder_leaked");
  }
  if (isListIntent(intent) && looksLikePollutedListReply(normalizedReply)) {
    reasons.push("list_reply_contains_reminder_question");
  }
  if (looksTooRobotic(normalizedReply)) {
    reasons.push("robotic_or_system_style");
  }

  const repairedText = reasons.length
    ? buildQualityRepair({
      reasons: reasons,
      replyText: replyText,
      userText: userText,
      intent: intent,
      memoryReadModel: memoryReadModel,
      imageCount: imageCount,
      recentImageCount: recentImageCount
    })
    : "";

  return {
    ok: reasons.length === 0,
    score: Number(Math.max(0, 1 - reasons.length * 0.22).toFixed(2)),
    reasons: reasons,
    repairedText: repairedText,
    shouldSend: Boolean(replyText || repairedText)
  };
}

export function buildQualityRepair(input) {
  const clean = input || {};
  const reasons = clean.reasons || [];
  const userText = String(clean.userText || "");
  const memory = clean.memoryReadModel || {};
  const latestAudio = findLatestAudioSummary(memory);
  const latestList = findLatestRecentList(memory);
  const normalizedUserText = normalizeText(userText);

  if (reasons.includes("asks_reupload_when_media_exists")) {
    if (/\b(cute|chevere|version|portada|diseno|disena|disenalo)\b/i.test(normalizedUserText)) {
      return "Si, uso la imagen que ya tenemos como base :)\n\nTe preparo una version con ese cambio.";
    }
    return "Si, tengo la imagen reciente. La uso como referencia para responderte :)";
  }

  if (reasons.includes("list_reply_contains_reminder_question") && latestList && latestList.items && latestList.items.length) {
    return "Listo, dejo la lista limpia:\n" + latestList.items.slice(0, 12).map(function (item) {
      return "- " + item;
    }).join("\n");
  }

  if (reasons.includes("stale_reminder_leaked")) {
    if (/\b(audio|lo del audio)\b/i.test(normalizedUserText) && latestAudio) {
      return "Perdon, mezcle el contexto. Lo del audio era: " + latestAudio;
    }
    return "Perdon, mezcle un recordatorio anterior. Me quedo con tu ultimo mensaje: quieres que lo corrija o que te muestre lo que entendi?";
  }

  if (reasons.includes("robotic_or_system_style")) {
    return humanizePlainText(clean.replyText || "");
  }

  return "";
}

function getUserTurnText(userTurn) {
  return String([
    userTurn && (userTurn.combinedUserText || userTurn.current_turn_text || userTurn.currentTurnText || "") || "",
    (userTurn && (userTurn.audio_transcripts || userTurn.audioTranscripts) || []).join(" ")
  ].join(" ")).replace(/\s+/g, " ").trim();
}

function getImageCount(userTurn) {
  return Number(userTurn && (userTurn.image_count || userTurn.imageCount || userTurn.counts && userTurn.counts.image) || 0);
}

function hasRetrievedMedia(memoryReadModel) {
  const selected = memoryReadModel && memoryReadModel.retrieved && memoryReadModel.retrieved.selected || {};
  return Array.isArray(selected.media) && selected.media.length > 0;
}

function findLatestAudioSummary(memoryReadModel) {
  const customer = memoryReadModel && memoryReadModel.shortTerm && memoryReadModel.shortTerm.customerMemory || {};
  const direct = String(customer.last_audio_summary || customer.lastAudioSummary || "").trim();
  if (direct) return direct;
  const selectedTurns = memoryReadModel && memoryReadModel.retrieved && memoryReadModel.retrieved.selected && memoryReadModel.retrieved.selected.turns || [];
  const match = selectedTurns.find(function (turn) {
    return String(turn.audioSummary || "").trim();
  });
  return match ? String(match.audioSummary || "").trim() : "";
}

function findLatestRecentList(memoryReadModel) {
  const utility = memoryReadModel && memoryReadModel.shortTerm && memoryReadModel.shortTerm.utilityMemory || {};
  const lists = Array.isArray(utility.recent_lists || utility.recentLists) ? utility.recent_lists || utility.recentLists : [];
  return lists[0] || null;
}

function looksLikeFalseMissingMedia(text) {
  return /\b(reenviame|vuelve a enviar|mandame la imagen|no veo la imagen|no tengo la imagen|no me llego la imagen)\b/.test(text);
}

function looksLikeStaleReminderReply(replyText, userText) {
  if (!/\b(recordatorio|te lo recordare|hacer acuerdo)\b/.test(replyText)) return false;
  if (/\b(recordatorio|recuerdame|hazme acuerdo|hacer acuerdo|avisame)\b/.test(normalizeText(userText))) return false;
  return true;
}

function looksLikePollutedListReply(text) {
  return /\b(en cuantos minutos|me vas a hacer acuerdo|hacer acuerdo de esta lista|lista:\s*de compras\?)\b/.test(text);
}

function looksTooRobotic(text) {
  if (!text) return false;
  return /\b(modulo|orquestador|systemresult|supervisor|json|tool|payload|undefined|null)\b/.test(text) ||
    /^lista:\s*de\s+/i.test(text) ||
    /\brecibi la imagen\. dime si quieres que la analice, lea texto visible, la compare\b/.test(text);
}

function isReminderIntent(intent) {
  return intent === "reminder" || intent === "list_reminder";
}

function isListIntent(intent) {
  return intent === "list" || intent === "list_reminder";
}

function humanizePlainText(text) {
  return String(text || "")
    .replace(/^Listo,\s*/i, "Listo, ")
    .replace(/\s+/g, " ")
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
