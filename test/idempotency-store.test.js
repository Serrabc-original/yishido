import test from "node:test";
import assert from "node:assert/strict";
import {
  appendProcessedMessageIds,
  buildSeenMessageIds,
  isDuplicateMessage,
  markMessagesProcessed
} from "../src/core/idempotencyStore.js";

test("seen message ids include processed and pending messages", () => {
  const seen = buildSeenMessageIds({
    processedMessageIds: ["processed_1"],
    pendingMessages: [{ messageId: "pending_1" }]
  });

  assert.equal(seen.has("processed_1"), true);
  assert.equal(seen.has("pending_1"), true);
  assert.equal(isDuplicateMessage({ processedMessageIds: ["processed_1"] }, "processed_1"), true);
  assert.equal(isDuplicateMessage({ pendingMessages: [{ messageId: "pending_1" }] }, "pending_1"), true);
  assert.equal(isDuplicateMessage({ processedMessageIds: ["processed_1"] }, "new_1"), false);
});

test("processed message id history keeps newest unique ids within limit", () => {
  const existing = Array.from({ length: 82 }, (_, index) => "msg_" + index);
  const result = appendProcessedMessageIds(existing, [
    { messageId: "msg_81" },
    { messageId: "msg_82" },
    { messageId: "msg_83" }
  ]);

  assert.equal(result.length, 80);
  assert.equal(result.includes("msg_0"), false);
  assert.equal(result.filter((id) => id === "msg_81").length, 1);
  assert.deepEqual(result.slice(-3), ["msg_81", "msg_82", "msg_83"]);
});

test("markMessagesProcessed updates coordinator data in place for Durable Object state", () => {
  const data = { processedMessageIds: ["old"], pendingMessages: [] };
  const result = markMessagesProcessed(data, [{ messageId: "new" }]);

  assert.equal(result, data);
  assert.deepEqual(data.processedMessageIds, ["old", "new"]);
});
