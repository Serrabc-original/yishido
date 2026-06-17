const DEFAULT_MAX_TURNS = 6;
const DEFAULT_MAX_MEDIA = 6;

export function buildMemoryRetrievalContext(data, userTurn, options) {
  const clean = data || {};
  const turn = userTurn || {};
  const opts = options || {};
  const query = buildRetrievalQuery(turn);
  const rankedTurns = rankConversationTurns(clean.conversationLog || [], turn, {
    maxTurns: opts.maxTurns || DEFAULT_MAX_TURNS
  });
  const rankedMedia = rankMediaMemory(clean, turn, {
    maxMedia: opts.maxMedia || DEFAULT_MAX_MEDIA
  });
  const selected = {
    turns: rankedTurns.filter(function (item) { return item.score >= 0.35; }).slice(0, opts.maxSelectedTurns || 4),
    media: rankedMedia.filter(function (item) { return item.score >= 0.35; }).slice(0, opts.maxSelectedMedia || 4)
  };

  return {
    version: "memory_retrieval_v1",
    query: query,
    policy: {
      rawHistoryAllowed: false,
      selectedTurnLimit: opts.maxSelectedTurns || 4,
      selectedMediaLimit: opts.maxSelectedMedia || 4
    },
    signals: inferContinuitySignals(turn),
    rankedTurns: rankedTurns,
    rankedMedia: rankedMedia,
    selected: selected,
    source: "conversation_memory_retriever"
  };
}

export function rankConversationTurns(conversationLog, userTurn, options) {
  const turns = Array.isArray(conversationLog) ? conversationLog.slice(-20) : [];
  const query = buildRetrievalQuery(userTurn || {});
  const queryTokens = tokenize(query.text);
  const signals = inferContinuitySignals(userTurn || {});
  const maxTurns = Number(options && options.maxTurns || DEFAULT_MAX_TURNS);

  return turns.map(function (turn, index) {
    const distance = turns.length - index - 1;
    const text = buildTurnSearchText(turn);
    const turnTokens = tokenize(text);
    const overlap = scoreTokenOverlap(queryTokens, turnTokens);
    const recency = turns.length ? Math.max(0, 1 - distance / Math.max(turns.length, 1)) : 0;
    const modality = scoreModalityMatch(turn, userTurn || {});
    const continuity = scoreContinuityMatch(turn, signals);
    const score = clampScore(recency * 0.42 + overlap * 0.28 + modality * 0.15 + continuity * 0.15);

    return {
      source: "conversationLog",
      sourceId: String(turn.turnId || turn.turn_id || ""),
      score: score,
      reasons: buildReasons({ recency: recency, overlap: overlap, modality: modality, continuity: continuity }),
      at: String(turn.at || ""),
      inputTypes: normalizeStringArray(turn.inputTypes || turn.input_types, 8),
      textPreview: sanitizeMemorySnippet(turn.textPreview || ""),
      audioSummary: summarizeText((turn.audioTranscripts || []).join(" "), 180),
      mediaFileIds: normalizeStringArray(turn.media && turn.media.fileIds || [], 8),
      citation: "conversationLog:" + String(turn.turnId || turn.turn_id || index)
    };
  }).filter(function (item) {
    return item.textPreview || item.audioSummary || item.mediaFileIds.length;
  }).sort(sortByScoreThenTime).slice(0, maxTurns);
}

export function rankMediaMemory(data, userTurn, options) {
  const clean = data || {};
  const turn = userTurn || {};
  const maxMedia = Number(options && options.maxMedia || DEFAULT_MAX_MEDIA);
  const signals = inferContinuitySignals(turn);
  const all = []
    .concat(mediaFromCampaignAssets(clean.campaignState && clean.campaignState.campaign_assets || [], "campaign_assets"))
    .concat(mediaFromRecentAssets(clean.recentMediaAssets || [], "recentMediaAssets"))
    .concat(mediaFromRecentMedia(clean.recentMedia || [], "recentMedia"))
    .concat(mediaFromLastUploaded(clean.campaignState || {}));
  const unique = dedupeMedia(all);
  const currentFileIds = new Set(normalizeStringArray(turn.media_batch && turn.media_batch.fileIds || [], 30));
  const previousFileIds = new Set(normalizeStringArray(turn.previousRelevantMedia && turn.previousRelevantMedia.file_ids || turn.previous_relevant_media && turn.previous_relevant_media.file_ids || [], 30));

  return unique.map(function (asset, index) {
    const isCurrent = asset.fileId && currentFileIds.has(asset.fileId);
    const isPrevious = asset.fileId && previousFileIds.has(asset.fileId);
    const recency = scoreMediaRecency(asset.receivedAt, index, unique.length);
    const continuity = signals.referencesMedia || signals.affirmsPreviousAction ? 1 : 0;
    const sourceWeight = asset.source === "campaign_assets" ? 0.9 : asset.source === "recentMediaAssets" ? 0.8 : 0.65;
    const score = clampScore(
      (isCurrent ? 1 : 0) * 0.42 +
      (isPrevious ? 1 : 0) * 0.2 +
      continuity * 0.28 +
      recency * 0.12 +
      sourceWeight * 0.08
    );

    return {
      source: asset.source,
      sourceId: asset.assetId || asset.fileId || asset.url,
      score: score,
      reasons: buildReasons({
        currentTurn: isCurrent ? 1 : 0,
        previousRelevant: isPrevious ? 1 : 0,
        continuity: continuity,
        recency: recency
      }),
      fileId: asset.fileId,
      urlPresent: Boolean(asset.url),
      mediaType: asset.mediaType || "IMAGE",
      caption: sanitizeMemorySnippet(asset.caption || ""),
      summary: sanitizeMemorySnippet(asset.summary || ""),
      turnId: asset.turnId || "",
      receivedAt: asset.receivedAt || "",
      citation: asset.source + ":" + (asset.assetId || asset.fileId || index)
    };
  }).sort(sortByScoreThenTime).slice(0, maxMedia);
}

export function inferContinuitySignals(userTurn) {
  const turn = userTurn || {};
  const text = normalizeText([
    turn.current_turn_text || "",
    turn.combinedUserText || "",
    (turn.audio_transcripts || turn.audioTranscripts || []).join(" "),
    (turn.captions || []).join(" ")
  ].join(" "));

  return {
    referencesAudio: /\b(audio|nota de voz|lo del audio|en el audio|por audio)\b/.test(text),
    referencesList: /\b(lista|compras|pendientes|super)\b/.test(text),
    referencesReminder: /\b(recordatorio|recuerdame|hazme acuerdo|hacer acuerdo|avisame)\b/.test(text),
    referencesMedia: /\b(imagen|foto|captura|portada|version|esa|esta|esto|base)\b/.test(text),
    affirmsPreviousAction: /^(si|dale|ok|claro|hazlo|disenalo|te la paso|portada|otra version)\b/.test(text)
  };
}

function buildRetrievalQuery(userTurn) {
  const turn = userTurn || {};
  const text = [
    turn.current_turn_text || "",
    turn.combinedUserText || "",
    (turn.audio_transcripts || turn.audioTranscripts || []).join(" "),
    (turn.captions || []).join(" ")
  ].join(" ").replace(/\s+/g, " ").trim();

  return {
    text: sanitizeMemorySnippet(text).slice(0, 500),
    inputTypes: normalizeStringArray(turn.input_types || turn.inputTypes || [], 8),
    mediaFileIds: normalizeStringArray(turn.media_batch && turn.media_batch.fileIds || [], 12)
  };
}

function buildTurnSearchText(turn) {
  return [
    turn && turn.textPreview || "",
    (turn && turn.audioTranscripts || []).join(" "),
    (turn && turn.captions || []).join(" "),
    (turn && turn.media && turn.media.fileIds || []).join(" ")
  ].join(" ");
}

function scoreTokenOverlap(queryTokens, turnTokens) {
  if (!queryTokens.length || !turnTokens.length) return 0;
  const turnSet = new Set(turnTokens);
  const hitCount = queryTokens.filter(function (token) { return turnSet.has(token); }).length;
  return Math.min(1, hitCount / Math.max(3, queryTokens.length));
}

function scoreModalityMatch(turn, userTurn) {
  const turnTypes = new Set(normalizeStringArray(turn && turn.inputTypes || turn && turn.input_types || [], 8));
  const userTypes = normalizeStringArray(userTurn && (userTurn.input_types || userTurn.inputTypes) || [], 8);
  if (!turnTypes.size || !userTypes.length) return 0;
  const hits = userTypes.filter(function (type) { return turnTypes.has(type); }).length;
  return hits / userTypes.length;
}

function scoreContinuityMatch(turn, signals) {
  const text = normalizeText(buildTurnSearchText(turn));
  let score = 0;
  if (signals.referencesAudio && /\b(audio|transcrito|nota de voz)\b/.test(text)) score += 0.4;
  if (signals.referencesList && /\b(lista|compras|super|pendientes)\b/.test(text)) score += 0.3;
  if (signals.referencesReminder && /\b(recordatorio|recuerdame|hazme acuerdo|avisame)\b/.test(text)) score += 0.2;
  if (signals.referencesMedia && ((turn.media && turn.media.fileIds || []).length || /\bimagen|foto|captura\b/.test(text))) score += 0.3;
  return Math.min(1, score);
}

function mediaFromCampaignAssets(items, source) {
  return (Array.isArray(items) ? items : []).map(function (asset) {
    const analysis = asset && asset.analysis || {};
    return {
      source: source,
      assetId: String(asset.asset_id || asset.assetId || ""),
      fileId: String(asset.file_id || asset.fileId || ""),
      url: String(asset.url || ""),
      mediaType: String(asset.media_type || asset.mediaType || "IMAGE").toUpperCase(),
      caption: String(asset.caption || ""),
      summary: summarizeText([
        analysis.main_subject || "",
        analysis.product_type || "",
        analysis.visible_text || analysis.visibleText || "",
        analysis.marketing_notes || ""
      ].join(" "), 240),
      turnId: String(asset.turn_id || asset.turnId || asset.request_id || ""),
      receivedAt: String(asset.received_at || asset.receivedAt || "")
    };
  }).filter(validMedia);
}

function mediaFromRecentAssets(items, source) {
  return (Array.isArray(items) ? items : []).map(function (asset) {
    return {
      source: source,
      assetId: "",
      fileId: String(asset.fileId || asset.file_id || ""),
      url: String(asset.url || ""),
      mediaType: String(asset.mediaType || asset.media_type || "IMAGE").toUpperCase(),
      caption: String(asset.caption || ""),
      summary: "",
      turnId: String(asset.turnId || asset.turn_id || ""),
      receivedAt: String(asset.receivedAt || asset.received_at || "")
    };
  }).filter(validMedia);
}

function mediaFromRecentMedia(items, source) {
  return (Array.isArray(items) ? items : []).map(function (asset) {
    return {
      source: source,
      assetId: "",
      fileId: String(asset.file_id || asset.fileId || ""),
      url: String(asset.url || ""),
      mediaType: String(asset.media_type || asset.mediaType || "IMAGE").toUpperCase(),
      caption: String(asset.caption || ""),
      summary: "",
      turnId: String(asset.turn_id || asset.turnId || ""),
      receivedAt: String(asset.received_at || asset.receivedAt || "")
    };
  }).filter(validMedia);
}

function mediaFromLastUploaded(campaignState) {
  const last = campaignState && (campaignState.last_uploaded_image || campaignState.lastUploadedImage) || null;
  if (!last || typeof last !== "object") return [];
  return [{
    source: "last_uploaded_image",
    assetId: "last_uploaded_image",
    fileId: String(last.fileId || last.file_id || ""),
    url: String(last.url || ""),
    mediaType: String(last.type || last.media_type || "IMAGE").toUpperCase(),
    caption: "",
    summary: "",
    turnId: "",
    receivedAt: String(last.receivedAt || last.received_at || "")
  }].filter(validMedia);
}

function validMedia(asset) {
  return Boolean(asset && (asset.fileId || asset.url));
}

function dedupeMedia(items) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = item.fileId || item.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out.slice(-30);
}

function scoreMediaRecency(receivedAt, index, total) {
  const timestamp = Date.parse(receivedAt || "");
  if (timestamp) {
    const ageMs = Date.now() - timestamp;
    if (ageMs < 0) return 0.8;
    return Math.max(0, Math.min(1, 1 - ageMs / (1000 * 60 * 60 * 24)));
  }
  if (!total) return 0;
  return Math.max(0, (index + 1) / total);
}

function sortByScoreThenTime(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  return String(b.receivedAt || b.at || "").localeCompare(String(a.receivedAt || a.at || ""));
}

function buildReasons(scores) {
  return Object.keys(scores || {}).filter(function (key) {
    return Number(scores[key] || 0) > 0.2;
  }).map(function (key) {
    return key + ":" + Number(scores[key]).toFixed(2);
  }).slice(0, 6);
}

function clampScore(value) {
  return Number(Math.max(0, Math.min(1, Number(value || 0))).toFixed(3));
}

function tokenize(text) {
  return normalizeText(text)
    .split(/\s+/)
    .filter(function (token) { return token.length >= 3 && !STOPWORDS.has(token); })
    .slice(0, 80);
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_\s-]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeStringArray(value, limit) {
  return (Array.isArray(value) ? value : []).map(function (item) {
    return String(item || "").trim();
  }).filter(Boolean).slice(0, limit || 12);
}

function sanitizeMemorySnippet(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/\b(?:\+?\d[\s().-]*){8,}\b/g, "[PHONE_REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[SECRET_REDACTED]")
    .replace(/\s+/g, " ")
    .trim();
}

function summarizeText(value, maxLength) {
  return sanitizeMemorySnippet(value).slice(0, maxLength || 220);
}

const STOPWORDS = new Set([
  "que", "con", "para", "por", "una", "uno", "los", "las", "del", "eso", "esta", "este",
  "como", "pero", "me", "te", "de", "la", "el", "en", "un", "y", "o", "si", "no"
]);
