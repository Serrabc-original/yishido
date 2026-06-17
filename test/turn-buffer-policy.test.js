import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAppendProcessTiming,
  getBufferTimingConfig,
  hasOpenPendingTurn,
  shouldHoldMediaTurnForMoreEvents
} from "../src/core/turnBufferPolicy.js";

test("buffer timing keeps Cloudflare turn aggregation defaults configurable", () => {
  const timing = getBufferTimingConfig({
    TURN_MIN_WAIT_MS: "2000",
    TURN_SILENCE_MS: "9000",
    TURN_MAX_WAIT_MS: "50000"
  });

  assert.equal(timing.bufferWaitSeconds, 2);
  assert.equal(timing.imageMessageWaitSeconds, 9);
  assert.equal(timing.bufferMaxWaitSeconds, 50);
});

test("open pending turn respects max wait window", () => {
  const data = {
    currentTurnId: "turn_1",
    pendingMessages: [{ messageId: "m1" }],
    firstMessageAt: 1000
  };

  assert.equal(hasOpenPendingTurn(data, 2000, { TURN_MAX_WAIT_MS: "5000" }), true);
  assert.equal(hasOpenPendingTurn(data, 7001, { TURN_MAX_WAIT_MS: "5000" }), false);
});

test("media-only turn is held but clear text or done signal releases it", () => {
  const data = { firstMessageAt: 1000 };
  const env = { TURN_MAX_WAIT_MS: "45000" };

  const hold = shouldHoldMediaTurnForMoreEvents(data, [
    { type: "IMAGE", fileId: "img_1", text: "[IMAGE uploaded without caption]" }
  ], env, { now: 2000 });
  const clearText = shouldHoldMediaTurnForMoreEvents(data, [
    { type: "IMAGE", fileId: "img_1", text: "[IMAGE uploaded without caption]" },
    { type: "TEXT", text: "Que tal este producto?" }
  ], env, { now: 2000 });
  const done = shouldHoldMediaTurnForMoreEvents(data, [
    { type: "IMAGE", fileId: "img_1", text: "[IMAGE uploaded without caption]" },
    { type: "TEXT", text: "listo" }
  ], env, { now: 2000 });

  assert.equal(hold.hold, true);
  assert.equal(hold.nextProcessAt, 46000);
  assert.equal(clearText.hold, false);
  assert.equal(done.hold, false);
});

test("append process timing applies media, task, hold and done precedence", () => {
  const data = { firstMessageAt: 1000, lastMessageAt: 3000 };
  const timing = { bufferWaitSeconds: 2, imageMessageWaitSeconds: 8, bufferMaxWaitSeconds: 45 };
  const media = buildAppendProcessTiming({ data, timing, hasMedia: true, now: 3000 });
  const task = buildAppendProcessTiming({
    data,
    timing,
    hasMedia: true,
    activeTask: { status: "awaiting_media" },
    taskDecision: { nextProcessAt: 20000 },
    now: 3000
  });
  const hold = buildAppendProcessTiming({
    data,
    timing,
    hasMedia: true,
    mediaHold: { hold: true, nextProcessAt: 46000 },
    now: 3000
  });
  const done = buildAppendProcessTiming({
    data,
    timing,
    hasMedia: true,
    mediaHold: { hold: true, nextProcessAt: 46000 },
    userDone: true,
    existingOpen: true,
    now: 3000
  });

  assert.equal(media.processAfter, 11000);
  assert.equal(task.processAfter, 20000);
  assert.equal(hold.processAfter, 46000);
  assert.equal(done.processAfter, 3000);
});
