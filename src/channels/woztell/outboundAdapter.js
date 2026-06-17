import { logEvent } from "../../logger.js";
import { buildWoztellSendAttempts as buildChannelSendAttempts } from "../woztellChannelAdapter.js";

export function prepareWoztellTextResponse(params, options) {
  const clean = params || {};
  const parseReply = options && typeof options.parseCustomerReplyModelOutput === "function"
    ? options.parseCustomerReplyModelOutput
    : defaultParseCustomerReplyModelOutput;
  const parsedReply = parseReply(clean.text);
  const cleanText = fixMojibake(parsedReply.text || clean.text);

  return {
    shouldSend: Boolean(parsedReply.shouldSend !== false && cleanText.trim()),
    text: cleanText,
    parsedReply: parsedReply,
    unwrapped: parsedReply.text !== String(clean.text || "").trim() || parsedReply.shouldSend === false
  };
}

export async function sendWoztellTextMessage(env, params, options) {
  const prepared = prepareWoztellTextResponse(params, options);
  const clean = params || {};
  const logger = getLogger(options);

  if (prepared.unwrapped) {
    logger("USER_RESPONSE_JSON_UNWRAPPED", {
      textLength: prepared.text.length,
      shouldSend: prepared.parsedReply.shouldSend
    });
  }

  if (!prepared.shouldSend) {
    logger("USER_RESPONSE_BLOCKED_EMPTY", {
      channelId: clean.channelId || "",
      recipientId: clean.recipientId || ""
    });
    return { ok: true, blocked: true };
  }

  console.log("WOZTELL_TEXT_SEND_PREVIEW:", JSON.stringify({
    channelId: clean.channelId || "",
    recipientId: clean.recipientId || "",
    textPreview: prepared.text.slice(0, 1000)
  }));

  return await sendWoztellResponse(env, Object.assign({}, clean, {
    response: [
      {
        type: "TEXT",
        text: prepared.text
      }
    ]
  }), options);
}

export async function sendWoztellImageMessage(env, params, options) {
  const clean = params || {};

  return await sendWoztellResponse(env, Object.assign({}, clean, {
    logPrefix: clean.logPrefix || "WOZTELL_IMAGE_SEND",
    response: [
      {
        type: "IMAGE",
        url: clean.imageUrl
      }
    ]
  }), options);
}

export async function sendWoztellTemplateMessage(env, params, options) {
  const clean = params || {};
  const template = clean.template || {};

  if (!template.name) {
    throw new Error("REMINDER_TEMPLATE_NAME_REQUIRED");
  }

  return await sendWoztellResponse(env, Object.assign({}, clean, {
    logPrefix: clean.logPrefix || "WOZTELL_TEMPLATE_SEND",
    response: [
      {
        type: "TEMPLATE",
        templateName: template.name,
        language: template.language || "es",
        namespace: template.namespace || "",
        paramMode: template.paramMode || "body_text",
        params: [String(clean.message || "")]
      }
    ]
  }), options);
}

export async function sendWoztellResponse(env, params, options) {
  const clean = params || {};
  const tokenInfo = selectWoztellSendToken(env || {});
  const logger = getLogger(options);
  const activeContext = options && options.activeLogContext || {};

  if (!tokenInfo.token) {
    const missingResult = {
      ok: false,
      failed: true,
      status: 0,
      body: "Missing WOZTELL_ACCESS_TOKEN or WOZTELL_OPEN_API_TOKEN"
    };
    console.error("WOZTELL_SEND_FAILED:", JSON.stringify(missingResult));
    return missingResult;
  }

  const url = "https://bot.api.woztell.com/sendResponses?accessToken=" + encodeURIComponent(tokenInfo.token);
  const baseParams = Object.assign({}, clean, {
    memberId: clean.memberId || activeContext.memberId || "",
    appId: clean.appId || activeContext.appId || ""
  });
  const attempts = buildWoztellSendAttempts(baseParams);
  let parsed = null;
  let successStatus = 0;
  let lastFailure = null;

  console.log("WOZTELL_SEND_ENDPOINT:", JSON.stringify({
    endpoint: "https://bot.api.woztell.com/sendResponses",
    hasAccessTokenQuery: true
  }));
  console.log("WOZTELL_SEND_AUTH_MODE:", JSON.stringify({
    tokenType: tokenInfo.mode,
    hasWoztellAccessToken: Boolean(env && env.WOZTELL_ACCESS_TOKEN),
    hasWoztellOpenApiToken: Boolean(env && env.WOZTELL_OPEN_API_TOKEN)
  }));

  for (const attempt of attempts) {
    const payload = attempt.payload;

    logWoztellSendShape(payload, attempt.mode);

    if (clean.logPrefix === "WOZTELL_IMAGE_SEND") {
      console.log("WOZTELL_IMAGE_SEND_PAYLOAD:", JSON.stringify(redactWoztellPayloadForLog(payload)));
    }

    let res;

    try {
      res = await getFetchWithTimeout(options)(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8"
        },
        body: JSON.stringify(payload)
      }, 30000, "WOZTELL_SEND_TIMEOUT");
    } catch (error) {
      lastFailure = {
        ok: false,
        failed: true,
        mode: attempt.mode,
        status: 0,
        body: String(error.message || error).slice(0, 1000)
      };
      console.error("WOZTELL_SEND_FAILED:", JSON.stringify(lastFailure));
      continue;
    }

    const responseText = await res.text();

    if (!res.ok) {
      lastFailure = {
        ok: false,
        failed: true,
        mode: attempt.mode,
        status: res.status,
        body: responseText.slice(0, 1000)
      };
      console.error("WOZTELL_SEND_FAILED:", JSON.stringify(lastFailure));

      if (clean.logPrefix === "WOZTELL_IMAGE_SEND") {
        console.error("WOZTELL_IMAGE_SEND_ERROR:", JSON.stringify({
          status: res.status,
          body: responseText.slice(0, 2000)
        }));
      }

      if (!(attempt.mode === "recipientId" && shouldRetryWoztellWithMember(responseText, baseParams.memberId))) {
        continue;
      }

      continue;
    }

    parsed = parseMaybeJson(responseText);
    successStatus = res.status;
    break;
  }

  if (!parsed) {
    return lastFailure || { ok: false, failed: true, status: 0, body: "WOZTELL_SEND_FAILED" };
  }

  if (clean.logPrefix === "WOZTELL_IMAGE_SEND") {
    console.log("WOZTELL_IMAGE_SEND_OK:", JSON.stringify({
      status: successStatus,
      body: parsed
    }));
  }

  console.log("USER_RESPONSE_SENT:", JSON.stringify({
    channelId: clean.channelId || "",
    recipientId: clean.recipientId || "",
    responseCount: Array.isArray(clean.response) ? clean.response.length : 0,
    responseTypes: (Array.isArray(clean.response) ? clean.response : []).map(function (item) {
      return item.type || "";
    })
  }));
  logger("USER_RESPONSE_SENT", {
    traceId: clean.traceId || activeContext.traceId || "",
    turnId: clean.turnId || activeContext.turnId || "",
    doName: clean.doName || activeContext.doName || "",
    channelId: clean.channelId || "",
    recipientId: clean.recipientId || "",
    responseCount: Array.isArray(clean.response) ? clean.response.length : 0,
    responseTypes: (Array.isArray(clean.response) ? clean.response : []).map(function (item) {
      return item.type || "";
    })
  });

  return parsed;
}

export function selectWoztellSendToken(env) {
  const clean = env || {};

  if (clean.WOZTELL_ACCESS_TOKEN) {
    return {
      token: clean.WOZTELL_ACCESS_TOKEN,
      mode: "WOZTELL_ACCESS_TOKEN"
    };
  }

  if (clean.WOZTELL_OPEN_API_TOKEN) {
    return {
      token: clean.WOZTELL_OPEN_API_TOKEN,
      mode: "WOZTELL_OPEN_API_TOKEN"
    };
  }

  return {
    token: "",
    mode: "none"
  };
}

export function buildWoztellSendAttempts(params) {
  return buildChannelSendAttempts(params || {});
}

export function logWoztellSendShape(payload, mode) {
  console.log("WOZTELL_SEND_BODY_SHAPE:", JSON.stringify({
    mode: mode,
    keys: Object.keys(payload || {}),
    responseCount: Array.isArray(payload && payload.response) ? payload.response.length : 0,
    responseTypes: (Array.isArray(payload && payload.response) ? payload.response : []).map(function (item) {
      return item.type || "";
    })
  }));
  console.log("WOZTELL_SEND_CHANNEL_ID:", JSON.stringify({
    present: Boolean(payload && payload.channelId),
    valuePreview: String(payload && payload.channelId || "").slice(0, 8)
  }));
  console.log("WOZTELL_SEND_MEMBER_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload && payload.memberId)
  }));
  console.log("WOZTELL_SEND_RECIPIENT_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload && payload.recipientId)
  }));
  console.log("WOZTELL_SEND_APP_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload && payload.appId)
  }));
}

export function shouldRetryWoztellWithMember(responseText, memberId) {
  return Boolean(memberId && String(responseText || "").toLowerCase().includes("app could not be found"));
}

export function redactWoztellPayloadForLog(payload) {
  const clean = payload || {};

  return {
    channelId: clean.channelId || "",
    hasMemberId: Boolean(clean.memberId),
    hasRecipientId: Boolean(clean.recipientId),
    hasAppId: Boolean(clean.appId),
    responseCount: Array.isArray(clean.response) ? clean.response.length : 0,
    responseTypes: (Array.isArray(clean.response) ? clean.response : []).map(function (item) {
      return item.type || "";
    })
  };
}

export function fixMojibake(text) {
  if (!text) return "";

  return String(text)
    .replaceAll("\u00c3\u0192\u00c2\u00a1", "á")
    .replaceAll("\u00c3\u0192\u00c2\u00a9", "é")
    .replaceAll("\u00c3\u0192\u00c2\u00ad", "í")
    .replaceAll("\u00c3\u0192\u00c2\u00b3", "ó")
    .replaceAll("\u00c3\u0192\u00c2\u00ba", "ú")
    .replaceAll("\u00c3\u0192\u00c2\u00b1", "ñ")
    .replaceAll("\u00c3\u0192\u00c2\u0081", "Á")
    .replaceAll("\u00c3\u0192\u00e2\u20ac\u00b0", "É")
    .replaceAll("\u00c3\u0192\u00c2\u008d", "Í")
    .replaceAll("\u00c3\u0192\u00e2\u20ac\u0153", "Ó")
    .replaceAll("\u00c3\u0192\u00c5\u00a1", "Ú")
    .replaceAll("\u00c3\u0192\u00e2\u20ac\u02dc", "Ñ")
    .replaceAll("\u00c3\u201a\u00c2\u00bf", "¿")
    .replaceAll("\u00c3\u201a\u00c2\u00a1", "¡")
    .replaceAll("\u00c3\u00a2\u00c5\u201c\u00e2\u20ac\u00a6", "?")
    .replaceAll("\u00c3\u00a2\u00c5\u201c\u00e2\u20ac\u009d", "?")
    .replaceAll("\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac\u0153", "–")
    .replaceAll("\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac\u009d", "—")
    .replaceAll("\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u201e\u00a2", "’")
    .replaceAll("\u00c3\u00a2\u00e2\u201a\u00ac\u00c5\u201c", "“")
    .replaceAll("\u00c3\u00a2\u00e2\u201a\u00ac\u00c2\u009d", "”")
    .replaceAll("\u00c2\u00bf", "¿")
    .replaceAll("\u00c2\u00a1", "¡");
}

function getLogger(options) {
  return options && typeof options.logEvent === "function" ? options.logEvent : logEvent;
}

function getFetchWithTimeout(options) {
  return options && typeof options.fetchWithTimeout === "function" ? options.fetchWithTimeout : fetchWithTimeout;
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort(label || "REQUEST_TIMEOUT");
  }, timeoutMs || 30000);

  try {
    return await fetch(url, Object.assign({}, options || {}, { signal: controller.signal }));
  } finally {
    clearTimeout(timeout);
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function defaultParseCustomerReplyModelOutput(outputText) {
  return {
    shouldSend: true,
    text: String(outputText || "").trim()
  };
}
