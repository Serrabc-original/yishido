import { getTurnAggregationTiming, isUserDoneSignal } from "../conversation/turnAggregator.js";

export function getBufferTimingConfig(env) {
  const timing = getTurnAggregationTiming(env || {});
  return {
    bufferWaitSeconds: Math.max(1, Math.round((Number(env && env.BUFFER_WAIT_SECONDS || 0) || timing.minWaitMs / 1000))),
    imageMessageWaitSeconds: Math.max(1, Math.round((Number(env && env.IMAGE_MESSAGE_WAIT_SECONDS || 0) || timing.silenceMs / 1000))),
    bufferMaxWaitSeconds: Math.max(1, Math.round((Number(env && env.BUFFER_MAX_WAIT_SECONDS || 0) || timing.maxWaitMs / 1000))),
    turnSilenceMs: timing.silenceMs,
    turnMaxWaitMs: timing.maxWaitMs,
    turnMinWaitMs: timing.minWaitMs
  };
}

export function hasOpenPendingTurn(data, now, env) {
  const state = data || {};
  const pending = Array.isArray(state.pendingMessages) ? state.pendingMessages : [];
  if (!state.currentTurnId || !pending.length) return false;

  const timing = getTurnAggregationTiming(env || {});
  const firstAt = Number(state.firstMessageAt || now || Date.now());
  const ageMs = Number(now || Date.now()) - firstAt;
  return ageMs <= timing.maxWaitMs;
}

export function shouldHoldMediaTurnForMoreEvents(data, messages, env, options) {
  const list = Array.isArray(messages) ? messages : [];
  const hasMedia = list.some(function (message) {
    return Boolean(message && (message.fileId || message.media && message.media.length || ["IMAGE", "VIDEO", "FILE"].includes(String(message.type || "").toUpperCase())));
  });

  if (!hasMedia) return { hold: false };

  const hasClearTextOrAudio = list.some(function (message) {
    const type = String(message && message.type || "").toUpperCase();
    const text = cleanVisibleTurnText(message && (message.audioTranscript || message.text) || "");
    return Boolean(text && (type === "TEXT" || type === "AUDIO" || message && message.audioTranscript));
  });

  const combinedText = list.map(function (message) {
    return message && (message.audioTranscript || message.text) || "";
  }).join("\n");
  if (hasClearTextOrAudio || isUserDoneSignal(combinedText)) return { hold: false };

  const timing = getTurnAggregationTiming(env || {});
  const firstAt = Number(data && data.firstMessageAt || Date.now());
  const now = Number(options && options.now || Date.now());
  const ageMs = now - firstAt;
  const nextProcessAt = firstAt + timing.maxWaitMs;

  if (ageMs >= timing.maxWaitMs) return { hold: false };

  return {
    hold: true,
    reason: "media_only_waiting_for_turn_max",
    ageMs: ageMs,
    nextProcessAt: nextProcessAt
  };
}

export function buildAppendProcessTiming(params) {
  const clean = params || {};
  const data = clean.data || {};
  const timing = clean.timing || getBufferTimingConfig(clean.env || {});
  const hasMedia = Boolean(clean.hasMedia);
  const waitReason = hasMedia ? "media_message" : "text_or_audio_transcript";
  const waitSeconds = hasMedia ? timing.imageMessageWaitSeconds : timing.bufferWaitSeconds;
  const desiredProcessAt = Number(data.lastMessageAt || clean.now || Date.now()) + waitSeconds * 1000;
  const maxProcessAt = Number(data.firstMessageAt || clean.now || Date.now()) + timing.bufferMaxWaitSeconds * 1000;
  let processAfter = clean.taskDecision && clean.activeTask && clean.activeTask.status === "awaiting_media"
    ? clean.taskDecision.nextProcessAt || Math.min(desiredProcessAt, maxProcessAt)
    : Math.min(desiredProcessAt, maxProcessAt);

  const mediaHold = clean.mediaHold || { hold: false };
  if (mediaHold.hold) processAfter = mediaHold.nextProcessAt;
  if (clean.userDone && clean.existingOpen) processAfter = Number(clean.now || Date.now());

  return {
    timing: timing,
    waitReason: waitReason,
    waitSeconds: waitSeconds,
    desiredProcessAt: desiredProcessAt,
    maxProcessAt: maxProcessAt,
    mediaHold: mediaHold,
    processAfter: processAfter
  };
}

function cleanVisibleTurnText(text) {
  return String(text || "")
    .replace(/\[(IMAGE|VIDEO|FILE) uploaded without caption\]/gi, "")
    .replace(/\[AUDIO pending transcription\]/gi, "")
    .replace(/\[AUDIO no transcrito\]/gi, "")
    .replace(/^\[Audio transcrito\]:\s*/i, "")
    .trim();
}
