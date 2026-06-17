import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWoztellSendAttempts,
  prepareWoztellTextResponse,
  redactWoztellPayloadForLog,
  selectWoztellSendToken,
  sendWoztellImageMessage,
  sendWoztellTemplateMessage,
  sendWoztellTextMessage
} from "../src/channels/woztell/outboundAdapter.js";

test("Woztell outbound adapter chooses token and preserves memberId-first send payloads", () => {
  const token = selectWoztellSendToken({
    WOZTELL_ACCESS_TOKEN: "access",
    WOZTELL_OPEN_API_TOKEN: "open"
  });
  const fallbackToken = selectWoztellSendToken({ WOZTELL_OPEN_API_TOKEN: "open" });
  const attempts = buildWoztellSendAttempts({
    channelId: "channel_1",
    memberId: "member_1",
    recipientId: "593999111222",
    appId: "app_1",
    response: [{ type: "TEXT", text: "hola" }]
  });

  assert.equal(token.mode, "WOZTELL_ACCESS_TOKEN");
  assert.equal(fallbackToken.mode, "WOZTELL_OPEN_API_TOKEN");
  assert.equal(attempts[0].mode, "memberId");
  assert.equal(attempts[0].payload.memberId, "member_1");
  assert.equal(Object.hasOwn(attempts[0].payload, "recipientId"), false);
});

test("Woztell text adapter unwraps customer reply JSON and blocks empty responses", () => {
  const prepared = prepareWoztellTextResponse({
    text: "{\"shouldSend\":true,\"text\":\"Listo\"}"
  }, {
    parseCustomerReplyModelOutput(output) {
      return JSON.parse(output);
    }
  });
  const blocked = prepareWoztellTextResponse({
    text: "{\"shouldSend\":false,\"text\":\"\"}"
  }, {
    parseCustomerReplyModelOutput(output) {
      return JSON.parse(output);
    }
  });

  assert.equal(prepared.shouldSend, true);
  assert.equal(prepared.text, "Listo");
  assert.equal(prepared.unwrapped, true);
  assert.equal(blocked.shouldSend, false);
});

test("Woztell outbound adapter sends text, image and template through sendResponses", async () => {
  const calls = [];
  const fetchWithTimeout = async function (url, options) {
    calls.push({ url, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      async text() {
        return "{\"ok\":true}";
      }
    };
  };
  const options = {
    fetchWithTimeout: fetchWithTimeout,
    logEvent() {},
    parseCustomerReplyModelOutput(text) {
      return { shouldSend: true, text: String(text || "").trim() };
    }
  };
  const env = { WOZTELL_ACCESS_TOKEN: "token" };

  await sendWoztellTextMessage(env, {
    channelId: "channel_1",
    memberId: "member_1",
    text: "Hola"
  }, options);
  await sendWoztellImageMessage(env, {
    channelId: "channel_1",
    memberId: "member_1",
    imageUrl: "https://cdn.test/image.jpg"
  }, options);
  await sendWoztellTemplateMessage(env, {
    channelId: "channel_1",
    memberId: "member_1",
    template: { name: "reminder_due", language: "es" },
    message: "Comprar leche"
  }, options);

  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /sendResponses\?accessToken=/);
  assert.equal(calls[0].body.response[0].type, "TEXT");
  assert.equal(calls[1].body.response[0].type, "IMAGE");
  assert.equal(calls[2].body.response[0].type, "TEMPLATE");
  assert.deepEqual(redactWoztellPayloadForLog(calls[0].body).responseTypes, ["TEXT"]);
});
