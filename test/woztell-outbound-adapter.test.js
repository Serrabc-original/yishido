import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWoztellSendAttempts,
  prepareWoztellTextResponse,
  redactIdForConsole,
  redactWoztellPayloadForLog,
  selectWoztellSendToken,
  selectWoztellSendTokens,
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
  assert.deepEqual(selectWoztellSendTokens({
    WOZTELL_ACCESS_TOKEN: "access",
    WOZTELL_OPEN_API_TOKEN: "open"
  }).map(function (item) { return item.mode; }), ["WOZTELL_ACCESS_TOKEN", "WOZTELL_OPEN_API_TOKEN"]);
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

test("Woztell outbound adapter retries open api token when access token send fails", async () => {
  const calls = [];
  const failures = [];
  const result = await sendWoztellTextMessage({
    WOZTELL_ACCESS_TOKEN: "expired-access",
    WOZTELL_OPEN_API_TOKEN: "working-open"
  }, {
    channelId: "channel_1",
    memberId: "member_1",
    appId: "app_1",
    text: "Hola"
  }, {
    fetchWithTimeout: async function (url, options) {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.includes("expired-access")) {
        return {
          ok: false,
          status: 401,
          async text() {
            return "{\"error\":\"invalid token\"}";
          }
        };
      }
      return {
        ok: true,
        status: 200,
        async text() {
          return "{\"ok\":true}";
        }
      };
    },
    logEvent(event, details) {
      if (event === "WOZTELL_SEND_FAILED") failures.push(details);
    },
    parseCustomerReplyModelOutput(text) {
      return { shouldSend: true, text: String(text || "").trim() };
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.includes("expired-access"), true);
  assert.equal(calls[1].url.includes("working-open"), true);
  assert.equal(result.ok, true);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].tokenType, "WOZTELL_ACCESS_TOKEN");
  assert.equal(failures[0].status, 401);
});

test("Woztell text adapter does not print raw recipient or message text in console logs", async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = function () {
    logs.push(Array.from(arguments).join(" "));
  };

  try {
    await sendWoztellTextMessage({
      WOZTELL_ACCESS_TOKEN: "token"
    }, {
      channelId: "channel_private",
      recipientId: "593999111222",
      text: "mensaje privado del cliente"
    }, {
      fetchWithTimeout: async function () {
        return {
          ok: true,
          status: 200,
          async text() {
            return "{\"ok\":true}";
          }
        };
      },
      logEvent() {},
      parseCustomerReplyModelOutput(text) {
        return { shouldSend: true, text: String(text || "").trim() };
      }
    });
  } finally {
    console.log = originalLog;
  }

  const joined = logs.join("\n");
  assert.equal(joined.includes("593999111222"), false);
  assert.equal(joined.includes("mensaje privado del cliente"), false);
  assert.equal(joined.includes(redactIdForConsole("593999111222")), true);
});
