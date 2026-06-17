import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPendingAudioDecision,
  buildProcessingLockDecision,
  finalizeProcessedTurnState,
  markPendingAudioTimedOut
} from "../src/core/turnPipeline.js";

test("turn pipeline lock decision skips active locks and resets stale locks", () => {
  const active = buildProcessingLockDecision({
    processing: true,
    processingStartedAt: 1000
  }, {
    now: 2000,
    maxLockAgeMs: 5000
  });
  const stale = buildProcessingLockDecision({
    processing: true,
    processingStartedAt: 1000
  }, {
    now: 7001,
    maxLockAgeMs: 5000
  });

  assert.equal(active.action, "skip");
  assert.equal(active.reason, "already_processing");
  assert.equal(stale.action, "reset_stale_lock");
});

test("turn pipeline audio decision waits, then times out pending transcriptions", () => {
  const receivedAt = new Date(1000).toISOString();
  const wait = buildPendingAudioDecision([
    { messageId: "aud_1", awaitingTranscription: true, receivedAt: receivedAt }
  ], {
    maxAudioTurnWaitMs: 5000,
    retryWaitMs: 1000
  }, {
    now: 3000
  });
  const timeout = buildPendingAudioDecision([
    { messageId: "aud_1", awaitingTranscription: true, receivedAt: receivedAt }
  ], {
    maxAudioTurnWaitMs: 5000,
    retryWaitMs: 1000
  }, {
    now: 7000
  });
  const timedOutMessages = markPendingAudioTimedOut([
    { messageId: "aud_1", awaitingTranscription: true },
    { messageId: "txt_1", awaitingTranscription: false }
  ]);

  assert.equal(wait.action, "wait");
  assert.equal(wait.nextProcessAt, 4000);
  assert.equal(timeout.action, "timeout");
  assert.equal(timedOutMessages[0].audioError, "AUDIO_TIMEOUT");
  assert.equal(timedOutMessages[1].audioError, undefined);
});

test("turn pipeline finalizes processed messages without dropping later pending messages", () => {
  const data = {
    processedMessageIds: ["old"],
    pendingMessages: [
      { messageId: "m1", type: "TEXT" },
      { messageId: "m2", type: "IMAGE", fileId: "img_2" }
    ],
    currentTurnId: "turn_1",
    currentTraceId: "trace_1",
    campaignState: {
      active_task: { status: "awaiting_media" },
      task_media_assets: [{ file_id: "img_1" }]
    }
  };
  const finalized = finalizeProcessedTurnState(data, [{ messageId: "m1" }], {
    now: 5000,
    activeTaskBeforeProcessing: { status: "awaiting_media" }
  });
  const finished = finalizeProcessedTurnState(data, [{ messageId: "m1" }, { messageId: "m2" }], {
    now: 5000,
    activeTaskBeforeProcessing: { status: "awaiting_media" }
  });

  assert.deepEqual(finalized.processedMessageIds, ["old", "m1"]);
  assert.equal(finalized.pendingMessages.length, 1);
  assert.equal(finalized.hasMedia, true);
  assert.equal(finalized.currentTurnId, "turn_1");
  assert.equal(finished.pendingMessages.length, 0);
  assert.equal(finished.currentTurnId, "");
  assert.equal(finished.campaignState.active_task, null);
});
