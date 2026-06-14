import { logEvent } from "../logger.js";

export const TURN_SILENCE_MS = 8000;
export const TURN_MAX_WAIT_MS = 45000;
export const TURN_AUDIO_MAX_WAIT_MS = 75000;
export const TURN_MIN_WAIT_MS = 5000;

export function getTurnAggregationTiming(env) {
  return {
    silenceMs: numberEnv(env && env.TURN_SILENCE_MS, TURN_SILENCE_MS),
    maxWaitMs: numberEnv(env && env.TURN_MAX_WAIT_MS, TURN_MAX_WAIT_MS),
    audioMaxWaitMs: numberEnv(env && env.TURN_AUDIO_MAX_WAIT_MS, TURN_AUDIO_MAX_WAIT_MS),
    minWaitMs: numberEnv(env && env.TURN_MIN_WAIT_MS, TURN_MIN_WAIT_MS)
  };
}

export function appendPendingEvent(data, normalizedMessage, options) {
  const state = data || {};
  const message = normalizedMessage || {};
  const traceId = options && options.traceId || message.traceId || "";
  const before = Array.isArray(state.pendingMessages) ? state.pendingMessages.length : 0;

  logEvent("TURN_PENDING_BEFORE_APPEND", {
    traceId: traceId,
    turnId: message.turnId || state.currentTurnId || "",
    doName: state.doName || "",
    pendingCount: before,
    messageId: message.messageId || "",
    type: message.type || ""
  });

  state.pendingMessages = Array.isArray(state.pendingMessages) ? state.pendingMessages : [];
  state.pendingMessages.push(message);

  logEvent("TURN_EVENT_APPENDED", {
    traceId: traceId,
    turnId: message.turnId || state.currentTurnId || "",
    doName: state.doName || "",
    messageId: message.messageId || "",
    type: message.type || "",
    pendingCount: state.pendingMessages.length
  });
  logEvent("TURN_PENDING_AFTER_APPEND", {
    traceId: traceId,
    turnId: message.turnId || state.currentTurnId || "",
    doName: state.doName || "",
    pendingCount: state.pendingMessages.length
  });

  return state;
}

export function buildTurnReadiness(data, options) {
  const state = data || {};
  const now = Number(options && options.now || Date.now());
  const timing = options && options.timing || getTurnAggregationTiming(options && options.env || {});
  const messages = Array.isArray(state.pendingMessages) ? state.pendingMessages : [];
  const firstAt = Number(state.firstMessageAt || now);
  const lastAt = Number(state.lastMessageAt || firstAt);
  const text = messages.map(function (message) { return message.text || ""; }).join(" ");
  const pendingAudio = messages.filter(function (message) { return message.awaitingTranscription; });
  const hasUserDone = isUserDoneSignal(text);
  const silenceElapsed = now - lastAt >= timing.silenceMs && now - firstAt >= timing.minWaitMs;
  const maxElapsed = now - firstAt >= timing.maxWaitMs;

  if (hasUserDone) return { ready: true, reason: "user_done" };

  if (pendingAudio.length) {
    const oldestAudioAt = Math.min.apply(null, pendingAudio.map(function (message) {
      return Date.parse(message.receivedAt || "") || firstAt;
    }));
    const audioAge = now - oldestAudioAt;
    if (audioAge < timing.audioMaxWaitMs && !hasUserDone && !maxElapsed) {
      logEvent("TURN_WAITING_AUDIO_TRANSCRIPT", {
        traceId: state.currentTraceId || "",
        turnId: state.currentTurnId || "",
        doName: state.doName || "",
        pendingAudioCount: pendingAudio.length,
        waitAgeMs: audioAge
      });
      return { ready: false, reason: "waiting_audio_transcript", nextProcessAt: now + 3000 };
    }
    logEvent("TURN_AUDIO_TIMEOUT", {
      traceId: state.currentTraceId || "",
      turnId: state.currentTurnId || "",
      doName: state.doName || "",
      pendingAudioCount: pendingAudio.length,
      waitAgeMs: audioAge
    });
    return { ready: true, reason: "audio_timeout" };
  }

  if (silenceElapsed) return { ready: true, reason: "silence" };
  if (maxElapsed) return { ready: true, reason: "max_wait" };
  return { ready: false, reason: "waiting_silence", nextProcessAt: Math.min(lastAt + timing.silenceMs, firstAt + timing.maxWaitMs) };
}

export function logTurnTimerReset(data, details) {
  logEvent("TURN_TIMER_RESET", Object.assign({
    traceId: data && data.currentTraceId || "",
    turnId: data && data.currentTurnId || "",
    doName: data && data.doName || "",
    pendingCount: data && Array.isArray(data.pendingMessages) ? data.pendingMessages.length : 0
  }, details || {}));
}

export function logTurnReady(reason, data, details) {
  const event = reason === "user_done" ? "TURN_READY_BY_USER_DONE"
    : reason === "max_wait" ? "TURN_READY_BY_MAX_WAIT"
      : "TURN_READY_BY_SILENCE";
  logEvent(event, Object.assign({
    traceId: data && data.currentTraceId || "",
    turnId: data && data.currentTurnId || "",
    doName: data && data.doName || ""
  }, details || {}));
}

export function logFinalEventCounts(userTurn, data) {
  const turn = userTurn || {};
  logEvent("TURN_FINAL_EVENT_COUNTS", {
    traceId: turn.trace_id || data && data.currentTraceId || "",
    turnId: turn.turn_id || data && data.currentTurnId || "",
    doName: data && data.doName || "",
    text: turn.counts && turn.counts.text || turn.text_count || 0,
    audio: turn.counts && turn.counts.audio || turn.audio_count || 0,
    image: turn.counts && turn.counts.image || turn.image_count || 0,
    video: turn.counts && turn.counts.video || turn.video_count || 0,
    file: turn.counts && turn.counts.file || turn.file_count || 0,
    location: turn.counts && turn.counts.location || 0
  });
}

export function isUserDoneSignal(text) {
  return /\b(listo|ya|eso es todo|esas son|dale|revisa)\b/i.test(String(text || ""));
}

function numberEnv(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}
