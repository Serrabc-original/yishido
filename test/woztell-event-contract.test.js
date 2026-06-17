import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeInboundEvent, shouldIgnoreInboundEvent } from "../src/conversation/inboundEventCollector.js";
import { extractWoztellMessage, normalizeIncomingMessage } from "../src/index.js";
import {
  extractWoztellMessage as extractWoztellMessageFromAdapter,
  normalizeIncomingMessage as normalizeIncomingMessageFromAdapter,
  normalizeWoztellInboundEvent
} from "../src/channels/woztell/eventNormalizer.js";

test("Woztell contract doc covers required event and API terms", () => {
  const doc = readFileSync(new URL("../docs/WOZTELL_EVENT_CONTRACT.md", import.meta.url), "utf8");
  for (const term of [
    "TEXT",
    "IMAGE",
    "AUDIO",
    "VIDEO",
    "FILE",
    "LOCATION",
    "SENT",
    "DELIVERED",
    "READ",
    "131051",
    "sendResponses",
    "memberId",
    "recipientId",
    "conversationHistory",
    "messageId"
  ]) {
    assert.match(doc, new RegExp(term));
  }
});

test("unsupported WhatsApp 131051 is ignored and does not become empty TEXT", () => {
  const event = normalizeInboundEvent({
    eventType: "INBOUND",
    type: "",
    messageId: "bad_1",
    data: { errors: [{ code: 131051 }] }
  });
  const decision = shouldIgnoreInboundEvent(event);

  assert.equal(event.type, "UNSUPPORTED");
  assert.equal(event.text, "");
  assert.equal(decision.ignore, true);
});

test("status events are ignored", () => {
  for (const type of ["SENT", "DELIVERED", "READ"]) {
    const event = normalizeInboundEvent({ eventType: "INBOUND", type, messageId: type.toLowerCase() });
    assert.equal(event.isStatusEvent, true);
    assert.equal(shouldIgnoreInboundEvent(event).reason, "status_event");
  }
});

test("text, image, audio, video, file and location normalize with common fields", () => {
  const samples = [
    { type: "TEXT", text: "hola", messageId: "text_1" },
    { type: "IMAGE", fileId: "img_1", caption: "foto uno", messageId: "img_1" },
    { type: "AUDIO", fileId: "aud_1", messageId: "aud_1" },
    { type: "VIDEO", fileId: "vid_1", messageId: "vid_1" },
    { type: "FILE", fileId: "doc_1", messageId: "doc_1" },
    { type: "LOCATION", data: { latitude: -2.1, longitude: -79.9 }, messageId: "loc_1" }
  ];

  for (const sample of samples) {
    const event = normalizeInboundEvent(Object.assign({
      eventType: "INBOUND",
      channel: "channel_1",
      member: "member_1",
      app: "app_1",
      from: "593"
    }, sample));
    assert.equal(event.type, sample.type);
    assert.equal(event.channelId, "channel_1");
    assert.equal(event.memberId, "member_1");
    assert.equal(event.appId, "app_1");
    assert.equal(event.from, "593");
  }
});

test("extract and normalize preserve fileId and caption", () => {
  const parsed = extractWoztellMessage({
    type: "IMAGE",
    messageId: "img_1",
    fileId: "file_1",
    caption: "caption uno"
  });
  const normalized = normalizeIncomingMessage(parsed, {
    type: "IMAGE",
    app: "app_1",
    channel: "channel_1",
    from: "user_1"
  }, { messageId: "img_1" });

  assert.equal(normalized.media.length, 1);
  assert.equal(normalized.media[0].fileId, "file_1");
  assert.equal(normalized.media[0].caption, "caption uno");
  assert.deepEqual(normalized.captions, ["caption uno"]);
});

test("Woztell event normalizer exposes channel-owned normalized message contract", () => {
  const payload = {
    eventType: "INBOUND",
    type: "IMAGE",
    app: "app_1",
    channel: "channel_1",
    member: "member_1",
    from: "593",
    messageId: "msg_img_reply",
    data: {
      fileId: "file_1",
      caption: "caption reply",
      context: { messageId: "quoted_1", fileId: "quoted_file", type: "IMAGE" }
    }
  };

  const event = normalizeWoztellInboundEvent(payload, { traceId: "trace_test" });
  const parsed = extractWoztellMessageFromAdapter(payload);
  const normalized = normalizeIncomingMessageFromAdapter(parsed, payload, {
    messageId: "msg_img_reply",
    traceId: "trace_test",
    receivedAt: "2026-06-14T00:00:00.000Z"
  });

  assert.equal(event.type, "IMAGE");
  assert.equal(event.channelId, "channel_1");
  assert.equal(parsed.fileId, "file_1");
  assert.equal(normalized.messageId, "msg_img_reply");
  assert.equal(normalized.traceId, "trace_test");
  assert.equal(normalized.media.length, 1);
  assert.equal(normalized.media[0].fileId, "file_1");
  assert.equal(normalized.quotedMessageId, "quoted_1");
  assert.equal(normalized.quotedFileId, "quoted_file");
  assert.deepEqual(normalized.captions, ["caption reply"]);
});

