import { captureError, logEvent, redactForLog } from "../logger.js";
import { sendWoztellResponse } from "../channels/woztell/outboundAdapter.js";

const MAX_QUICK_REPLY_BUTTONS = 3;
const MAX_LIST_ROWS = 10;

export function buildWhatsAppInteractiveResponse(params) {
  const clean = normalizeInteractiveParams(params);

  if (!clean.text && !clean.fallbackText) {
    throw new Error("WHATSAPP_INTERACTIVE_TEXT_REQUIRED");
  }

  if (clean.cta && clean.cta.url && clean.cta.title) {
    return [{
      type: "CTA",
      text: clean.text,
      footer: clean.footer,
      button: {
        id: clean.cta.id || "open",
        title: clean.cta.title,
        url: clean.cta.url
      }
    }];
  }

  if (clean.buttons.length > MAX_QUICK_REPLY_BUTTONS || clean.listRows.length) {
    const rows = (clean.listRows.length ? clean.listRows : clean.buttons).slice(0, MAX_LIST_ROWS);

    return [{
      type: "LIST",
      text: clean.text,
      footer: clean.footer,
      buttonText: clean.buttonText || "Ver opciones",
      sections: [{
        title: clean.listTitle || "Opciones",
        rows: rows.map(function (item) {
          return {
            id: item.id,
            title: item.title,
            description: item.description || ""
          };
        })
      }]
    }];
  }

  if (clean.buttons.length) {
    return [{
      type: "QUICK_REPLY",
      text: clean.text,
      footer: clean.footer,
      quickReplies: clean.buttons.map(function (button) {
        return {
          id: button.id,
          title: button.title
        };
      })
    }];
  }

  return [{
    type: "TEXT",
    text: clean.text || clean.fallbackText
  }];
}

export async function sendWhatsAppInteractiveMessage(env, params, options) {
  const cleanOptions = options || {};
  const clean = normalizeInteractiveParams(params);
  const fallbackText = clean.fallbackText || clean.text || "";

  logEvent("WHATSAPP_INTERACTIVE_SEND_START", {
    traceId: clean.traceId,
    channelId: clean.channelId,
    recipientId: clean.recipientId,
    memberId: clean.memberId,
    appId: clean.appId,
    buttonCount: clean.buttons.length,
    listRowCount: clean.listRows.length,
    hasCta: Boolean(clean.cta && clean.cta.url)
  });

  if (!isInteractiveEnabled(env) && !cleanOptions.forceInteractive) {
    const fallback = await sendTextFallback(env, clean, fallbackText, cleanOptions);
    logEvent("WHATSAPP_INTERACTIVE_FALLBACK_SENT", {
      traceId: clean.traceId,
      channelId: clean.channelId,
      recipientId: clean.recipientId,
      reason: "interactive_disabled"
    });
    return Object.assign({ mode: "fallback" }, fallback);
  }

  try {
    const response = buildWhatsAppInteractiveResponse(clean);
    const payload = {
      channelId: clean.channelId,
      recipientId: clean.recipientId,
      response: response
    };
    if (clean.memberId) {
      payload.memberId = clean.memberId;
      delete payload.recipientId;
    }
    if (clean.appId) payload.appId = clean.appId;
    const result = await sendWoztellPayload(env, payload, cleanOptions);

    logEvent("WHATSAPP_INTERACTIVE_SEND_OK", {
      traceId: clean.traceId,
      channelId: clean.channelId,
      recipientId: clean.recipientId,
      responseTypes: response.map(function (item) { return item.type; })
    });

    return {
      mode: "interactive",
      payload: redactForLog(payload),
      result: result
    };
  } catch (error) {
    captureError(error, {
      stage: "sendWhatsAppInteractiveMessage",
      traceId: clean.traceId
    });
    logEvent("WHATSAPP_INTERACTIVE_SEND_FAILED", {
      traceId: clean.traceId,
      channelId: clean.channelId,
      recipientId: clean.recipientId,
      message: String(error.message || error)
    }, {
      level: "error",
      traceId: clean.traceId
    });

    const fallback = await sendTextFallback(env, clean, fallbackText, cleanOptions);
    logEvent("WHATSAPP_INTERACTIVE_FALLBACK_SENT", {
      traceId: clean.traceId,
      channelId: clean.channelId,
      recipientId: clean.recipientId,
      reason: "interactive_send_failed"
    });

    return Object.assign({ mode: "fallback_after_error" }, fallback);
  }
}

export function normalizeInteractiveParams(params) {
  const clean = params || {};
  const buttons = normalizeButtons(clean.buttons || []);
  const listRows = normalizeButtons(clean.listRows || clean.rows || []);

  return {
    channelId: String(clean.channelId || ""),
    recipientId: String(clean.recipientId || ""),
    memberId: String(clean.memberId || ""),
    appId: String(clean.appId || ""),
    traceId: String(clean.traceId || ""),
    text: String(clean.text || "").trim(),
    footer: String(clean.footer || "").trim(),
    fallbackText: String(clean.fallbackText || clean.text || "").trim(),
    buttonText: String(clean.buttonText || "").trim(),
    listTitle: String(clean.listTitle || "").trim(),
    buttons: buttons,
    listRows: listRows,
    cta: clean.cta && typeof clean.cta === "object" ? clean.cta : null
  };
}

function normalizeButtons(buttons) {
  return (Array.isArray(buttons) ? buttons : [])
    .map(function (button, index) {
      return {
        id: String(button.id || button.payload || "option_" + (index + 1)).slice(0, 64),
        title: String(button.title || button.text || "Opcion " + (index + 1)).slice(0, 24),
        description: String(button.description || "").slice(0, 72)
      };
    })
    .filter(function (button) {
      return button.id && button.title;
    });
}

function isInteractiveEnabled(env) {
  return ["true", "1", "yes", "on"].includes(String(env && env.ENABLE_WHATSAPP_INTERACTIVE || "").toLowerCase());
}

async function sendTextFallback(env, clean, fallbackText, options) {
  const payload = {
    channelId: clean.channelId,
    recipientId: clean.recipientId,
    response: [{
      type: "TEXT",
      text: fallbackText || "Elige una opcion escribiendo tu respuesta."
    }]
  };
  if (clean.memberId) {
    payload.memberId = clean.memberId;
    delete payload.recipientId;
  }
  if (clean.appId) payload.appId = clean.appId;

  const result = await sendWoztellPayload(env, payload, options || {});
  return {
    payload: redactForLog(payload),
    result: result
  };
}

async function sendWoztellPayload(env, payload, options) {
  if (options && typeof options.transport === "function") {
    return await options.transport(payload);
  }

  const result = await sendWoztellResponse(env, Object.assign({
    logPrefix: "WHATSAPP_INTERACTIVE_SEND"
  }, payload), options || {});

  if (result && result.failed) {
    throw new Error("WOZTELL_INTERACTIVE_SEND_ERROR " + (result.status || 0) + ": " + String(result.body || "send failed"));
  }

  return result;
}
