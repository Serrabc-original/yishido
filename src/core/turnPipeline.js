import { appendProcessedMessageIds } from "./idempotencyStore.js";

export function buildProcessingLockDecision(data, options) {
  const clean = data || {};
  const now = Number(options && options.now || Date.now());
  const maxLockAgeMs = Number(options && options.maxLockAgeMs || 120000);
  const processingStartedAt = Number(clean.processingStartedAt || 0);
  const lockAgeMs = processingStartedAt ? now - processingStartedAt : 0;

  if (!clean.processing) {
    return {
      action: "continue",
      processingStartedAt: processingStartedAt,
      lockAgeMs: lockAgeMs
    };
  }

  if (processingStartedAt && lockAgeMs <= maxLockAgeMs) {
    return {
      action: "skip",
      reason: "already_processing",
      processingStartedAt: processingStartedAt,
      lockAgeMs: lockAgeMs
    };
  }

  return {
    action: "reset_stale_lock",
    reason: "stale_processing_lock",
    processingStartedAt: processingStartedAt,
    lockAgeMs: lockAgeMs
  };
}

export function buildPendingAudioDecision(messages, audioWait, options) {
  const cleanMessages = Array.isArray(messages) ? messages : [];
  const now = Number(options && options.now || Date.now());
  const pendingAudioMessages = cleanMessages.filter(function (message) {
    return message.awaitingTranscription;
  });

  if (!pendingAudioMessages.length) {
    return {
      action: "continue",
      pendingAudioMessages: [],
      pendingAudioCount: 0,
      waitAgeMs: 0,
      retryWaitMs: Number(audioWait && audioWait.retryWaitMs || 0)
    };
  }

  const oldestAudioAt = Math.min.apply(null, pendingAudioMessages.map(function (message) {
    return Date.parse(message.receivedAt || "") || now;
  }));
  const waitAgeMs = now - oldestAudioAt;
  const maxAudioTurnWaitMs = Number(audioWait && audioWait.maxAudioTurnWaitMs || 0);
  const retryWaitMs = Number(audioWait && audioWait.retryWaitMs || 0);

  if (waitAgeMs < maxAudioTurnWaitMs) {
    return {
      action: "wait",
      reason: "waiting_audio_transcription",
      pendingAudioMessages: pendingAudioMessages,
      pendingAudioCount: pendingAudioMessages.length,
      waitAgeMs: waitAgeMs,
      retryWaitMs: retryWaitMs,
      nextProcessAt: now + retryWaitMs
    };
  }

  return {
    action: "timeout",
    reason: "audio_timeout",
    pendingAudioMessages: pendingAudioMessages,
    pendingAudioCount: pendingAudioMessages.length,
    waitAgeMs: waitAgeMs,
    retryWaitMs: retryWaitMs
  };
}

export function markPendingAudioTimedOut(messages) {
  return (Array.isArray(messages) ? messages : []).map(function (message) {
    if (!message.awaitingTranscription) return message;

    return Object.assign({}, message, {
      awaitingTranscription: false,
      audioStatus: "failed",
      audioError: "AUDIO_TIMEOUT"
    });
  });
}

export function finalizeProcessedTurnState(data, messages, options) {
  const clean = Object.assign({}, data || {});
  const processedMessages = Array.isArray(messages) ? messages : [];
  const now = Number(options && options.now || Date.now());
  const activeTaskBeforeProcessing = options && options.activeTaskBeforeProcessing || null;

  clean.processedMessageIds = appendProcessedMessageIds(clean.processedMessageIds, processedMessages);
  clean.pendingMessages = (Array.isArray(clean.pendingMessages) ? clean.pendingMessages : []).filter(function (pending) {
    return !processedMessages.some(function (processed) {
      return processed.messageId === pending.messageId;
    });
  });
  clean.hasMedia = clean.pendingMessages.some(function (pending) {
    return pending.fileId || ["IMAGE", "VIDEO"].includes(pending.type || "");
  });

  if (!clean.pendingMessages.length) {
    clean.currentTurnId = "";
    clean.currentTraceId = "";
    if (activeTaskBeforeProcessing && activeTaskBeforeProcessing.status === "awaiting_media") {
      clean.campaignState = Object.assign({}, clean.campaignState || {}, {
        active_task: null,
        task_media_assets: []
      });
    }
  }

  clean.firstMessageAt = clean.pendingMessages.length ? now : 0;
  clean.lastMessageAt = clean.pendingMessages.length ? now : 0;
  clean.processAfter = 0;
  clean.updatedAt = new Date(now).toISOString();

  return clean;
}
