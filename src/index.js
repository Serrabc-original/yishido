// VERSION: whatsapp-ai-agent-core-v3
// DATE: 2026-06-13
//
// REQUIRED BINDINGS:
// - Durable Object: CONVERSATION_DO -> ConversationCoordinator
// - Queue: IMAGE_QUEUE
// - Queue: AUDIO_QUEUE
// - KV: SESSIONS_KV
// - R2: IMAGES_BUCKET
//
// REQUIRED SECRETS / VARIABLES:
// - WOZTELL_ACCESS_TOKEN
// - WOZTELL_OPEN_API_TOKEN
// - ANTHROPIC_API_KEY
// - CLAUDE_ORCHESTRATOR_AGENT_ID
// - CLAUDE_ORCHESTRATOR_ENVIRONMENT_ID
// - OPENAI_API_KEY
// - COPY_MODEL = gpt-5.4-nano
// - OPENAI_IMAGE_MODEL = gpt-image-2
// - R2_PUBLIC_BASE_URL
// - GOOGLE_SHEETS_WEBHOOK_URL
// - GOOGLE_SHEETS_SECRET
//
// OPTIONAL:
// - BUFFER_WAIT_SECONDS = 5
// - IMAGE_MESSAGE_WAIT_SECONDS = 8
// - BUFFER_MAX_WAIT_SECONDS = 15
import { captureError, createTraceId, logEvent } from "./logger.js";
import { normalizeInboundEvent, normalizeEventType, shouldIgnoreInboundEvent } from "./conversation/inboundEventCollector.js";
import {
  appendPendingEvent,
  getTurnAggregationTiming,
  isUserDoneSignal,
  logFinalEventCounts,
  logTurnReady,
  logTurnTimerReset
} from "./conversation/turnAggregator.js";
import { attachUserTurnContract, buildCombinedUserText, cleanUserVisibleText } from "./conversation/userTurnBuilder.js";
import { buildMediaBatchFromUserTurn } from "./conversation/mediaBatchBuilder.js";
import { getCoreFeatureFlags, updateConversationMemory } from "./conversationMemory.js";
import { routeCoreUtilityIntent } from "./coreUtilityRouter.js";
import { createReminder, listReminders, selectReminderDeliveryPath } from "./modules/reminders/index.js";
import { addListItems, createList, listItems, markListItemDone, normalizeListState, removeListItems } from "./modules/lists/index.js";
import { sendWhatsAppInteractiveMessage } from "./whatsapp/sendInteractiveMessage.js";
import { buildRequestContext, buildSupervisorInput } from "./context/requestContextManager.js";
import {
  buildWoztellConversationIdentity,
  buildWoztellEventSummary,
  buildWoztellSendAttempts as buildAdapterWoztellSendAttempts,
  normalizeWoztellMessageEventMeta
} from "./channels/woztellChannelAdapter.js";
import {
  createConversationSupervisorPlan,
  generateFinalUserResponse,
  getRecentConversationWindow,
  getSupervisorConfig
} from "./supervisor/conversationSupervisor.js";
import {
  buildFastAckText,
  composeFinalResponse,
  composeGeneralTextAnswer,
  shouldSendFastAck,
  splitConversationalText,
  validateSpecialistOutputAgainstIntent
} from "./ai/finalResponseComposer.js";
import { buildCustomerReplyPromptPayload, composeCustomerReply } from "./ai/customerReplyComposer.js";
import { getConversationPromptGuidance } from "./ai/conversationStyleProfile.js";
import {
  getCustomerReplyModel,
  getFinalResponseModel,
  getImageGenerationModel,
  getRouterModel,
  getSpecialistModel,
  getTranscriptionModel,
  getVisionModel
} from "./ai/modelRegistry.js";

let activeLogContext = {};

const USER_MESSAGES = {
  draftReady: "Te preparé esta propuesta. ¿La apruebas o quieres que haga cambios?",
  approvedAskPublish: "Perfecto, quedó aprobado ?\n¿Quieres dejarlo listo para publicar ahora o prefieres seguir haciendo cambios?",
  readyToPublish: "Listo, lo dejé marcado como listo para publicar ?\nAún no se publica automáticamente; ese será el siguiente paso cuando conectemos Meta.",
  imageReady: "Listo, te generé esta imagen.\n\n¿Quieres que haga otra versión o ajustamos el texto?",
  audioFailed: "Tuve un problema procesando tu audio. ¿Me lo puedes reenviar o escribirlo en texto?",
  resetOk: "Limpié el contexto actual. Tus listas guardadas se mantienen. Si quieres borrar listas, usa /forget-lists.",
  help: "Puedo ayudarte como asistente general: responder preguntas, crear y actualizar listas, preparar recordatorios, leer imagenes, extraer texto de fotos, entender audios transcritos, apoyar pedidos, soporte, CRM ligero y marketing solo cuando me lo pidas explicitamente.",
  clearMediaOk: "Listo, limpié las imagenes y archivos previos sin borrar tus listas ni recordatorios.",
  requestFailed: "Tuve un problema procesando tu solicitud. Intenta nuevamente en unos minutos.",
  uploadedImageMissing: "No pude encontrar la imagen subida. ¿Puedes reenviarla o describirme brevemente qué aparece en la imagen?",
  imageAnalysisFailed: "No pude leer bien la imagen. ¿Me puedes describir el producto o reenviarla con una breve descripción?",
  uploadedImageClarification: "Recibi la imagen. Dime si quieres que la analice, lea texto visible, la compare con otra o la use para algo puntual.",
  changesAck: "Perfecto, hago los ajustes y te envío una nueva versión.",
  imageGenerationAck: "Perfecto. Voy a generar la imagen y te la envío apenas esté lista.",
  imageRevisionAck: "Listo. Voy a preparar una nueva versión de la imagen con ese cambio.",
  imageProcessing: "La imagen queda en proceso. Te la envío por aquí apenas esté lista.",
  genericClarification: "Entendido. ¿Qué necesitas que haga con esto?",
  imageFailed: "Tuve un problema al generar o enviar la imagen. ¿Quieres que lo intente nuevamente?",
  imageQueueFallback: "Tuve un problema generando la imagen. Puedes intentar de nuevo con una descripción más específica.",
  assetsCollected: "Ya recibí {count} imagenes. ¿Quieres que las analice, extraiga texto, las compare o las convierta en una lista?",
  calendarReady: "Te preparé un calendario de contenido. ¿Lo apruebas completo o quieres cambiar algún post?",
  bulkPostsReady: "Listo, generé los posts del calendario. Puedes aprobar todos, cambiar un número específico o dejarlos listos para publicar.",
  bulkApproved: "Perfecto, aprobé los posts seleccionados ?\n¿Quieres dejarlos listos para publicar?",
  bulkReadyToPublish: "Listo, los posts seleccionados quedaron como ready_to_publish y scheduled_pending_meta ?"
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      if (url.pathname === "/version") {
        return jsonResponse(buildVersionDiagnostic(env));
      }

      return jsonResponse(buildVersionDiagnostic(env));
    }

    if (request.method !== "POST") {
      return jsonResponse({ status: "error", message: "Method not allowed" }, 405);
    }

    let body;

    try {
      body = await request.json();
    } catch (error) {
      captureError(error, { route: "fetch", stage: "request_json_parse" });
      console.error("JSON_PARSE_ERROR:", String(error.message || error));
      return jsonResponse({ status: "error", message: "Invalid JSON" }, 400);
    }

    logEvent("WOZTELL_WEBHOOK_SUMMARY", buildWoztellEventSummary(body));

    if (body.eventType && body.eventType !== "INBOUND") {
      return jsonResponse({
        status: "ignored",
        reason: "Not inbound",
        eventType: body.eventType
      });
    }

    const preliminaryTraceId = createTraceId([
      body.channel || "",
      body.from || "",
      body.messageId || ""
    ]);
    const inboundEvent = normalizeInboundEvent(body, { traceId: preliminaryTraceId });
    const ignoreInbound = shouldIgnoreInboundEvent(inboundEvent, [], { traceId: preliminaryTraceId });

    if (ignoreInbound.ignore) {
      console.log("WOZTELL_STATUS_EVENT_IGNORED:", inboundEvent.rawType || inboundEvent.type);
      return jsonResponse({
        status: "ignored",
        reason: ignoreInbound.reason,
        type: inboundEvent.rawType || inboundEvent.type
      });
    }

    let parsedMessage = extractWoztellMessage(body);
    const webhookTraceId = createTraceId([
      body.channel || "",
      body.from || "",
      body.messageId || parsedMessage.messageId || ""
    ]);

    logEvent("WEBHOOK_RECEIVED", {
      traceId: webhookTraceId,
      eventType: body.eventType || "",
      type: body.type || "",
      channel: body.channel || "",
      from: body.from || "",
      messageId: body.messageId || parsedMessage.messageId || "",
      hasText: Boolean(parsedMessage.text),
      hasFileId: Boolean(parsedMessage.fileId)
    });

    console.log("WZ_PARSED_MESSAGE:", JSON.stringify({
      type: parsedMessage.type,
      text: parsedMessage.text || "",
      fileId: parsedMessage.fileId || "",
      messageId: body.messageId || parsedMessage.messageId || ""
    }));

    logEvent("MESSAGE_NORMALIZED", {
      traceId: webhookTraceId,
      type: parsedMessage.type || "",
      messageId: body.messageId || parsedMessage.messageId || "",
      hasText: Boolean(parsedMessage.text),
      hasFileId: Boolean(parsedMessage.fileId)
    });

    if (!parsedMessage.text && !parsedMessage.fileId) {
      return jsonResponse({
        status: "ignored",
        reason: "No text or file found"
      });
    }

    if (isAudioMessage(parsedMessage)) {
      logEvent("AUDIO_RECEIVED", {
        traceId: webhookTraceId,
        type: parsedMessage.type || "",
        mimeType: parsedMessage.mimeType || "",
        hasFileId: Boolean(parsedMessage.fileId),
        messageId: body.messageId || parsedMessage.messageId || ""
      });

      console.log("AUDIO_RECEIVED:", JSON.stringify({
        type: parsedMessage.type || "",
        mimeType: parsedMessage.mimeType || "",
        hasFileId: Boolean(parsedMessage.fileId),
        caption: parsedMessage.text || ""
      }));

      if (!parsedMessage.fileId) {
        console.error("AUDIO_FILE_ID_MISSING");

        ctx.waitUntil(sendAudioUserFallback(env, {
          channel: body.channel,
          from: body.from
        }));

        console.log("AUDIO_EVENT_ACKED_FAST:", JSON.stringify({
          status: "missing_file_id",
          messageId: body.messageId || parsedMessage.messageId || ""
        }));

        return jsonResponse({
          status: "audio_accepted_missing_file_id"
        });
      }

      console.log("AUDIO_FILE_ID_EXTRACTED:", parsedMessage.fileId);

      const doName = buildConversationName(body);

      if (!env.CONVERSATION_DO) {
        return jsonResponse({
          status: "error",
          message: "CONVERSATION_DO binding is missing"
        }, 500);
      }

      const id = env.CONVERSATION_DO.idFromName(doName);
      const stub = env.CONVERSATION_DO.get(id);

      await stub.fetch("https://conversation.local/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "woztell_message",
          doName: doName,
          payload: body,
          parsedMessage: parsedMessage,
          traceId: webhookTraceId
        })
      });

      await enqueueAudioJob(env, ctx, {
        type: "transcribe_audio",
        doName: doName,
        phone: body.from || "",
        channel: body.channel || "",
        messageId: parsedMessage.messageId || body.messageId || randomId(12),
        fileId: parsedMessage.fileId,
        app: body.app || "",
        member: body.member || "",
        woztellPayload: body,
        parsedMessage: parsedMessage,
        traceId: webhookTraceId
      });

      console.log("AUDIO_EVENT_ACKED_FAST:", JSON.stringify({
        doName: doName,
        messageId: parsedMessage.messageId || body.messageId || "",
        fileId: parsedMessage.fileId
      }));

      return jsonResponse({
        status: "audio_accepted",
        routed_to: env.AUDIO_QUEUE ? "AUDIO_QUEUE" : "waitUntil",
        doName: doName
      });
    }
    if (!env.CONVERSATION_DO) {
      return jsonResponse({
        status: "error",
        message: "CONVERSATION_DO binding is missing"
      }, 500);
    }

    const doName = buildConversationName(body);
    const id = env.CONVERSATION_DO.idFromName(doName);
    const stub = env.CONVERSATION_DO.get(id);

    const doResponse = await stub.fetch("https://conversation.local/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "woztell_message",
        doName: doName,
        payload: body,
        parsedMessage: parsedMessage,
        traceId: webhookTraceId
      })
    });

    const doText = await doResponse.text();

    let doData = {};
    try {
      doData = doText ? JSON.parse(doText) : {};
    } catch (error) {
      doData = { raw: doText };
    }

    return jsonResponse({
      status: "accepted",
      routed_to: "ConversationCoordinator",
      doName: doName,
      coordinator: doData
    });
  },

  async queue(batch, env, ctx) {
    console.log("QUEUE_BATCH_RECEIVED:", JSON.stringify({ count: batch.messages.length }));

    for (const message of batch.messages) {
      try {
        const job = message.body || {};

        console.log("QUEUE_JOB_RECEIVED:", JSON.stringify({
          type: job.type || "",
          doName: job.doName || "",
          phone: job.woztellPayload && job.woztellPayload.from || ""
        }));

        if (job.type === "transcribe_audio") {
          logEvent("AUDIO_JOB_RECEIVED", {
            traceId: job.traceId || "",
            doName: job.doName || "",
            messageId: job.messageId || "",
            fileId: job.fileId || ""
          });
        }

        if (job.type === "generate_image" || job.type === "edit_image") {
          await processImageQueueJob(env, job);
        } else if (job.type === "transcribe_audio") {
          await processAudioQueueJob(env, job);
        } else {
          console.log("QUEUE_JOB_IGNORED:", JSON.stringify(job));
        }

        message.ack();
      } catch (error) {
        captureError(error, { route: "queue", stage: "queue_job", traceId: message.body && message.body.traceId || "" });
        console.error("QUEUE_JOB_ERROR:", String(error.message || error));

        try {
          const job = message.body || {};
          const woztellPayload = job.woztellPayload || {};

          if (job.type === "transcribe_audio") {
            await notifyConversationDO(env, job.doName || buildConversationName(woztellPayload), {
              type: "audio_failed",
              messageId: job.messageId || "",
              fileId: job.fileId || "",
              error: String(error.message || error),
              failedAt: new Date().toISOString()
            });
          } else if (woztellPayload.channel && woztellPayload.from && job.type !== "generate_image" && job.type !== "edit_image") {
            await sendWoztellTextMessage(env, {
              channelId: woztellPayload.channel,
              recipientId: woztellPayload.from,
              text: USER_MESSAGES.imageQueueFallback
            });
          }
        } catch (sendError) {
          console.error("QUEUE_ERROR_FALLBACK_SEND_FAILED:", String(sendError.message || sendError));
        }

        message.ack();
      }
    }
  }
};

export class ConversationCoordinator {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.storageLock = Promise.resolve();
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const data = await this.getData();
      return jsonResponse({
        status: "ok",
        class: "ConversationCoordinator",
        pendingCount: data.pendingMessages.length,
        processing: data.processing,
        clientProfile: data.clientProfile,
        campaignState: data.campaignState,
        conversationSummary: data.conversationSummary,
        userStyleProfile: data.userStyleProfile,
        customerMemory: data.customerMemory,
        conversationLogCount: data.conversationLog.length
      });
    }

    if (url.pathname === "/message" && request.method === "POST") {
      const body = await request.json();
      return await this.receiveMessage(body);
    }

    if (url.pathname === "/tool-result" && request.method === "POST") {
      const body = await request.json();
      return await this.receiveToolResult(body);
    }

    return jsonResponse({ status: "error", message: "Not found" }, 404);
  }

  async alarm() {
    let data = await this.getData();
    const now = Date.now();
    const dueReminderResult = await this.processDueReminders(data, now);
    data = dueReminderResult.data;

    if (data.processing) {
      const processingStartedAt = Number(data.processingStartedAt || 0);
      const lockAgeMs = processingStartedAt ? now - processingStartedAt : 0;

      console.log("DO_ALARM_SKIPPED_PROCESSING:", JSON.stringify({
        doName: data.doName || "",
        reason: "already_processing",
        pendingCount: data.pendingMessages.length,
        processing: data.processing,
        processingStartedAt: data.processingStartedAt || null,
        now: now,
        processAfter: data.processAfter || 0,
        firstMessageAt: data.firstMessageAt || 0,
        lastMessageAt: data.lastMessageAt || 0,
        lockAgeMs: lockAgeMs
      }));

      if (!processingStartedAt || lockAgeMs > 120000) {
        console.log("STALE_PROCESSING_LOCK_RESET:", JSON.stringify({
          doName: data.doName || "",
          processingStartedAt: data.processingStartedAt,
          now: now,
          lockAgeMs: lockAgeMs,
          pendingCount: data.pendingMessages.length
        }));

        data.processing = false;
        data.processingStartedAt = null;
        await this.saveData(data);

        if (data.pendingMessages.length && (!data.processAfter || now >= data.processAfter)) {
          await this.processBuffer();
          return;
        }
      }

      await this.scheduleNextAlarm(data, 5);
      return;
    }

    if (!data.pendingMessages.length) {
      console.log("DO_ALARM_SKIPPED_PROCESSING:", JSON.stringify({
        doName: data.doName || "",
        reason: dueReminderResult.handled ? "reminders_processed_no_pending" : "no_pending",
        pendingCount: 0,
        processing: data.processing,
        processingStartedAt: data.processingStartedAt || null,
        now: now,
        processAfter: data.processAfter || 0,
        firstMessageAt: data.firstMessageAt || 0,
        lastMessageAt: data.lastMessageAt || 0
      }));
      await this.saveData(data);
      await this.scheduleNextReminderAlarm(data);
      return;
    }

    if (data.processAfter && now < data.processAfter) {
      console.log("DO_ALARM_SKIPPED_PROCESSING:", JSON.stringify({
        doName: data.doName || "",
        reason: "too_early",
        pendingCount: data.pendingMessages.length,
        processing: data.processing,
        processingStartedAt: data.processingStartedAt || null,
        now: now,
        processAfter: data.processAfter,
        firstMessageAt: data.firstMessageAt || 0,
        lastMessageAt: data.lastMessageAt || 0
      }));
      console.log("BUFFER_WAIT_REASON:", JSON.stringify({
        doName: data.doName || "",
        reason: "too_early",
        waitMsRemaining: data.processAfter - now
      }));
      await this.state.storage.setAlarm(data.processAfter);
      return;
    }

    console.log("DO_ALARM_PROCESSING_NOW:", JSON.stringify({
      doName: data.doName || "",
      pendingCount: data.pendingMessages.length,
      now: now,
      processAfter: data.processAfter || 0
    }));

    await this.processBuffer();
  }

  async receiveMessage(body) {
    let data = await this.getData();
    const woztellPayload = body.payload || {};
    const parsedMessage = body.parsedMessage || extractWoztellMessage(woztellPayload);
    const messageId = parsedMessage.messageId || woztellPayload.messageId || randomId(12);
    const now = Date.now();
    const incomingTraceId = body.traceId || "";
    const inboundEvent = normalizeInboundEvent(woztellPayload, { traceId: incomingTraceId });

    data.doName = body.doName || data.doName || buildConversationName(woztellPayload);
    data.channel = woztellPayload.channel || data.channel || "";
    data.phone = woztellPayload.from || data.phone || "";
    data.member = woztellPayload.member || data.member || "";
    data.app = woztellPayload.app || data.app || "";
    data.channelIdentity = buildWoztellConversationIdentity(woztellPayload);
    data.messageEventMeta = normalizeWoztellMessageEventMeta(woztellPayload);
    data.lastInboundAt = data.messageEventMeta.lastInboundAt;

    console.log("CLIENT_PROFILE_LOADED:", JSON.stringify({
      doName: data.doName,
      phone: data.phone,
      hasName: Boolean(data.clientProfile.name),
      knownPreferences: Object.keys(data.clientProfile.preferences || {}).length
    }));

    console.log("CAMPAIGN_STATE_LOADED:", JSON.stringify({
      campaignId: data.campaignState.campaign_id,
      activeTopic: data.campaignState.active_topic,
      workflowStatus: data.campaignState.workflow_status,
      expectedNextTarget: data.campaignState.expected_next_target,
      hasLastCopy: Boolean(data.campaignState.last_copy),
      hasLastImageUrl: Boolean(data.campaignState.last_image_url)
    }));

    const seenMessageIds = new Set([].concat(data.processedMessageIds || []).concat((data.pendingMessages || []).map(function (msg) {
      return msg.messageId;
    })));
    const ignoreInbound = shouldIgnoreInboundEvent(inboundEvent, seenMessageIds, { traceId: incomingTraceId });
    if (ignoreInbound.ignore) {
      if (inboundEvent && inboundEvent.isUnsupported && String(inboundEvent.errorCode || "") === "131051") {
        logEvent("UNSUPPORTED_MEDIA_CONTAINER_IGNORED", {
          traceId: incomingTraceId,
          doName: data.doName,
          messageId: inboundEvent.messageId || "",
          errorCode: inboundEvent.errorCode || ""
        });
        logEvent("UNSUPPORTED_MEDIA_CONTAINER_BATCH_HINT", {
          traceId: incomingTraceId,
          doName: data.doName,
          messageId: inboundEvent.messageId || "",
          hintWindowMs: getTurnAggregationTiming(this.env || {}).minWaitMs
        });
      }
      return jsonResponse({ status: "ignored", reason: ignoreInbound.reason, messageId: messageId });
    }

    if (data.processedMessageIds.includes(messageId) || data.pendingMessages.some(function (msg) {
      return msg.messageId === messageId;
    })) {
      console.log("DO_DUPLICATE_MESSAGE_IGNORED:", messageId);
      logEvent("INBOUND_EVENT_DEDUPED", {
        traceId: incomingTraceId,
        messageId: messageId,
        type: parsedMessage.type || ""
      });
      return jsonResponse({ status: "duplicate_ignored", messageId: messageId });
    }

    let normalized = normalizeIncomingMessage(parsedMessage, woztellPayload, {
      messageId: messageId,
      receivedAt: new Date(now).toISOString()
    });

    if (normalizeTextForIntent(normalized.text) === "/version") {
      const versionDiagnostic = buildVersionDiagnostic(this.env);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatVersionDiagnosticForWhatsApp(versionDiagnostic)
      });

      return jsonResponse({
        status: "version_sent",
        version: versionDiagnostic
      });
    }

    if (normalizeTextForIntent(normalized.text) === "/debug-openai") {
      const diagnostic = await runOpenAIDebugCheck(this.env, {
        traceId: incomingTraceId || data.currentTraceId || "",
        doName: data.doName
      });

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatOpenAIDebugForWhatsApp(diagnostic)
      });

      return jsonResponse({
        status: "debug_openai_sent",
        ok: diagnostic.ok,
        diagnostic: diagnostic
      });
    }

    if (normalizeTextForIntent(normalized.text) === "/debug-interactive") {
      const result = await this.sendInteractiveOrText(data, {
        traceId: incomingTraceId || data.currentTraceId || "",
        text: "Prueba interactiva segura. Elige una opcion:",
        fallbackText: "Prueba interactiva segura. Responde: Confirmar, Cambiar hora o Cancelar.",
        buttons: [
          { id: "debug_confirm", title: "Confirmar" },
          { id: "debug_change_time", title: "Cambiar hora" },
          { id: "debug_cancel", title: "Cancelar" }
        ],
        forceInteractive: true
      });

      return jsonResponse({
        status: "debug_interactive_sent",
        mode: result.mode || ""
      });
    }

    if (normalizeTextForIntent(normalized.text) === "/help") {
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: USER_MESSAGES.help
      });

      return jsonResponse({ status: "help_sent" });
    }

    if (normalizeTextForIntent(normalized.text) === "/lists") {
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatListsIndexForWhatsApp(data.coreUtilityState)
      });

      return jsonResponse({ status: "lists_sent" });
    }

    if (normalizeTextForIntent(normalized.text) === "/reminders") {
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatRemindersForWhatsApp(data.coreUtilityState.reminders, this.env)
      });

      return jsonResponse({ status: "reminders_sent" });
    }

    if (normalizeTextForIntent(normalized.text) === "/clear-reminders") {
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      data.coreUtilityState.reminders = [];
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: { current_turn_text: "/clear-reminders", context_policy: "current_turn_only" },
        route: { intent: "reminder" },
        campaignState: data.campaignState,
        pendingClarification: ""
      });
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: "Listo, limpié los recordatorios guardados para esta conversación."
      });

      return jsonResponse({ status: "reminders_cleared" });
    }

    if (normalizeTextForIntent(normalized.text) === "/debug-reminder") {
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      const parsed = {
        action: "create",
        title: "debug reminder",
        message: "debug reminder",
        dueAt: new Date(Date.now() + 60000).toISOString(),
        timezone: this.env.USER_TIMEZONE || "America/Bogota",
        confidence: 1,
        missingFields: []
      };
      const reminder = buildReminderForConversation(parsed, data, this.env, normalized);
      data.coreUtilityState.reminders = data.coreUtilityState.reminders.concat([createReminder(data.coreUtilityState.reminders, reminder)]);
      await this.scheduleNextReminderAlarm(data);
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: "Debug reminder creado para validar scheduling local."
      });

      return jsonResponse({ status: "debug_reminder_created" });
    }

    if (normalizeTextForIntent(normalized.text) === "/debug-template-reminder") {
      const sample = createReminder([], buildReminderForConversation({
        action: "create",
        title: "debug template reminder",
        message: "debug template reminder",
        dueAt: new Date(Date.now() + 60000).toISOString(),
        timezone: this.env.USER_TIMEZONE || "America/Bogota",
        confidence: 1,
        missingFields: []
      }, Object.assign({}, data, {
        lastMessageAt: Date.now() - 25 * 60 * 60 * 1000
      }), Object.assign({}, this.env, { REMINDERS_DELIVERY_MODE: "alarm" }), normalized));
      const decision = selectReminderDeliveryPath(sample, this.env, { now: new Date().toISOString() });

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatReminderDebugForWhatsApp(decision)
      });

      return jsonResponse({ status: "debug_template_reminder_sent", decision: decision });
    }

    if (normalizeTextForIntent(normalized.text) === "/memory") {
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatUserMemoryForWhatsApp(data)
      });

      return jsonResponse({ status: "memory_sent" });
    }

    if (normalizeTextForIntent(normalized.text) === "/forget-memory") {
      data.customerMemory = null;
      data.userStyleProfile = null;
      data.conversationSummary = null;
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: "Listo, borré tu memoria de usuario guardada. Tus listas y recordatorios se mantienen."
      });

      return jsonResponse({ status: "memory_forgotten" });
    }

    if (normalizeTextForIntent(normalized.text) === "/forget-lists") {
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      data.coreUtilityState.listsState = normalizeListState({});
      data.coreUtilityState.lists = data.coreUtilityState.listsState.lists;
      data.coreUtilityState.activeList = "";
      data.utilityMemory = null;
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: "Listo, borré todas tus listas guardadas."
      });

      return jsonResponse({ status: "lists_forgotten" });
    }

    if (normalizeTextForIntent(normalized.text) === "/forget-all" || isForgetAllText(normalized.text)) {
      data = forgetAllConversationData(data, "manual_forget_all");
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: "Listo, borré memoria, listas, recordatorios, media y contexto de esta conversación."
      });

      return jsonResponse({ status: "all_forgotten" });
    }

    if (normalizeTextForIntent(normalized.text) === "/context") {
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: formatContextForWhatsApp(data)
      });

      return jsonResponse({ status: "context_sent", context: buildContextSnapshot(data) });
    }

    if (normalizeTextForIntent(normalized.text) === "/clear-media") {
      data = clearMediaState(data, "manual_clear_media");
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        swallowErrors: true,
        text: USER_MESSAGES.clearMediaOk
      });

      return jsonResponse({ status: "media_cleared", context: buildContextSnapshot(data) });
    }

    if (normalizeTextForIntent(normalized.text) === "/reset") {
      data.pendingMessages = [];
      data.recentMediaAssets = [];
      data.hasMedia = false;
      data.processing = false;
      data.processingStartedAt = null;
      data.firstMessageAt = 0;
      data.lastMessageAt = 0;
      data.processAfter = 0;
      data.currentTurnId = "";
      data.currentTraceId = "";
      data = resetCampaignState(data, "manual_reset");
      data.activeContext = createEmptyConversationContext("manual_reset");
      data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);
      data.coreUtilityState.activeList = "";
      data.updatedAt = new Date().toISOString();

      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: USER_MESSAGES.resetOk
      });

      return jsonResponse({ status: "reset_done" });
    }

    if (normalizeTextForIntent(normalized.text) === "/debug-media") {
      const debugText = formatDebugMediaForWhatsApp(data, Date.now());
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: debugText
      });

      return jsonResponse({ status: "debug_media_sent" });
    }

    const atomicAppend = await this.appendInboundEventAtomically({
      dataSeed: data,
      normalized: normalized,
      inboundEvent: inboundEvent,
      incomingTraceId: incomingTraceId,
      messageId: messageId,
      now: now
    });

    if (atomicAppend.duplicate) {
      return jsonResponse({ status: "duplicate_ignored", messageId: messageId });
    }

    data = atomicAppend.data;
    normalized = atomicAppend.message;

    if (normalized.video.length) {
      logEvent("VIDEO_RECEIVED", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        count: normalized.video.length,
        fileIds: normalized.video.map(function (item) { return item.fileId; })
      });
    }

    if (normalized.files.length) {
      logEvent("FILE_RECEIVED", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        count: normalized.files.length,
        fileIds: normalized.files.map(function (item) { return item.fileId; })
      });
    }

    console.log("TURN_CREATED:", JSON.stringify({
      doName: data.doName,
      turnId: normalized.turnId,
      messageCount: data.pendingMessages.length
    }));

    logEvent("TURN_CREATED", {
      traceId: normalized.traceId,
      turnId: normalized.turnId,
      doName: data.doName,
      messageCount: data.pendingMessages.length,
      inputType: normalized.type
    });

    if (normalized.media.length || ["IMAGE", "VIDEO"].includes(normalized.type)) {
      let latestUploadedImage = null;
      const resolvedAssets = [];

      console.log("UPLOADED_IMAGE_RECEIVED:", JSON.stringify({
        fileId: normalized.fileId,
        fileIds: normalized.media.map(function (item) { return item.fileId; }),
        type: normalized.type,
        caption: normalized.text.slice(0, 300)
      }));

      for (const mediaItem of normalized.media) {
        let uploadedImageUrl = "";

        try {
          const fileInfo = await getWoztellFileInfo(this.env, {
            appId: normalized.app,
            fileId: mediaItem.fileId
          });
          uploadedImageUrl = fileInfo.url || "";

          console.log("UPLOADED_IMAGE_URL_RESOLVED:", JSON.stringify({
            fileId: mediaItem.fileId,
            urlPreview: safeUrlPreview(uploadedImageUrl)
          }));
        } catch (error) {
          console.error("UPLOADED_IMAGE_URL_RESOLVE_ERROR:", JSON.stringify({
            fileId: mediaItem.fileId,
            message: String(error.message || error)
          }));
        }

        const assetPatch = {
          file_id: mediaItem.fileId,
          url: uploadedImageUrl,
          media_type: mediaItem.type,
          mime_type: mediaItem.mimeType,
          turn_id: normalized.turnId,
          request_id: normalized.turnId,
          analysis: null,
          received_at: normalized.receivedAt,
          status: uploadedImageUrl ? "received" : "url_pending"
        };

        resolvedAssets.push(assetPatch);
        latestUploadedImage = {
          fileId: mediaItem.fileId,
          url: uploadedImageUrl,
          type: mediaItem.type,
          mimeType: mediaItem.mimeType,
          app: normalized.app,
          text: normalized.text,
          receivedAt: normalized.receivedAt
        };
      }

      data = await this.mergeResolvedMediaAssetsAtomically({
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        message: normalized,
        assets: resolvedAssets,
        latestUploadedImage: latestUploadedImage
      });
      logEvent("IMAGE_PREBUFFER_ANALYSIS_BLOCKED", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        pendingCount: data.pendingMessages.length,
        fileIds: resolvedAssets.map(function (asset) { return asset.file_id; })
      });

      console.log("CURRENT_ASSET_SOURCE:", data.campaignState.current_asset_source);
      console.log("CAMPAIGN_ASSETS_UPDATED:", JSON.stringify({
        doName: data.doName,
        campaignId: data.campaignState.campaign_id,
        messageCount: data.pendingMessages.length,
        assetCount: data.campaignState.campaign_assets.length,
        fileIds: resolvedAssets.map(function (asset) { return asset.file_id; }),
        workflow_status: data.campaignState.workflow_status,
        campaign_type: data.campaignState.campaign_type
      }));

      logEvent("IMAGE_APPENDED_ONLY_WAITING_FOR_TURN", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        pendingCount: data.pendingMessages.length,
        fileIds: resolvedAssets.map(function (asset) { return asset.file_id; })
      });
    }

    console.log("BUFFER_TIMING_CONFIG:", JSON.stringify(atomicAppend.timing));
    console.log("BUFFER_WAIT_REASON:", JSON.stringify({
      doName: data.doName,
      reason: atomicAppend.waitReason,
      pendingCount: data.pendingMessages.length,
      hasMedia: data.hasMedia
    }));
    console.log("BUFFER_PROCESS_AFTER_SET:", JSON.stringify({
      doName: data.doName,
      pendingCount: data.pendingMessages.length,
      desiredProcessAt: atomicAppend.desiredProcessAt,
      maxProcessAt: atomicAppend.maxProcessAt,
      processAfter: data.processAfter,
      processAfterIso: new Date(data.processAfter).toISOString()
    }));

    if (data.hasMedia) {
      logEvent("IMAGE_EARLY_PROCESSING_BLOCKED", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        pendingCount: data.pendingMessages.length,
        reason: "receive_message_append_only"
      });
    }

    console.log("DO_MESSAGE_BUFFERED:", JSON.stringify({
      doName: data.doName,
      pendingCount: data.pendingMessages.length,
      hasMedia: data.hasMedia,
      processAfter: new Date(data.processAfter).toISOString()
    }));

    if (atomicAppend.readyByUserDone) {
      logEvent("TURN_READY_BY_USER_DONE", {
        traceId: normalized.traceId,
        turnId: normalized.turnId,
        doName: data.doName,
        pendingCount: data.pendingMessages.length
      });
      await this.processBuffer();
      data = await this.getData();
    }

    return jsonResponse({
      status: "buffered",
      pendingCount: data.pendingMessages.length,
      processAfter: data.processAfter
    });
  }

  async runStorageCriticalSection(callback) {
    if (this.state && typeof this.state.blockConcurrencyWhile === "function") {
      return await this.state.blockConcurrencyWhile(callback);
    }

    const previous = this.storageLock || Promise.resolve();
    let release = function () {};
    this.storageLock = previous.then(function () {
      return new Promise(function (resolve) {
        release = resolve;
      });
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  }

  async appendInboundEventAtomically(params) {
    const clean = params || {};
    const now = Number(clean.now || Date.now());
    const incomingTraceId = clean.incomingTraceId || "";

    return await this.runStorageCriticalSection(async () => {
      let data = await this.getData();
      const seed = clean.dataSeed || {};
      data.doName = seed.doName || data.doName || "";
      data.channel = seed.channel || data.channel || "";
      data.phone = seed.phone || data.phone || "";
      data.member = seed.member || data.member || "";
      data.app = seed.app || data.app || "";
      data.channelIdentity = seed.channelIdentity || data.channelIdentity || null;
      data.messageEventMeta = seed.messageEventMeta || data.messageEventMeta || null;
      data.lastInboundAt = seed.lastInboundAt || data.lastInboundAt || "";

      let message = Object.assign({}, clean.normalized || {});
      const messageId = clean.messageId || message.messageId || randomId(12);
      logEvent("ATOMIC_APPEND_START", {
        traceId: incomingTraceId || data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        messageId: messageId,
        type: message.type || "",
        pendingCount: data.pendingMessages.length
      });

      const seenMessageIds = new Set([].concat(data.processedMessageIds || []).concat((data.pendingMessages || []).map(function (msg) {
        return msg.messageId;
      })));
      if (seenMessageIds.has(messageId)) {
        logEvent("INBOUND_EVENT_DEDUPED", {
          traceId: incomingTraceId || data.currentTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          messageId: messageId,
          type: message.type || ""
        });
        return { duplicate: true, data: data, message: message };
      }

      if (isNewCampaignRequest(message.text)) {
        console.log("NEW_CAMPAIGN_DETECTED:", JSON.stringify({
          doName: data.doName,
          previousCampaignId: data.campaignState.campaign_id,
          text: String(message.text || "").slice(0, 300)
        }));
        data = resetCampaignState(data, "new_campaign_request");
        data.pendingMessages = [];
        data.hasMedia = false;
        data.firstMessageAt = now;
        data.currentTurnId = "";
      }

      const timing = getBufferTimingConfig(this.env);
      const existingOpen = hasOpenPendingTurn(data, now, this.env);
      const userDone = isUserDoneSignal(message.text || "");

      if (!existingOpen) {
        data.firstMessageAt = now;
        data.currentTurnId = "turn_" + now + "_" + randomId(6);
        data.currentTraceId = incomingTraceId || createTraceId([data.doName, data.currentTurnId, messageId]);
        logEvent("ATOMIC_APPEND_CREATED_NEW_TURN", {
          traceId: data.currentTraceId,
          turnId: data.currentTurnId,
          doName: data.doName,
          messageId: messageId,
          type: message.type || ""
        });
        logEvent("TURN_NEW_CREATED_FOR_EVENT", {
          traceId: data.currentTraceId,
          turnId: data.currentTurnId,
          doName: data.doName,
          messageId: messageId,
          type: message.type || ""
        });
      } else {
        logEvent("ATOMIC_APPEND_FOUND_EXISTING_TURN", {
          traceId: data.currentTraceId || incomingTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          messageId: messageId,
          type: message.type || "",
          pendingCount: data.pendingMessages.length
        });
        logEvent("TURN_REUSED_FOR_EVENT", {
          traceId: data.currentTraceId || incomingTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          messageId: messageId,
          type: message.type || "",
          pendingCount: data.pendingMessages.length
        });
        if (userDone) {
          logEvent("USER_DONE_REUSED_PENDING_TURN", {
            traceId: data.currentTraceId || incomingTraceId || "",
            turnId: data.currentTurnId || "",
            doName: data.doName,
            messageId: messageId,
            pendingCount: data.pendingMessages.length
          });
        }
      }

      data.lastMessageAt = now;
      message.turnId = data.currentTurnId || "turn_" + now + "_" + randomId(6);
      message.traceId = data.currentTraceId || incomingTraceId || createTraceId([data.doName, message.turnId, messageId]);
      data = appendPendingEvent(data, message, { traceId: message.traceId });

      if (message.media && message.media.length || ["IMAGE", "VIDEO"].includes(message.type || "")) {
        data.hasMedia = true;
        const explicitMarketingMediaRequest = isExplicitMarketingRequest(message.text);
        let latestUploadedImage = null;
        for (const mediaItem of message.media || []) {
          const assetPatch = {
            file_id: mediaItem.fileId,
            url: "",
            media_type: mediaItem.type,
            mime_type: mediaItem.mimeType,
            turn_id: message.turnId,
            request_id: message.turnId,
            analysis: null,
            received_at: message.receivedAt,
            status: "url_pending"
          };
          data.campaignState.campaign_assets = addCampaignAsset(data.campaignState.campaign_assets, assetPatch);
          data.recentMedia = addRecentMedia(data.recentMedia, Object.assign({}, assetPatch, {
            message_id: message.messageId,
            caption: mediaItem.caption || message.text || ""
          }));
          data.recentMediaAssets = addRecentMediaAsset(data.recentMediaAssets, {
            messageId: message.messageId,
            fileId: mediaItem.fileId,
            url: "",
            mediaType: mediaItem.type,
            mimeType: mediaItem.mimeType,
            caption: mediaItem.caption || message.text || "",
            receivedAt: message.receivedAt,
            turnId: message.turnId,
            traceId: message.traceId
          });
          logEvent("RECENT_MEDIA_ASSET_STORED", {
            traceId: message.traceId,
            turnId: message.turnId,
            doName: data.doName,
            messageId: message.messageId,
            fileId: mediaItem.fileId,
            mediaType: mediaItem.type,
            hasUrl: false
          });
          latestUploadedImage = {
            fileId: mediaItem.fileId,
            url: "",
            type: mediaItem.type,
            mimeType: mediaItem.mimeType,
            app: message.app,
            text: message.text,
            receivedAt: message.receivedAt,
            messageId: message.messageId,
            turnId: message.turnId
          };
        }
        data.campaignState.last_uploaded_image = latestUploadedImage || data.campaignState.last_uploaded_image;
        data.campaignState.current_asset_source = "uploaded_image";
        data.campaignState.uploaded_image_analysis = null;
        data.campaignState.collecting_assets = explicitMarketingMediaRequest;
        data.campaignState.campaign_type = explicitMarketingMediaRequest && data.campaignState.campaign_assets.length > 1
          ? "bulk_from_assets"
          : data.campaignState.campaign_type || "single_post";
        data.campaignState.workflow_status = explicitMarketingMediaRequest ? "collecting_assets" : "media_received";
        logEvent("RECENT_MEDIA_COUNT", {
          traceId: message.traceId,
          turnId: message.turnId,
          doName: data.doName,
          count: normalizeRecentMediaAssets(data.recentMediaAssets).length
        });
      }

      message = attachReferencedMediaToMessage(message, data, now);
      if (message.media && message.media.length) {
        data.hasMedia = true;
      }
      data.pendingMessages = data.pendingMessages.map(function (pending) {
        return pending.messageId === message.messageId ? message : pending;
      });

      data.campaignState.history = appendHistory(data.campaignState.history, {
        role: "user",
        type: message.type,
        text: message.text || (message.fileId ? "[media enviada]" : ""),
        fileId: message.fileId,
        at: message.receivedAt
      });

      const taskTiming = getTaskIntakeTimingConfig(this.env);
      const existingTask = normalizeActiveTask(data.campaignState.active_task);
      const hadActiveTask = Boolean(existingTask && existingTask.status === "awaiting_media");
      const openedTask = hadActiveTask ? null : createTaskIntakeFromText(message.text, {
        now: now,
        waitSeconds: taskTiming.waitSeconds,
        maxWaitSeconds: taskTiming.maxWaitSeconds,
        silenceSeconds: taskTiming.silenceSeconds
      });

      if (openedTask) {
        data.campaignState.active_task = updateTaskIntakeWithMessage(openedTask, message, { now: now });
        logEvent("TASK_INTAKE_WINDOW_OPENED", {
          traceId: message.traceId,
          turnId: message.turnId,
          doName: data.doName,
          type: data.campaignState.active_task.type,
          expectedInputs: data.campaignState.active_task.expectedInputs,
          waitSeconds: taskTiming.waitSeconds,
          maxWaitSeconds: taskTiming.maxWaitSeconds,
          silenceSeconds: taskTiming.silenceSeconds
        });
      } else if (hadActiveTask) {
        data.campaignState.active_task = updateTaskIntakeWithMessage(existingTask, message, { now: now });
        const activeTask = data.campaignState.active_task;
        const addedMedia = extractImageFileIdsFromMessage(message);

        logEvent(addedMedia.length ? "TASK_INTAKE_MEDIA_ADDED" : "TASK_INTAKE_MESSAGE_ADDED", {
          traceId: message.traceId,
          turnId: message.turnId,
          doName: data.doName,
          type: activeTask.type,
          receivedMediaCount: activeTask.receivedMediaCount,
          fileIds: addedMedia
        });
        if (addedMedia.length) {
          logEvent(activeTask.receivedMediaCount === addedMedia.length ? "MULTI_IMAGE_BATCH_STARTED" : "MULTI_IMAGE_BATCH_ASSET_ADDED", {
            traceId: message.traceId,
            turnId: message.turnId,
            doName: data.doName,
            receivedMediaCount: activeTask.receivedMediaCount,
            fileIds: activeTask.taskMediaFileIds
          });
        }
      }

      const waitReason = data.hasMedia ? "media_message" : "text_or_audio_transcript";
      const waitSeconds = data.hasMedia ? timing.imageMessageWaitSeconds : timing.bufferWaitSeconds;
      const desiredProcessAt = data.lastMessageAt + waitSeconds * 1000;
      const maxProcessAt = data.firstMessageAt + timing.bufferMaxWaitSeconds * 1000;
      const activeTaskForTiming = normalizeActiveTask(data.campaignState.active_task);
      if (activeTaskForTiming && activeTaskForTiming.taskMediaFileIds.length) {
        const taskFileIds = new Set(activeTaskForTiming.taskMediaFileIds);
        data.campaignState.task_media_assets = normalizeCampaignAssets(data.campaignState.campaign_assets).filter(function (asset) {
          return taskFileIds.has(asset.file_id);
        });
      }
      const taskDecision = activeTaskForTiming
        ? buildTaskIntakeDecision(activeTaskForTiming, {
          now: now,
          hasMedia: activeTaskForTiming.receivedMediaCount > 0,
          userDone: isTaskDoneSignal(message.text)
        })
        : null;

      data.processAfter = taskDecision && activeTaskForTiming && activeTaskForTiming.status === "awaiting_media"
        ? taskDecision.nextProcessAt || Math.min(desiredProcessAt, maxProcessAt)
        : Math.min(desiredProcessAt, maxProcessAt);
      const mediaHoldAfterAppend = shouldHoldMediaTurnForMoreEvents(data, data.pendingMessages, this.env);
      if (mediaHoldAfterAppend.hold) {
        data.processAfter = mediaHoldAfterAppend.nextProcessAt;
      }
      if (userDone && existingOpen) {
        data.processAfter = now;
      }
      data.updatedAt = new Date().toISOString();

      await this.saveData(data);
      await this.state.storage.setAlarm(data.processAfter);
      logEvent("ATOMIC_APPEND_STORED", {
        traceId: message.traceId,
        turnId: message.turnId,
        doName: data.doName,
        messageId: messageId,
        pendingCount: data.pendingMessages.length,
        processAfter: data.processAfter
      });
      logEvent("ATOMIC_APPEND_PENDING_COUNT", {
        traceId: message.traceId,
        turnId: message.turnId,
        doName: data.doName,
        pendingCount: data.pendingMessages.length
      });
      logTurnTimerReset(data, {
        traceId: message.traceId,
        turnId: message.turnId,
        reason: waitReason,
        processAfter: data.processAfter,
        processAfterIso: new Date(data.processAfter).toISOString()
      });

      if (activeTaskForTiming && activeTaskForTiming.status === "awaiting_media") {
        logEvent("TASK_INTAKE_TIMER_RESET", {
          traceId: message.traceId,
          turnId: message.turnId,
          doName: data.doName,
          reason: taskDecision && taskDecision.reason || "",
          processAfter: data.processAfter,
          processAfterIso: new Date(data.processAfter).toISOString(),
          receivedMediaCount: activeTaskForTiming.receivedMediaCount
        });
      }

      return {
        duplicate: false,
        data: data,
        message: message,
        timing: timing,
        waitReason: waitReason,
        desiredProcessAt: desiredProcessAt,
        maxProcessAt: maxProcessAt,
        readyByUserDone: Boolean(userDone && existingOpen)
      };
    });
  }

  async mergeResolvedMediaAssetsAtomically(params) {
    const clean = params || {};
    return await this.runStorageCriticalSection(async () => {
      let data = await this.getData();
      const assets = Array.isArray(clean.assets) ? clean.assets : [];
      for (const asset of assets) {
        data.campaignState.campaign_assets = addCampaignAsset(data.campaignState.campaign_assets, asset);
        data.recentMedia = addRecentMedia(data.recentMedia, Object.assign({}, asset, {
          message_id: clean.message && clean.message.messageId || asset.message_id || "",
          caption: clean.message && clean.message.text || asset.caption || ""
        }));
        data.recentMediaAssets = addRecentMediaAsset(data.recentMediaAssets, {
          messageId: clean.message && clean.message.messageId || asset.message_id || "",
          fileId: asset.file_id || "",
          url: asset.url || "",
          mediaType: asset.media_type || "IMAGE",
          mimeType: asset.mime_type || "",
          caption: clean.message && clean.message.text || asset.caption || "",
          receivedAt: asset.received_at || clean.message && clean.message.receivedAt || new Date().toISOString(),
          turnId: asset.turn_id || clean.turnId || "",
          traceId: clean.traceId || ""
        });
      }
      if (assets.length) {
        logEvent("RECENT_MEDIA_COUNT", {
          traceId: clean.traceId || "",
          turnId: clean.turnId || "",
          doName: data.doName,
          count: normalizeRecentMediaAssets(data.recentMediaAssets).length
        });
      }
      if (clean.latestUploadedImage) {
        data.campaignState.last_uploaded_image = clean.latestUploadedImage;
      }
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);
      return data;
    });
  }

  async receiveToolResult(body) {
    let data = await this.getData();

    if (body.type === "audio_transcribed" || body.type === "audio_failed") {
      const messageId = body.messageId || "";
      let updated = false;

      data.pendingMessages = data.pendingMessages.map(function (message) {
        if (message.messageId !== messageId) return message;

        updated = true;
        const transcript = cleanUserVisibleText(body.transcript || "");
        const audioStatus = body.type === "audio_transcribed" && transcript ? "transcribed" : "failed";
        const cleanExistingText = cleanUserVisibleText(message.text || "");
        const text = transcript
          ? [transcript, cleanExistingText && cleanExistingText !== transcript ? cleanExistingText : ""].filter(Boolean).join("\n")
          : cleanExistingText;
        if (transcript) {
          logEvent("AUDIO_TRANSCRIPT_CLEANED", {
            traceId: data.currentTraceId || message.traceId || "",
            turnId: data.currentTurnId || message.turnId || "",
            doName: data.doName || "",
            messageId: messageId,
            fileId: message.fileId || message.originalFileId || "",
            textPreview: transcript.slice(0, 240),
            source: "conversation_tool_result"
          });
          logEvent("AUDIO_TRANSCRIPT_USED_AS_USER_TEXT", {
            traceId: data.currentTraceId || message.traceId || "",
            turnId: data.currentTurnId || message.turnId || "",
            doName: data.doName || "",
            messageId: messageId,
            fileId: message.fileId || message.originalFileId || "",
            textLength: text.length,
            source: "conversation_tool_result"
          });
        }

        return Object.assign({}, message, {
          type: "AUDIO",
          text: text,
          originalType: "AUDIO",
          originalFileId: message.originalFileId || message.fileId || "",
          audio: (message.audio || []).map(function (audio) {
            return Object.assign({}, audio, {
              status: audioStatus,
              transcript: transcript,
              error: body.error || ""
            });
          }),
          audioStatus: audioStatus,
          audioTranscript: transcript,
          audioError: body.error || "",
          awaitingTranscription: false,
          transcribedAt: body.transcribedAt || new Date().toISOString()
        });
      });

      if (updated) {
        data.updatedAt = new Date().toISOString();
        await this.saveData(data);

        const pendingAudio = data.pendingMessages.some(function (message) {
          return message.awaitingTranscription;
        });

        if (!pendingAudio && data.pendingMessages.length) {
          data.processAfter = Date.now() + 250;
          await this.saveData(data);
          await this.state.storage.setAlarm(data.processAfter);
        }

        console.log("AUDIO_TURN_UPDATE_OK:", JSON.stringify({
          doName: data.doName || "",
          messageId: messageId,
          status: body.type,
          pendingCount: data.pendingMessages.length,
          pendingAudio: pendingAudio
        }));
      }

      return jsonResponse({ status: updated ? "audio_turn_updated" : "audio_message_not_pending" });
    }

    if (body.type === "image_ready") {
      if (body.campaignId && body.campaignId !== data.campaignState.campaign_id) {
        console.log("IMAGE_RESULT_IGNORED_OLD_CAMPAIGN:", JSON.stringify({
          resultCampaignId: body.campaignId,
          activeCampaignId: data.campaignState.campaign_id,
          imageUrl: body.imageUrl || ""
        }));
        return jsonResponse({ status: "ignored_old_campaign" });
      }

      data.campaignState.last_image_url = body.imageUrl || data.campaignState.last_image_url || "";
      data.campaignState.last_image_prompt = body.prompt || data.campaignState.last_image_prompt || "";
      data.campaignState.workflow_status = "waiting_user_review";
      data.campaignState.expected_next_target = "unknown";
      data.campaignState.history = appendHistory(data.campaignState.history, {
        role: "assistant",
        type: "IMAGE",
        text: "Imagen generada: " + (body.imageUrl || ""),
        fileId: body.imageUrl || "",
        at: new Date().toISOString()
      });
    }

    await this.saveData(data);
    return jsonResponse({ status: "ok" });
  }

  async processBuffer() {
    let data = await this.getData();

    if (!data.pendingMessages.length) {
      return;
    }

    if (data.processing) {
      const now = Date.now();
      const processingStartedAt = Number(data.processingStartedAt || 0);
      const lockAgeMs = processingStartedAt ? now - processingStartedAt : 0;

      if (processingStartedAt && lockAgeMs <= 120000) {
        console.log("DO_PROCESS_BUFFER_SKIPPED:", JSON.stringify({
          reason: "already_processing",
          doName: data.doName || "",
          pendingCount: data.pendingMessages.length,
          processingStartedAt: data.processingStartedAt || null,
          lockAgeMs: lockAgeMs
        }));
        return;
      }

      console.log("STALE_PROCESSING_LOCK_RESET:", JSON.stringify({
        doName: data.doName || "",
        processingStartedAt: data.processingStartedAt,
        now: now,
        lockAgeMs: lockAgeMs,
        pendingCount: data.pendingMessages.length
      }));

      data.processing = false;
      data.processingStartedAt = null;
      await this.saveData(data);
    }

    let messages = data.pendingMessages.slice();
    const audioWait = getAudioTurnWaitConfig(this.env);
    const pendingAudioMessages = messages.filter(function (message) {
      return message.awaitingTranscription;
    });

    if (pendingAudioMessages.length) {
      const oldestAudioAt = Math.min.apply(null, pendingAudioMessages.map(function (message) {
        return Date.parse(message.receivedAt || "") || Date.now();
      }));
      const audioWaitAgeMs = Date.now() - oldestAudioAt;

      if (audioWaitAgeMs < audioWait.maxAudioTurnWaitMs) {
        data.processAfter = Date.now() + audioWait.retryWaitMs;
        data.updatedAt = new Date().toISOString();
        await this.saveData(data);
        await this.state.storage.setAlarm(data.processAfter);

        console.log("TURN_BUFFER_STARTED:", JSON.stringify({
          doName: data.doName,
          turnId: data.currentTurnId || "",
          reason: "waiting_audio_transcription",
          pendingAudioCount: pendingAudioMessages.length,
          waitAgeMs: audioWaitAgeMs,
          retryInMs: audioWait.retryWaitMs
        }));
        logEvent("TURN_WAITING_AUDIO_TRANSCRIPT", {
          traceId: data.currentTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          pendingAudioCount: pendingAudioMessages.length,
          waitAgeMs: audioWaitAgeMs,
          retryInMs: audioWait.retryWaitMs
        });

        return;
      }

      data.pendingMessages = data.pendingMessages.map(function (message) {
        if (!message.awaitingTranscription) return message;

        return Object.assign({}, message, {
          awaitingTranscription: false,
          audioStatus: "failed",
          audioError: "AUDIO_TIMEOUT"
        });
      });
      messages = data.pendingMessages.slice();

      console.log("AUDIO_TIMEOUT:", JSON.stringify({
        doName: data.doName,
        turnId: data.currentTurnId || "",
        pendingAudioCount: pendingAudioMessages.length,
        waitAgeMs: audioWaitAgeMs
      }));
      logEvent("TURN_AUDIO_TIMEOUT", {
        traceId: data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        pendingAudioCount: pendingAudioMessages.length,
        waitAgeMs: audioWaitAgeMs
      });
    }

    const mediaHold = shouldHoldMediaTurnForMoreEvents(data, messages, this.env);
    if (mediaHold.hold) {
      data.processAfter = mediaHold.nextProcessAt;
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);
      await this.state.storage.setAlarm(data.processAfter);
      logEvent("IMAGE_EARLY_PROCESSING_BLOCKED", {
        traceId: data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        pendingCount: messages.length,
        waitAgeMs: mediaHold.ageMs,
        waitMsRemaining: Math.max(0, mediaHold.nextProcessAt - Date.now()),
        reason: mediaHold.reason
      });
      logEvent("IMAGE_PREBUFFER_ANALYSIS_BLOCKED", {
        traceId: data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        pendingCount: messages.length,
        reason: mediaHold.reason
      });
      return;
    }

    const activeTaskBeforeProcessing = normalizeActiveTask(data.campaignState.active_task);
    if (activeTaskBeforeProcessing && activeTaskBeforeProcessing.status === "awaiting_media") {
      const now = Date.now();
      const hasTaskMedia = activeTaskBeforeProcessing.receivedMediaCount > 0;
      const taskDecision = buildTaskIntakeDecision(activeTaskBeforeProcessing, {
        now: now,
        hasMedia: hasTaskMedia,
        userDone: messages.some(function (message) { return isTaskDoneSignal(message.text || ""); })
      });

      if (!taskDecision.ready) {
        data.processAfter = taskDecision.nextProcessAt || data.processAfter || now + 1000;
        data.updatedAt = new Date().toISOString();
        await this.saveData(data);
        await this.state.storage.setAlarm(data.processAfter);
        logEvent("TASK_INTAKE_TIMER_RESET", {
          traceId: data.currentTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          reason: taskDecision.reason,
          processAfter: data.processAfter,
          processAfterIso: new Date(data.processAfter).toISOString(),
          receivedMediaCount: activeTaskBeforeProcessing.receivedMediaCount
        });
        return;
      }

      if (taskDecision.reason === "expired_no_media") {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          memberId: data.member,
          appId: data.app,
          text: "Pasame las imagenes o capturas y te ayudo a revisar los precios."
        });
        logEvent("TASK_INTAKE_EXPIRED_NO_MEDIA", {
          traceId: data.currentTraceId || "",
          turnId: data.currentTurnId || "",
          doName: data.doName,
          type: activeTaskBeforeProcessing.type
        });
        for (const msg of messages) data.processedMessageIds.push(msg.messageId);
        data.processedMessageIds = data.processedMessageIds.slice(-80);
        data.pendingMessages = [];
        data.hasMedia = false;
        data.currentTurnId = "";
        data.currentTraceId = "";
        data.processAfter = 0;
        data.campaignState.active_task = null;
        data.campaignState.task_media_assets = [];
        data.updatedAt = new Date().toISOString();
        await this.saveData(data);
        return;
      }

      const readyEvent = taskDecision.reason === "user_done"
        ? "TASK_INTAKE_READY_BY_USER_DONE"
        : taskDecision.reason === "silence" ? "TASK_INTAKE_READY_BY_SILENCE" : "TASK_INTAKE_READY_BY_MAX_WAIT";
      logEvent(readyEvent, {
        traceId: data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        reason: taskDecision.reason,
        receivedMediaCount: activeTaskBeforeProcessing.receivedMediaCount
      });
      logTurnReady(taskDecision.reason === "user_done" ? "user_done" : taskDecision.reason === "silence" ? "silence" : "max_wait", data, {
        reason: taskDecision.reason,
        receivedMediaCount: activeTaskBeforeProcessing.receivedMediaCount
      });
      logEvent("MULTI_IMAGE_BATCH_READY", {
        traceId: data.currentTraceId || "",
        turnId: data.currentTurnId || "",
        doName: data.doName,
        receivedMediaCount: activeTaskBeforeProcessing.receivedMediaCount,
        fileIds: activeTaskBeforeProcessing.taskMediaFileIds
      });
    }

    data.processing = true;
    data.processingStartedAt = Date.now();
    data.updatedAt = new Date().toISOString();

    await this.saveData(data);

    let success = false;
    let shouldSendFallback = false;

    try {
      console.log("DO_PROCESS_BUFFER_STARTED:", JSON.stringify({
        doName: data.doName,
        messageCount: messages.length,
        processingStartedAt: data.processingStartedAt
      }));

      const userTurn = buildUserTurn(messages, data.campaignState, {
        turnId: data.currentTurnId || "",
        traceId: data.currentTraceId || (messages[0] && messages[0].traceId) || createTraceId([data.doName, data.currentTurnId || ""])
      });
      userTurn.activeTask = normalizeActiveTask(data.campaignState.active_task);
      userTurn.active_task = userTurn.activeTask;
      userTurn.taskMediaAssets = normalizeCampaignAssets(data.campaignState.task_media_assets || []);
      userTurn.task_media_assets = userTurn.taskMediaAssets;
      userTurn.expected_media_count = userTurn.activeTask && userTurn.activeTask.expectedInputs === "images" ? "unknown" : 0;
      userTurn.received_media_count = userTurn.activeTask ? userTurn.activeTask.receivedMediaCount : userTurn.image_count;
      const relevantMediaBatch = collectRelevantMediaForTurn(userTurn, data, messages, {
        now: Date.now(),
        maxAgeMs: 180000
      });
      if (relevantMediaBatch.assets.length && relevantMediaBatch.assets.length >= (userTurn.media_batch && userTurn.media_batch.assets && userTurn.media_batch.assets.length || 0)) {
        applyRelevantMediaToUserTurn(userTurn, relevantMediaBatch, messages);
      }
      const mediaRecount = handleUserClaimedMoreImages(userTurn.current_turn_text || "", data.campaignState, messages);
      if (mediaRecount.claimed && mediaRecount.shouldReanalyze) {
        userTurn.media_batch = mediaRecount.mediaBatch;
        userTurn.media_batch_summary = buildMediaBatchSummary(mediaRecount.mediaBatch);
        userTurn.image_count = mediaRecount.receivedCount;
        userTurn.current_turn_media = summarizeAssetsForContext(mediaRecount.mediaBatch.assets);
        userTurn.currentTurnMedia = userTurn.current_turn_media;
      }
      logFinalEventCounts(userTurn, data);
      const coreFlags = getCoreFeatureFlags(this.env);
      activeLogContext = {
        traceId: userTurn.trace_id,
        turnId: userTurn.turn_id,
        doName: data.doName,
        memberId: data.member || "",
        appId: data.app || ""
      };
      data = updateConversationMemory(data, userTurn, {
        flags: coreFlags,
        utilityState: data.coreUtilityState
      });
      if (shouldExitMarketingContext(userTurn.current_turn_text)) {
        data = resetCampaignState(data, "general_assistant_requested");
      }
      data.campaignState.current_turn = buildTurnSummary(userTurn);
      data.campaignState.active_turn = userTurn;
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: null,
        campaignState: data.campaignState,
        pendingClarification: ""
      });
      const recentConversationWindow = getRecentConversationWindow(data, 20);
      const requestContext = buildRequestContext({
        userTurn: userTurn,
        recentConversationWindow: recentConversationWindow,
        activeContext: data.activeContext,
        conversationSummary: data.conversationSummary,
        customerMemory: data.customerMemory,
        utilityMemory: data.utilityMemory,
        mediaMemorySummary: data.campaignState.media_batch_summary,
        activeTask: userTurn.activeTask,
        recentLimit: 20
      });
      data.requestContext = requestContext;
      const supervisorPlan = createConversationSupervisorPlan(buildSupervisorInput({
        userTurn: userTurn,
        requestContext: requestContext,
        activeContext: data.activeContext,
        conversationSummary: data.conversationSummary,
        utilityMemory: data.utilityMemory,
        mediaMemorySummary: data.campaignState.media_batch_summary,
        activeTask: userTurn.activeTask,
        supervisorConfig: getSupervisorConfig(this.env)
      }));
      applySupervisorMediaScope(userTurn, supervisorPlan, data.campaignState, messages);
      const supervisorRelevantMediaBatch = collectRelevantMediaForTurn(userTurn, data, messages, {
        now: Date.now(),
        maxAgeMs: 180000
      });
      if (supervisorRelevantMediaBatch.assets.length && supervisorRelevantMediaBatch.assets.length >= (userTurn.media_batch && userTurn.media_batch.assets && userTurn.media_batch.assets.length || 0)) {
        applyRelevantMediaToUserTurn(userTurn, supervisorRelevantMediaBatch, messages);
      }
      data.campaignState.supervisor_plan = supervisorPlan;
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: { intent: supervisorPlan.intent },
        campaignState: data.campaignState,
        lastUserGoal: supervisorPlan.currentUserGoal || "",
        pendingClarification: supervisorPlan.needsClarification ? supervisorPlan.clarificationQuestion : ""
      });
      logSupervisorPlan(supervisorPlan, userTurn, data, recentConversationWindow);
      const mediaBatch = userTurn.media_batch;
      data.campaignState.media_batch_summary = buildMediaBatchSummary(mediaBatch);

      console.log("TURN_BUFFER_READY:", JSON.stringify({
        doName: data.doName,
        turnId: userTurn.turn_id,
        messageCount: messages.length,
        contextPolicy: userTurn.context_policy
      }));
      logEvent("TURN_BUFFER_READY", {
        traceId: userTurn.trace_id,
        turnId: userTurn.turn_id,
        doName: data.doName,
        messageCount: messages.length,
        contextPolicy: userTurn.context_policy,
        inputTypes: userTurn.input_types
      });
      console.log("TURN_INPUT_TYPES:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, inputTypes: userTurn.input_types }));
      console.log("TURN_TEXT_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.text_count }));
      console.log("TURN_AUDIO_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.audio_count }));
      console.log("TURN_IMAGE_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.image_count }));
      console.log("TURN_VIDEO_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.video_count }));
      console.log("TURN_FILE_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.file_count }));
      console.log("TURN_CAPTIONS_FOUND:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, captions: userTurn.captions }));
      console.log("TURN_CONTEXT_POLICY:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, policy: userTurn.context_policy }));
      logEvent("TURN_CONTEXT_POLICY", {
        traceId: userTurn.trace_id,
        turnId: userTurn.turn_id,
        doName: data.doName,
        policy: userTurn.context_policy,
        currentTurnMedia: userTurn.currentTurnMedia && userTurn.currentTurnMedia.asset_count || 0,
        previousRelevantMedia: userTurn.previousRelevantMedia && userTurn.previousRelevantMedia.asset_count || 0,
        staleMedia: userTurn.staleMedia && userTurn.staleMedia.asset_count || 0
      });
      if (userTurn.image_count > 0 && extractPlainTurnText(userTurn.current_turn_text || "")) {
        console.log("IMAGE_CAPTION_MERGED:", JSON.stringify({
          doName: data.doName,
          turnId: userTurn.turn_id,
          imageCount: userTurn.image_count,
          textPreview: extractPlainTurnText(userTurn.current_turn_text || "").slice(0, 240)
        }));
        logEvent("IMAGE_CAPTION_MERGED", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          imageCount: userTurn.image_count
        });
      }
      if (userTurn.audio_count > 0 && userTurn.audio_transcripts && userTurn.audio_transcripts.length) {
        logEvent("AUDIO_TRANSCRIPT_ROUTED_AS_TEXT", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          transcriptPreview: userTurn.audio_transcripts.join(" ").slice(0, 240)
        });
        logEvent("AUDIO_TRANSCRIPT_NORMALIZED", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          textPreview: extractPlainTurnText(userTurn.current_turn_text || "").slice(0, 240)
        });
      }
      if (userTurn.context_policy !== "use_previous_context") {
        console.log("TURN_CONTEXT_RESET_REASON:", JSON.stringify({
          doName: data.doName,
          turnId: userTurn.turn_id,
          reason: userTurn.context_policy
        }));
      }

      if (mediaBatch.assets.length) {
        console.log("MEDIA_BATCH_CREATED:", JSON.stringify({
          doName: data.doName,
          messageCount: messages.length,
          assetCount: mediaBatch.assets.length,
          fileIds: mediaBatch.fileIds,
          analyzedAssetCount: mediaBatch.analyzedAssetCount,
          failedAssetCount: mediaBatch.failedAssetCount,
          workflow_status: data.campaignState.workflow_status,
          campaign_type: data.campaignState.campaign_type,
          usedFallback: false
        }));
        logEvent("MEDIA_BATCH_CREATED", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          messageCount: messages.length,
          assetCount: mediaBatch.assets.length,
          fileIds: mediaBatch.fileIds,
          analyzedAssetCount: mediaBatch.analyzedAssetCount,
          failedAssetCount: mediaBatch.failedAssetCount,
          workflow_status: data.campaignState.workflow_status,
          campaign_type: data.campaignState.campaign_type
        });
        console.log("MEDIA_BATCH_ASSET_COUNT:", JSON.stringify({
          doName: data.doName,
          assetCount: mediaBatch.assets.length,
          analyzedAssetCount: mediaBatch.analyzedAssetCount,
          failedAssetCount: mediaBatch.failedAssetCount
        }));
        console.log("MEDIA_BATCH_FILE_IDS:", JSON.stringify({
          doName: data.doName,
          fileIds: mediaBatch.fileIds
        }));
      }

      if (mediaRecount.claimed && !mediaRecount.shouldReanalyze) {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          memberId: data.member,
          appId: data.app,
          text: mediaRecount.message
        });
        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: { intent: "price_review", targetModule: "vision" },
          campaignState: data.campaignState,
          pendingClarification: "awaiting_missing_image"
        });
      } else if (shouldSendAudioOnlyFallback(userTurn)) {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.audioFailed
        });
        logEvent("USER_FALLBACK_SENT", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          reason: "audio_only_failed"
        });

        console.log("AUDIO_BATCH_TRANSCRIPTION_DONE:", JSON.stringify({
          doName: data.doName,
          turnId: userTurn.turn_id,
          audioCount: userTurn.audio_batch.count,
          transcribedCount: userTurn.audio_batch.transcribedCount,
          failedCount: userTurn.audio_batch.failedCount
        }));
      } else if (supervisorPlan.intent === "general" && shouldUseLocalGeneralAnswer(userTurn.current_turn_text || "") && composeGeneralTextAnswer(userTurn.current_turn_text || "")) {
        const composed = composeFinalResponse({
          supervisorPlan: supervisorPlan,
          specialistResults: { text: composeGeneralTextAnswer(userTurn.current_turn_text || "") },
          currentUserMessage: userTurn.current_turn_text || "",
          currentMediaSummary: userTurn.media_batch_summary || {}
        });
        await sendConversationalResponse(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          memberId: data.member,
          appId: data.app,
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          userTurn: userTurn,
          recentMediaAssets: data.recentMediaAssets,
          supervisorPlan: supervisorPlan,
          intent: supervisorPlan.intent,
          text: composed.text
        });
        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: { intent: "general", targetModule: "general_explainer" },
          campaignState: data.campaignState,
          pendingClarification: ""
        });
      } else if (supervisorPlan.intent === "memory") {
        data = await this.handleMemoryUtility(data, supervisorPlan, userTurn);
      } else if (supervisorPlan.responseStrategy === "ask_clarification" && supervisorPlan.clarificationQuestion) {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          memberId: data.member,
          appId: data.app,
          text: supervisorPlan.clarificationQuestion
        });
        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: { intent: supervisorPlan.intent },
          campaignState: data.campaignState,
          pendingClarification: supervisorPlan.clarificationQuestion
        });
      } else if (shouldSupervisorHandleVision(supervisorPlan, userTurn)) {
        await this.maybeSendFastAck(data, supervisorPlan, userTurn);
        data = await this.handleVisionUtility(data, {
          intent: mapSupervisorVisionIntent(supervisorPlan.intent),
          module: "vision",
          shouldHandleInCore: true,
          supervisorPlan: supervisorPlan
        }, userTurn, messages);
      } else if (shouldAskHowToUseImageOnlyTurn(userTurn, messages)) {
        const text = USER_MESSAGES.uploadedImageClarification;

        await this.sendInteractiveOrText(data, {
          traceId: userTurn.trace_id,
          text: text,
          fallbackText: text + "\nOpciones: Analizar imagen, Extraer texto, Comparar imagen.",
          buttons: [
            { id: "image_analyze", title: "Analizar imagen" },
            { id: "image_ocr", title: "Extraer texto" },
            { id: "image_compare", title: "Comparar" }
          ]
        });
        logEvent("GENERAL_IMAGE_CLARIFICATION_SENT", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName
        });

        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: { intent: "image_question", targetModule: "vision", shouldHandleInCore: true },
          campaignState: data.campaignState,
          pendingClarification: text
        });
      } else if (shouldAskHowToUseCollectedAssets(data, messages)) {
        const assetCount = data.campaignState.campaign_assets.length;
        const text = USER_MESSAGES.assetsCollected.replace("{count}", String(assetCount));

        await this.sendInteractiveOrText(data, {
          traceId: userTurn.trace_id,
          text: text,
          fallbackText: text + "\nOpciones: Analizar imagenes, Extraer texto, Comparar, Crear lista.",
          listRows: [
            { id: "batch_analyze", title: "Analizar imagenes" },
            { id: "batch_ocr", title: "Extraer texto" },
            { id: "batch_compare", title: "Comparar" },
            { id: "batch_list", title: "Crear lista" }
          ],
          buttonText: "Ver opciones",
          listTitle: "Imagenes"
        });

        data.campaignState.workflow_status = "waiting_asset_usage_decision";
        data.campaignState.expected_next_target = "asset_usage_decision";
        data.campaignState.collecting_assets = true;
        data.campaignState.history = appendHistory(data.campaignState.history, {
          role: "assistant",
          type: "TEXT",
          text: text,
          at: new Date().toISOString()
        });

        console.log("BULK_ASSET_COLLECTION_PROMPT_SENT:", JSON.stringify({
          campaignId: data.campaignState.campaign_id,
          assetCount: assetCount
        }));
      } else {
      const utilityRoute = routeCoreUtilityIntent(userTurn, {
        flags: coreFlags,
        timezone: this.env.USER_TIMEZONE || "America/Bogota"
      });
      if (isMarketingRoute(utilityRoute, userTurn)) {
        logEvent("LEGACY_MARKETING_PATH_ALLOWED", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          intent: utilityRoute.intent
        });
        logEvent("CAMPAIGN_STATE_USED_FOR_MARKETING_INTENT", {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          intent: utilityRoute.intent
        });
      } else {
        if (hasActiveMarketingWorkflow(data.campaignState)) {
          logEvent("LEGACY_MARKETING_PATH_BLOCKED", {
            traceId: userTurn.trace_id,
            turnId: userTurn.turn_id,
            doName: data.doName,
            intent: utilityRoute.intent
          });
        }
        data.campaignState = clearCampaignStateForGeneralIntent(data.campaignState, {
          traceId: userTurn.trace_id,
          turnId: userTurn.turn_id,
          doName: data.doName,
          intent: utilityRoute.intent
        });
      }
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: utilityRoute,
        campaignState: data.campaignState,
        pendingClarification: ""
      });

      if (isVisionUtilityRoute(utilityRoute)) {
        data = await this.handleVisionUtility(data, utilityRoute, userTurn, messages);
      } else if (utilityRoute.shouldHandleInCore) {
        data = await this.handleCoreUtility(data, utilityRoute, userTurn);
      } else {
      const plan = await callOrchestratorPlan(this.env, {
        doName: data.doName,
        channel: data.channel,
        phone: data.phone,
        messages: messages,
        clientProfile: data.clientProfile,
        campaignState: data.campaignState,
        conversationSummary: data.conversationSummary,
        userStyleProfile: data.userStyleProfile,
        customerMemory: data.customerMemory,
        utilityMemory: data.utilityMemory,
        activeContext: data.activeContext,
        requestContext: requestContext,
        userTurn: userTurn
      });

      console.log("ORCHESTRATOR_PLAN:", JSON.stringify(plan));

      data = await this.executePlan(data, messages, plan, userTurn);
      }
      }

      for (const msg of messages) {
        data.processedMessageIds.push(msg.messageId);
      }

      data.processedMessageIds = data.processedMessageIds.slice(-80);
      data.pendingMessages = data.pendingMessages.filter(function (pending) {
        return !messages.some(function (processed) {
          return processed.messageId === pending.messageId;
        });
      });
      data.hasMedia = data.pendingMessages.some(function (pending) {
        return pending.fileId || ["IMAGE", "VIDEO"].includes(pending.type || "");
      });
      if (!data.pendingMessages.length) {
        data.currentTurnId = "";
        data.currentTraceId = "";
        if (activeTaskBeforeProcessing && activeTaskBeforeProcessing.status === "awaiting_media") {
          data.campaignState.active_task = null;
          data.campaignState.task_media_assets = [];
        }
      }
      data.firstMessageAt = data.pendingMessages.length ? Date.now() : 0;
      data.lastMessageAt = data.pendingMessages.length ? Date.now() : 0;
      data.processAfter = 0;
      data.updatedAt = new Date().toISOString();
      success = true;
    } catch (error) {
      const fallbackReason = summarizeErrorForLog(error);
      captureError(error, { stage: "processBuffer", doName: data.doName, traceId: data.currentTraceId || "" });
      logEvent("FALLBACK_REASON", {
        traceId: data.currentTraceId || "",
        doName: data.doName,
        stage: "processBuffer",
        reason: fallbackReason
      }, {
        level: "error",
        traceId: data.currentTraceId || ""
      });
      console.error("DO_PROCESS_BUFFER_ERROR:", fallbackReason);

      data = await this.getData();
      data.updatedAt = new Date().toISOString();
      shouldSendFallback = true;
    } finally {
      activeLogContext = {};
      data.processing = false;
      data.processingStartedAt = null;
      data.updatedAt = new Date().toISOString();

      await this.saveData(data);

      if (success && data.pendingMessages.length) {
        const timing = getBufferTimingConfig(this.env);
        const waitSeconds = data.hasMedia ? timing.imageMessageWaitSeconds : timing.bufferWaitSeconds;
        const now = Date.now();
        data.processAfter = Math.min(
          now + waitSeconds * 1000,
          now + timing.bufferMaxWaitSeconds * 1000
        );
        console.log("BUFFER_TIMING_CONFIG:", JSON.stringify(timing));
        console.log("BUFFER_PROCESS_AFTER_SET:", JSON.stringify({
          doName: data.doName || "",
          pendingCount: data.pendingMessages.length,
          hasMedia: data.hasMedia,
          processAfter: data.processAfter,
          processAfterIso: new Date(data.processAfter).toISOString()
        }));
        await this.saveData(data);
        await this.state.storage.setAlarm(data.processAfter);
      }
    }

    if (shouldSendFallback && data.channel && data.phone) {
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: USER_MESSAGES.requestFailed
      });
      logEvent("USER_FALLBACK_SENT", {
        traceId: data.currentTraceId || "",
        doName: data.doName,
        reason: "process_buffer_error",
        fallbackReason: "See FALLBACK_REASON for this traceId"
      });

      data.pendingMessages = data.pendingMessages.filter(function (pending) {
        return !messages.some(function (processed) {
          return processed.messageId === pending.messageId;
        });
      });
      data.hasMedia = data.pendingMessages.some(function (pending) {
        return pending.fileId || ["IMAGE", "VIDEO"].includes(pending.type || "");
      });
      if (!data.pendingMessages.length) {
        data.currentTurnId = "";
        data.currentTraceId = "";
      }
      data.processAfter = 0;
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);
    }
  }

  async sendInteractiveOrText(data, params) {
    const clean = params || {};
    const env = this.env || {};
    const mode = String(env.INTERACTIVE_DELIVERY_MODE || "safe").toLowerCase();
    const fallbackText = clean.fallbackText || clean.text || "";

    if (clean.requiresPrimaryResponse && !clean.primaryResponseSent) {
      logEvent("INTERACTIVE_SKIPPED_NO_PRIMARY_RESPONSE", {
        traceId: clean.traceId || data.currentTraceId || "",
        doName: data.doName || ""
      });
      return { mode: "skipped_no_primary_response" };
    }

    if (mode === "disabled" || mode === "text") {
      await sendWoztellTextMessage(env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: fallbackText || USER_MESSAGES.requestFailed
      });
      return { mode: "text_only" };
    }

    try {
      return await sendWhatsAppInteractiveMessage(env, {
        traceId: clean.traceId || data.currentTraceId || "",
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: clean.text || fallbackText,
        fallbackText: fallbackText,
        buttons: clean.buttons || [],
        listRows: clean.listRows || [],
        listTitle: clean.listTitle || "",
        buttonText: clean.buttonText || ""
      }, {
        forceInteractive: Boolean(clean.forceInteractive)
      });
    } catch (error) {
      captureError(error, {
        stage: "sendInteractiveOrText",
        traceId: clean.traceId || data.currentTraceId || "",
        doName: data.doName || ""
      });
      await sendWoztellTextMessage(env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: fallbackText || USER_MESSAGES.requestFailed
      });
      return { mode: "text_fallback_after_error" };
    }
  }

  async maybeSendFastAck(data, supervisorPlan, userTurn) {
    if (!shouldSendFastAck({
      env: this.env,
      supervisorPlan: supervisorPlan,
      userTurn: userTurn
    })) {
      logEvent("FAST_ACK_SKIPPED", {
        traceId: userTurn && userTurn.trace_id || "",
        turnId: userTurn && userTurn.turn_id || "",
        doName: data && data.doName || "",
        intent: supervisorPlan && supervisorPlan.intent || ""
      });
      return false;
    }

    await sleep(getFastAckDelayMs(this.env));
    await sendWoztellTextMessage(this.env, {
      channelId: data.channel,
      recipientId: data.phone,
      memberId: data.member,
      appId: data.app,
      traceId: userTurn && userTurn.trace_id || "",
      turnId: userTurn && userTurn.turn_id || "",
      doName: data.doName || "",
      text: buildFastAckText(supervisorPlan, userTurn)
    });
    logEvent("FAST_ACK_SENT", {
      traceId: userTurn && userTurn.trace_id || "",
      turnId: userTurn && userTurn.turn_id || "",
      doName: data && data.doName || "",
      intent: supervisorPlan && supervisorPlan.intent || ""
    });
    return true;
  }

  async handleVisionUtility(data, utilityRoute, userTurn, messages) {
    const route = utilityRoute || {};
    const mediaBatch = userTurn && userTurn.media_batch || { assets: [] };

    if (!mediaBatch.assets || !mediaBatch.assets.length) {
      const question = "Necesito que me envies la imagen o me indiques cual imagen anterior debo usar.";
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: question
      });
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: route,
        campaignState: data.campaignState,
        pendingClarification: question
      });
      return data;
    }

    const woztellPayload = buildWoztellPayloadFromData(data, messages);
    const imageAnalysisBatch = Object.assign({}, mediaBatch, {
      assets: (mediaBatch.assets || []).filter(function (asset) {
        return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
      })
    });

    if (!imageAnalysisBatch.assets.length) {
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: "Recibi media, pero por ahora solo puedo analizar imagenes. Videos y archivos quedan como metadata."
      });
      return data;
    }

    logEvent("MULTI_IMAGE_BATCH_ANALYSIS_STARTED", {
      traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
      turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
      doName: data.doName,
      assetCount: imageAnalysisBatch.assets.length,
      fileIds: imageAnalysisBatch.assets.map(function (asset) { return asset.file_id; }).filter(Boolean)
    });

    const analysisResult = await analyzeMediaBatch(this.env, {
      doName: data.doName,
      traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
      turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
      campaignState: data.campaignState,
      mediaBatch: imageAnalysisBatch,
      caption: consolidatedMessagesText(messages),
      woztellPayload: woztellPayload
    });
    logEvent("MULTI_IMAGE_BATCH_ANALYSIS_DONE", {
      traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
      turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
      doName: data.doName,
      assetCount: analysisResult.summary && analysisResult.summary.asset_count || 0,
      analyzedAssetCount: analysisResult.summary && analysisResult.summary.analyzed_asset_count || 0,
      failedAssetCount: analysisResult.summary && analysisResult.summary.failed_asset_count || 0
    });

    data.campaignState = updateCampaignAssetsWithAnalysis(data.campaignState, analysisResult.assets);
    data.campaignState.media_batch_summary = analysisResult.summary;
    data.campaignState.uploaded_image_analysis = analysisResult.summary;
    data.campaignState.current_asset_source = "uploaded_image";

    logEvent("VISION_FINAL_RESPONSE_START", {
      traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
      turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
      doName: data.doName,
      intent: route.intent
    });
    const supervisedText = route.supervisorPlan
      ? generateFinalUserResponse(route.supervisorPlan, { vision: analysisResult.summary }, {
        currentUserMessage: userTurn && userTurn.current_turn_text || "",
        recentConversationWindow: getRecentConversationWindow(data, 20),
        activeContext: data.activeContext,
        memorySummary: data.conversationSummary
      })
      : "";
    const legacyText = formatVisionUtilityResponse(route.intent, analysisResult.summary, userTurn);
    const finalResponse = composeFinalResponse({
      supervisorPlan: route.supervisorPlan || { intent: route.intent || "image_question" },
      specialistResults: { vision: analysisResult.summary, text: supervisedText || legacyText },
      currentUserMessage: userTurn && userTurn.current_turn_text || "",
      currentMediaSummary: analysisResult.summary,
      recentHistorySummary: getRecentConversationWindow(data, 20),
      memorySummary: data.conversationSummary
    });
    const text = finalResponse.text || supervisedText || legacyText;
    try {
      await sendConversationalResponse(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        traceId: userTurn && userTurn.trace_id || "",
        turnId: userTurn && userTurn.turn_id || "",
        doName: data.doName,
        userTurn: userTurn,
        recentMediaAssets: data.recentMediaAssets,
        supervisorPlan: route.supervisorPlan || { intent: route.intent || "image_question" },
        intent: route.supervisorPlan && route.supervisorPlan.intent || route.intent || "image_question",
        text: text
      });
      logEvent("VISION_FINAL_RESPONSE_SENT", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        intent: route.intent
      });
    } catch (error) {
      logEvent("VISION_FINAL_RESPONSE_FAILED", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        message: String(error.message || error)
      }, { level: "error" });
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: USER_MESSAGES.imageAnalysisFailed
      });
    }

    data.activeContext = updateConversationContext(data.activeContext, {
      userTurn: userTurn,
      route: route,
      campaignState: data.campaignState,
      pendingClarification: buildMediaFollowupPrompt(route.intent, analysisResult.summary),
      lastOfferedAction: inferMediaFollowupAction(route.intent, analysisResult.summary, userTurn),
      lastOfferedIntent: route.intent || "image_question",
      lastOfferedAt: new Date().toISOString()
    });
    data.campaignState.history = appendHistory(data.campaignState.history, {
      role: "assistant",
      type: "TEXT",
      text: text,
      at: new Date().toISOString()
    });

    return data;
  }

  async handleMemoryUtility(data, supervisorPlan, userTurn) {
    const plan = supervisorPlan || {};
    data.customerMemory = applySupervisorMemoryUpdates(data.customerMemory, plan.memoryUpdates);

    const wantsName = (plan.actions || []).some(function (action) {
      return action && action.type === "answer_memory_name";
    });
    const text = wantsName
      ? data.customerMemory && data.customerMemory.name
        ? "Te llamas " + data.customerMemory.name + "."
        : "Todavia no tengo tu nombre guardado."
      : "Listo, actualicé tu memoria de usuario.";

    await sendWoztellTextMessage(this.env, {
      channelId: data.channel,
      recipientId: data.phone,
      memberId: data.member,
      appId: data.app,
      text: text
    });

    data.activeContext = updateConversationContext(data.activeContext, {
      userTurn: userTurn,
      route: { intent: "memory" },
      campaignState: data.campaignState,
      lastUserGoal: "memoria de usuario",
      pendingClarification: ""
    });

    return data;
  }

  async handleCoreUtility(data, utilityRoute, userTurn) {
    const route = utilityRoute || {};
    data.coreUtilityState = normalizeCoreUtilityState(data.coreUtilityState);

    if (route.intent === "reminder") {
      const parsed = resolveReminderReferences(route.parsed || {}, data.activeContext);

      if (parsed.action === "list") {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: formatRemindersForWhatsApp(data.coreUtilityState.reminders, this.env)
        });
        return data;
      }

      if (parsed.action === "cancel") {
        const result = cancelReminderByText(data.coreUtilityState.reminders, parsed.title);
        data.coreUtilityState.reminders = result.reminders;
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: result.cancelled
            ? "Listo, cancelé el recordatorio: " + result.cancelled.title
            : "No encontré un recordatorio pendiente que coincida con: " + (parsed.title || "esa solicitud")
        });
        return data;
      }

      if (parsed.missingFields && parsed.missingFields.length) {
        const question = parsed.missingFields.includes("date")
          ? "¿Para qué fecha quieres que te lo recuerde?"
          : parsed.missingFields.includes("time")
            ? "¿A qué hora quieres que te lo recuerde?"
            : "¿Qué quieres que te recuerde?";

        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: question
        });

        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: route,
          campaignState: data.campaignState,
          pendingClarification: question
        });
        data.campaignState.history = appendHistory(data.campaignState.history, {
          role: "assistant",
          type: "TEXT",
          text: question,
          at: new Date().toISOString()
        });
        return data;
      }

      const reminder = createReminder(data.coreUtilityState.reminders, buildReminderForConversation(parsed, data, this.env, userTurn));
      data.coreUtilityState.reminders = data.coreUtilityState.reminders.concat([reminder]);
      logEvent("REMINDER_SCHEDULED", {
        traceId: userTurn && userTurn.trace_id || "",
        turnId: userTurn && userTurn.turn_id || "",
        doName: data.doName,
        reminderId: reminder.reminderId || reminder.id,
        dueAt: reminder.dueAt,
        deliveryMode: reminder.deliveryMode
      });
      await this.scheduleNextReminderAlarm(data);
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: route,
        campaignState: data.campaignState,
        lastUserGoal: reminder.title,
        pendingClarification: ""
      });

      const reminderText = formatReminderCreatedForWhatsApp(reminder, this.env);
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: reminderText
      });
      logEvent("PRIMARY_TEXT_RESPONSE_SENT_BEFORE_INTERACTIVE", {
        traceId: userTurn && userTurn.trace_id || "",
        turnId: userTurn && userTurn.turn_id || "",
        doName: data.doName,
        intent: "reminder"
      });
      await this.sendInteractiveOrText(data, {
        traceId: userTurn && userTurn.trace_id || "",
        text: "Opciones para este recordatorio:",
        fallbackText: "Opciones: Confirmar, Cambiar hora, Cancelar.",
        requiresPrimaryResponse: true,
        primaryResponseSent: true,
        buttons: [
          { id: "reminder_confirm", title: "Confirmar" },
          { id: "reminder_change_time", title: "Cambiar hora" },
          { id: "reminder_cancel", title: "Cancelar" }
        ]
      });

      return data;
    }

    if (route.intent === "list") {
      const parsed = route.parsed || {};
      const listName = resolveActiveListName(parsed, data.coreUtilityState);
      let listState = normalizeListState(data.coreUtilityState.listsState);
      let list;

      if (parsed.action === "create") {
        listState = createList(listState, listName);
        list = listItems(listState, listName);
      } else if (parsed.action === "add") {
        listState = addListItems(listState, listName, parsed.items || []);
        list = listItems(listState, listName);
      } else if (parsed.action === "remove") {
        listState = removeListItems(listState, listName, parsed.items || []);
        list = listItems(listState, listName);
      } else if (parsed.action === "mark_done") {
        listState = markListItemDone(listState, listName, parsed.items || []);
        list = listItems(listState, listName);
      } else {
        list = listItems(listState, listName);
      }

      data.coreUtilityState.listsState = listState;
      data.coreUtilityState.lists = listState.lists;
      data.coreUtilityState.activeList = listName;
      data.activeContext = updateConversationContext(data.activeContext, {
        userTurn: userTurn,
        route: route,
        campaignState: data.campaignState,
        lastUserGoal: formatListGoal(list),
        pendingClarification: ""
      });

      const listText = formatListConfirmationForWhatsApp(parsed, list, userTurn);
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        text: listText
      });
      logEvent("PRIMARY_TEXT_RESPONSE_SENT_BEFORE_INTERACTIVE", {
        traceId: userTurn && userTurn.trace_id || "",
        turnId: userTurn && userTurn.turn_id || "",
        doName: data.doName,
        intent: "list"
      });
      if (userTurn && userTurn.audio_count > 0) {
        logEvent("LIST_FROM_AUDIO_CREATED", {
          traceId: userTurn && userTurn.trace_id || "",
          turnId: userTurn && userTurn.turn_id || "",
          doName: data.doName,
          listName: list.name,
          itemCount: Array.isArray(list.items) ? list.items.length : 0
        });
      }
      await this.sendInteractiveOrText(data, {
        traceId: userTurn && userTurn.trace_id || "",
        text: "Opciones para esta lista:",
        fallbackText: "Opciones: Ver lista, Agregar más, Marcar comprado.",
        requiresPrimaryResponse: true,
        primaryResponseSent: true,
        buttons: [
          { id: "list_view", title: "Ver lista" },
          { id: "list_add_more", title: "Agregar mas" },
          { id: "list_mark_done", title: "Marcar comprado" }
        ]
      });

      return data;
    }

    return data;
  }

  async processDueReminders(data, now) {
    const next = normalizeCoordinatorData(data || {});
    const mode = getReminderDeliveryMode(this.env);
    if (mode !== "alarm") return { data: next, handled: false };

    next.coreUtilityState = normalizeCoreUtilityState(next.coreUtilityState);
    const reminders = next.coreUtilityState.reminders || [];
    let handled = false;

    for (let index = 0; index < reminders.length; index++) {
      const reminder = reminders[index];
      const dueMs = Date.parse(reminder.dueAt || "");
      if (!Number.isFinite(dueMs) || dueMs > now) continue;
      if (!String(reminder.status || "").startsWith("scheduled")) continue;

      handled = true;
      logEvent("REMINDER_DUE", {
        doName: next.doName,
        reminderId: reminder.reminderId || reminder.id,
        dueAt: reminder.dueAt
      });
      const decision = selectReminderDeliveryPath(reminder, this.env, { now: new Date(now).toISOString() });
      logEvent("REMINDER_DELIVERY_WINDOW_CHECKED", {
        doName: next.doName,
        reminderId: reminder.reminderId || reminder.id,
        within24h: decision.within24h,
        path: decision.path
      });

      if (decision.path === "session_message") {
        await sendWoztellTextMessage(this.env, {
          channelId: reminder.channelId || next.channel,
          recipientId: reminder.recipientId || next.phone,
          memberId: reminder.memberId || next.member,
          appId: reminder.appId || next.app,
          text: "Recordatorio: " + (reminder.message || reminder.title)
        });
        reminders[index] = Object.assign({}, reminder, {
          status: "sent_session_message",
          deliveredAt: new Date(now).toISOString(),
          updatedAt: new Date(now).toISOString()
        });
        logEvent("REMINDER_SENT_SESSION_MESSAGE", {
          doName: next.doName,
          reminderId: reminder.reminderId || reminder.id
        });
      } else if (decision.path === "template_message") {
        try {
          await sendWoztellTemplateMessage(this.env, {
            channelId: reminder.channelId || next.channel,
            recipientId: reminder.recipientId || next.phone,
            memberId: reminder.memberId || next.member,
            appId: reminder.appId || next.app,
            template: decision.template,
            message: reminder.message || reminder.title
          });
          reminders[index] = Object.assign({}, reminder, {
            status: "sent_template_message",
            deliveredAt: new Date(now).toISOString(),
            updatedAt: new Date(now).toISOString()
          });
          logEvent("REMINDER_TEMPLATE_SENT", {
            doName: next.doName,
            reminderId: reminder.reminderId || reminder.id,
            templateName: decision.template.name
          });
        } catch (error) {
          reminders[index] = Object.assign({}, reminder, {
            status: "template_send_failed",
            deliveryError: summarizeErrorForLog(error),
            updatedAt: new Date(now).toISOString()
          });
          logEvent("REMINDER_TEMPLATE_SEND_FAILED", {
            doName: next.doName,
            reminderId: reminder.reminderId || reminder.id,
            message: summarizeErrorForLog(error)
          }, { level: "error" });
        }
      } else {
        reminders[index] = Object.assign({}, reminder, {
          status: "blocked_template_required",
          updatedAt: new Date(now).toISOString()
        });
        logEvent("REMINDER_TEMPLATE_REQUIRED", {
          doName: next.doName,
          reminderId: reminder.reminderId || reminder.id
        });
        logEvent("REMINDER_BLOCKED_NO_TEMPLATE", {
          doName: next.doName,
          reminderId: reminder.reminderId || reminder.id
        });
      }
    }

    next.coreUtilityState.reminders = reminders;
    return { data: next, handled: handled };
  }

  async scheduleNextReminderAlarm(data) {
    const mode = getReminderDeliveryMode(this.env);
    if (mode !== "alarm") return;

    const reminders = normalizeCoreUtilityState(data && data.coreUtilityState || {}).reminders;
    const dueTimes = reminders
      .filter(function (item) { return String(item.status || "").startsWith("scheduled"); })
      .map(function (item) { return Date.parse(item.dueAt || ""); })
      .filter(function (value) { return Number.isFinite(value) && value > Date.now(); });

    if (!dueTimes.length) return;
    const nextDueAt = Math.min.apply(null, dueTimes);
    const processAfter = Number(data && data.processAfter || 0);
    await this.state.storage.setAlarm(processAfter ? Math.min(processAfter, nextDueAt) : nextDueAt);
  }

  async executePlan(data, messages, plan, userTurn) {
    const woztellPayload = buildWoztellPayloadFromData(data, messages);
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const mediaBatch = buildMediaBatch(data.campaignState, messages, {
      userTurn: userTurn,
      activeTaskAssets: userTurn && userTurn.taskMediaAssets || userTurn && userTurn.task_media_assets || []
    });
    let copyText = "";
    let ackSent = false;
    let draftSaved = false;
    let approvalDone = false;

    const hasAsyncImageAction = actions.some(function (action) {
      return action.type === "generate_image" || action.type === "edit_image";
    });

    const shouldAnalyzeUploadedImage = actions.some(function (action) {
      return action.type === "analyze_uploaded_image";
    }) || messages.some(function (message) {
      return Boolean(message.fileId) && ["IMAGE"].includes(message.type || "");
    });

    if (shouldAnalyzeUploadedImage) {
      const uploadedMediaBatch = mediaBatch && mediaBatch.assets && mediaBatch.assets.length
        ? mediaBatch
        : getUploadedMediaBatch(data.campaignState, messages, { turnId: data.currentTurnId || "" });
      if (userTurn && userTurn.images && userTurn.images.length && uploadedMediaBatch.assets.length < userTurn.images.length) {
        logEvent("LEGACY_IMAGE_SINGLE_ASSET_PATH_BLOCKED", {
          traceId: userTurn.trace_id || data.currentTraceId || "",
          turnId: userTurn.turn_id || data.currentTurnId || "",
          doName: data.doName,
          userTurnImageCount: userTurn.images.length,
          selectedImageCount: uploadedMediaBatch.assets.length,
          reason: "execute_plan_requires_user_turn_media"
        });
      }
      const imageAnalysisBatch = Object.assign({}, uploadedMediaBatch, {
        assets: (uploadedMediaBatch.assets || []).filter(function (asset) {
          return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
        })
      });

      if (!imageAnalysisBatch.assets.length) {
        if ((uploadedMediaBatch.assets || []).length) {
          console.log("MEDIA_BATCH_ANALYSIS_DONE:", JSON.stringify(buildMediaLogPayload(data, messages, buildMediaBatchSummary(uploadedMediaBatch), false)));
        } else {
        console.log("IMAGE_SOURCE_MISSING:", JSON.stringify({
          reason: "analyze_uploaded_image_without_uploaded_image",
          campaignId: data.campaignState.campaign_id
        }));

        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.uploadedImageMissing
        });

        return data;
        }
      } else {

      logEvent("MULTI_IMAGE_BATCH_ANALYSIS_STARTED", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        assetCount: imageAnalysisBatch.assets.length,
        fileIds: imageAnalysisBatch.assets.map(function (asset) { return asset.file_id; }).filter(Boolean)
      });

      const analysisResult = await analyzeMediaBatch(this.env, {
        doName: data.doName,
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        campaignState: data.campaignState,
        mediaBatch: imageAnalysisBatch,
        caption: consolidatedMessagesText(messages),
        woztellPayload: woztellPayload
      });
      logEvent("MULTI_IMAGE_BATCH_ANALYSIS_DONE", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        assetCount: analysisResult.summary && analysisResult.summary.asset_count || 0,
        analyzedAssetCount: analysisResult.summary && analysisResult.summary.analyzed_asset_count || 0,
        failedAssetCount: analysisResult.summary && analysisResult.summary.failed_asset_count || 0
      });

      data.campaignState = updateCampaignAssetsWithAnalysis(data.campaignState, analysisResult.assets);
      data.campaignState.media_batch_summary = analysisResult.summary;
      data.campaignState.uploaded_image_analysis = analysisResult.summary;
      data.campaignState.current_asset_source = "uploaded_image";

      const firstAnalyzed = analysisResult.assets.find(function (asset) {
        return asset.analysis && asset.status === "analyzed";
      });

      if (firstAnalyzed && firstAnalyzed.analysis) {
        data.campaignState.product = data.campaignState.product || firstAnalyzed.analysis.product_type || firstAnalyzed.analysis.main_subject || "";
        data.campaignState.campaign_summary = data.campaignState.campaign_summary || firstAnalyzed.analysis.marketing_notes || firstAnalyzed.analysis.recommended_angle || analysisResult.summary.summary || "";
      }

      if (analysisResult.summary.failed_asset_count && analysisResult.summary.analyzed_asset_count) {
        console.log("MEDIA_BATCH_PARTIAL_FAILURE:", JSON.stringify(buildMediaLogPayload(data, messages, analysisResult.summary, true)));
      }

      if (!analysisResult.summary.analyzed_asset_count) {
        console.log("MEDIA_BATCH_ALL_FAILED:", JSON.stringify(buildMediaLogPayload(data, messages, analysisResult.summary, true)));
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.imageAnalysisFailed
        });

        return data;
      }

      console.log("MEDIA_BATCH_ANALYSIS_DONE:", JSON.stringify(buildMediaLogPayload(data, messages, analysisResult.summary, false)));
      console.log("IMAGE_ANALYSIS_RESULT:", JSON.stringify(analysisResult.summary));
      console.log("CURRENT_ASSET_SOURCE:", data.campaignState.current_asset_source);

      if (plan.intent === "image_question" || plan.intent === "image_ocr") {
        logEvent("VISION_FINAL_RESPONSE_START", {
          traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
          turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
          doName: data.doName,
          intent: plan.intent
        });
        const text = formatVisionUtilityResponse(plan.intent, analysisResult.summary, userTurn);
        try {
          await sendConversationalResponse(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            memberId: data.member,
            appId: data.app,
            traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
            turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
            doName: data.doName,
            userTurn: userTurn,
            recentMediaAssets: data.recentMediaAssets,
            intent: plan.intent,
            text: text,
            visibleFacts: [analysisResult.summary],
            nextAction: ""
          });
          logEvent("VISION_FINAL_RESPONSE_SENT", {
            traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
            turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
            doName: data.doName,
            intent: plan.intent
          });
        } catch (error) {
          logEvent("VISION_FINAL_RESPONSE_FAILED", {
            traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
            turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
            doName: data.doName,
            message: String(error.message || error)
          }, { level: "error" });
          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: USER_MESSAGES.imageAnalysisFailed
          });
        }
        data.activeContext = updateConversationContext(data.activeContext, {
          userTurn: userTurn,
          route: { intent: plan.intent, module: "vision" },
          campaignState: data.campaignState,
          pendingClarification: buildMediaFollowupPrompt(plan.intent, analysisResult.summary),
          lastOfferedAction: inferMediaFollowupAction(plan.intent, analysisResult.summary, userTurn),
          lastOfferedIntent: plan.intent,
          lastOfferedAt: new Date().toISOString()
        });
        ackSent = true;
        return data;
      }
      }
    }

    if (plan.needs_clarification || actions.some(function (action) { return action.type === "ask_clarification"; })) {
      const question = plan.clarification_question || USER_MESSAGES.uploadedImageClarification;

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: question
      });

      data.campaignState.workflow_status = "waiting_clarification";
      data.campaignState.expected_next_target = "unknown";
      data.campaignState.history = appendHistory(data.campaignState.history, {
        role: "assistant",
        type: "TEXT",
        text: question,
        at: new Date().toISOString()
      });

      return data;
    }

    if (plan.user_facing_ack && hasAsyncImageAction) {
      logEvent("LEGACY_ORCHESTRATOR_DIRECT_REPLY_BLOCKED", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        reason: "async_image_ack_uses_customer_reply_composer"
      });
      await sendConversationalResponse(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        userTurn: userTurn,
        recentMediaAssets: data.recentMediaAssets,
        intent: plan.intent || "image_action",
        text: plan.user_facing_ack,
        visibleFacts: [],
        nextAction: ""
      });
      ackSent = true;
      data.campaignState.history = appendHistory(data.campaignState.history, {
        role: "assistant",
        type: "TEXT",
        text: plan.user_facing_ack,
        at: new Date().toISOString()
      });
    }

    for (const action of actions) {
      if (action.type === "create_content_calendar") {
        data.campaignState = createContentCalendarFromAction(data.campaignState, action, messages);
        await saveContentCalendarToSheets(this.env, data, messages);

        await sendLongTextByWoztell(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: formatContentCalendarForWhatsApp(data.campaignState.content_calendar) + "\n\n" + USER_MESSAGES.calendarReady
        });

        ackSent = true;
        draftSaved = true;
        data.campaignState.workflow_status = "calendar_pending_approval";
        data.campaignState.expected_next_target = "calendar_approval";
      }

      if (action.type === "generate_bulk_posts") {
        data.campaignState = await generateBulkPostsFromCalendar(this.env, data.campaignState, action, messages);
        await saveBulkPostsToSheets(this.env, data, messages);

        await sendLongTextByWoztell(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: formatBulkPostsForWhatsApp(data.campaignState.bulk_posts) + "\n\n" + USER_MESSAGES.bulkPostsReady
        });

        ackSent = true;
        draftSaved = true;
        data.campaignState.workflow_status = "bulk_posts_pending_approval";
        data.campaignState.expected_next_target = "bulk_approval";
      }

      if (action.type === "generate_copy") {
        copyText = await generateCopyWithOpenAI(this.env, {
          brief: action.brief || consolidatedMessagesText(messages),
          platforms: action.platforms || ["instagram"],
          messages: messages,
          conversationState: data.campaignState,
          uploaded_image_analysis: data.campaignState.uploaded_image_analysis || {},
          current_asset_source: data.campaignState.current_asset_source || "",
          campaign_state: data.campaignState
        });

        data.campaignState.last_copy = copyText;
        data.campaignState.expected_next_target = "copy";
        data.campaignState.workflow_status = "copy_ready";
        markDraftPendingReview(data.campaignState, "copy_generated");
      }

      if (action.type === "save_draft_to_sheets" && !draftSaved && (copyText || !actions.some(function (candidate) {
        return candidate.type === "generate_copy";
      }))) {
        await saveDraftToGoogleSheets(this.env, buildSheetsDraftPayload(data, messages, actions, copyText));
        draftSaved = true;
      }

      if (action.type === "request_changes") {
        if (hasBulkCampaign(data.campaignState)) {
          const selected = updateBulkPostStatuses(data.campaignState, action.post_numbers, {
            status: "draft_changes_requested",
            approval_status: "changes_requested",
            publish_status: "",
            change_request: action.brief || consolidatedMessagesText(messages)
          });

          await saveBulkPostsToSheets(this.env, data, messages);

          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: selected.length
              ? "Listo, marqué cambios solicitados para: " + selected.join(", ") + "."
              : USER_MESSAGES.changesAck
          });

          ackSent = true;
          continue;
        }

        markDraftChangesRequested(data.campaignState);

        console.log("DRAFT_CHANGES_REQUESTED:", JSON.stringify({
          campaignId: data.campaignState.campaign_id,
          draftStatus: data.campaignState.draft_status
        }));

        await updateDraftStatusInGoogleSheets(this.env, buildSheetsStatusPayload(data, messages, {
          action: "request_changes",
          status: "draft_changes_requested",
          approval_status: data.campaignState.approval_status || "",
          ready_to_publish: false
        }));

        if (!ackSent) {
          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: USER_MESSAGES.changesAck
          });
          ackSent = true;
        }
      }

      if (action.type === "approve_draft" && !approvalDone) {
        if (hasBulkCampaign(data.campaignState)) {
          const selected = updateBulkPostStatuses(data.campaignState, action.post_numbers, {
            status: "draft_approved",
            approval_status: "approved"
          });

          if ((!data.campaignState.bulk_posts || !data.campaignState.bulk_posts.length) && data.campaignState.content_calendar.length) {
            data.campaignState = await generateBulkPostsFromCalendar(this.env, data.campaignState, {
              type: "generate_bulk_posts",
              post_numbers: action.post_numbers || []
            }, messages);
            data.campaignState.bulk_posts = data.campaignState.bulk_posts.map(function (post) {
              return Object.assign({}, post, {
                status: "draft_pending_review",
                approval_status: ""
              });
            });

            await saveBulkPostsToSheets(this.env, data, messages);

            await sendLongTextByWoztell(this.env, {
              channelId: data.channel,
              recipientId: data.phone,
              text: formatBulkPostsForWhatsApp(data.campaignState.bulk_posts) + "\n\n" + USER_MESSAGES.bulkPostsReady
            });

            data.campaignState.workflow_status = "bulk_posts_pending_approval";
            data.campaignState.expected_next_target = "bulk_approval";
          } else {
            await saveBulkPostsToSheets(this.env, data, messages);

            await sendWoztellTextMessage(this.env, {
              channelId: data.channel,
              recipientId: data.phone,
              text: selected.length
                ? USER_MESSAGES.bulkApproved + "\nPosts: " + selected.join(", ")
                : USER_MESSAGES.bulkApproved
            });

            data.campaignState.workflow_status = "bulk_approved_waiting_publish_confirmation";
            data.campaignState.expected_next_target = "publish_confirmation";
          }

          approvalDone = true;
          ackSent = true;
          continue;
        }

        markDraftApproved(data.campaignState);

        await updateDraftStatusInGoogleSheets(this.env, buildSheetsStatusPayload(data, messages, {
          action: "approve_draft",
          status: "draft_approved",
          approval_status: "approved",
          publish_status: data.campaignState.publish_status || "",
          ready_to_publish: false
        }));

        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.approvedAskPublish
        });

        console.log("DRAFT_APPROVED:", JSON.stringify({
          campaignId: data.campaignState.campaign_id,
          draftStatus: data.campaignState.draft_status,
          readyToPublish: data.campaignState.ready_to_publish
        }));

        data.campaignState.expected_next_target = "unknown";
        approvalDone = true;
      }

      if (action.type === "mark_ready_to_publish") {
        if (hasBulkCampaign(data.campaignState)) {
          const selected = updateBulkPostStatuses(data.campaignState, action.post_numbers, {
            status: "ready_to_publish",
            approval_status: "approved",
            publish_status: "scheduled_pending_meta",
            ready_to_publish: true
          });

          await saveBulkPostsToSheets(this.env, data, messages);

          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: selected.length
              ? USER_MESSAGES.bulkReadyToPublish + "\nPosts: " + selected.join(", ")
              : USER_MESSAGES.bulkReadyToPublish
          });

          data.campaignState.workflow_status = "ready_to_publish";
          data.campaignState.publish_status = "scheduled_pending_meta";
          data.campaignState.ready_to_publish = true;
          approvalDone = true;
          ackSent = true;
          continue;
        }

        markDraftReadyToPublish(data.campaignState);

        await updateDraftStatusInGoogleSheets(this.env, buildSheetsStatusPayload(data, messages, {
          action: "mark_ready_to_publish",
          status: "ready_to_publish",
          approval_status: "approved",
          publish_status: "ready",
          ready_to_publish: true
        }));

        console.log("DRAFT_READY_TO_PUBLISH:", JSON.stringify({
          campaignId: data.campaignState.campaign_id,
          draftStatus: data.campaignState.draft_status,
          publishStatus: data.campaignState.publish_status
        }));

        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.readyToPublish
        });

        approvalDone = true;
      }

      if (action.type === "generate_image") {
        markDraftPendingReview(data.campaignState, "image_requested");

        if (!ackSent) {
          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: USER_MESSAGES.imageGenerationAck
          });
          ackSent = true;
        }

        await enqueueImageJob(this.env, {
          type: "generate_image",
          doName: data.doName,
          traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
          turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
          campaignId: data.campaignState.campaign_id,
          prompt: action.prompt || action.brief || consolidatedMessagesText(messages),
          source: action.source || "text_only",
          woztellPayload: woztellPayload,
          conversationState: data.campaignState,
          messages: messages
        });

        data.campaignState.workflow_status = "image_pending";
        data.campaignState.expected_next_target = "image";
      }

      if (action.type === "edit_image") {
        markDraftChangesRequested(data.campaignState);

        if (!ackSent) {
          await sendWoztellTextMessage(this.env, {
            channelId: data.channel,
            recipientId: data.phone,
            text: USER_MESSAGES.imageRevisionAck
          });
          ackSent = true;
        }

        await enqueueImageJob(this.env, {
          type: "edit_image",
          doName: data.doName,
          traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
          turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
          campaignId: data.campaignState.campaign_id,
          prompt: action.prompt || consolidatedMessagesText(messages),
          source: action.source || "last_generated_image",
          woztellPayload: woztellPayload,
          conversationState: data.campaignState,
          messages: messages
        });

        data.campaignState.workflow_status = "image_pending";
        data.campaignState.expected_next_target = "image";
      }
    }

    if (copyText && !approvalDone) {
      await sendLongTextByWoztell(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: copyText
      });

      data.campaignState.history = appendHistory(data.campaignState.history, {
        role: "assistant",
        type: "TEXT",
        text: copyText,
        at: new Date().toISOString()
      });

      if (hasAsyncImageAction) {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.imageProcessing
        });
      } else {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.draftReady
        });
      }
    }

    if (!draftSaved && actions.some(function (action) { return action.type === "save_draft_to_sheets"; })) {
      if (copyText || data.campaignState.last_copy || data.campaignState.last_image_url) {
        await saveDraftToGoogleSheets(this.env, buildSheetsDraftPayload(data, messages, actions, copyText || data.campaignState.last_copy || ""));
      }
    }

    if (!copyText && !hasAsyncImageAction && !approvalDone && !ackSent) {
      const fallbackText = plan.user_facing_ack || USER_MESSAGES.genericClarification;
      logEvent("LEGACY_ORCHESTRATOR_DIRECT_REPLY_BLOCKED", {
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        reason: "final_ack_uses_customer_reply_composer"
      });
      await sendConversationalResponse(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        memberId: data.member,
        appId: data.app,
        traceId: userTurn && userTurn.trace_id || data.currentTraceId || "",
        turnId: userTurn && userTurn.turn_id || data.currentTurnId || "",
        doName: data.doName,
        userTurn: userTurn,
        recentMediaAssets: data.recentMediaAssets,
        intent: plan.intent || "general",
        text: fallbackText,
        visibleFacts: [],
        nextAction: ""
      });
    }

    if (!approvalDone) {
      data.campaignState = normalizeCampaignState(Object.assign({}, data.campaignState, normalizeCampaignStateUpdates(plan.state_updates || {})));
      data.campaignState.updated_at = new Date().toISOString();
    }

    return data;
  }

  async getData() {
    const saved = await this.state.storage.get("data");

    if (saved) {
      return normalizeCoordinatorData(saved);
    }

    return normalizeCoordinatorData({});
  }

  async saveData(data) {
    await this.state.storage.put("data", normalizeCoordinatorData(data));
  }

  async scheduleNextAlarm(data, seconds) {
    const processAt = Date.now() + seconds * 1000;
    data.processAfter = processAt;
    await this.saveData(data);
    await this.state.storage.setAlarm(processAt);
  }
}

async function processImageQueueJob(env, job) {
  const woztellPayload = job.woztellPayload || {};
  const state = job.conversationState || {};
  const prompt = buildImagePrompt(job.prompt || "", state);
  let generatedImage;
  let publicUrl = "";

  try {
    console.log("IMAGE_PIPELINE_START:", JSON.stringify({
      type: job.type || "",
      doName: job.doName || "",
      source: job.source || "",
      channel: woztellPayload.channel || "",
      recipientId: woztellPayload.from || "",
      promptPreview: prompt.slice(0, 500)
    }));

    if (job.type === "edit_image" || job.source === "uploaded_image") {
      const sourceUrl = await resolveImageSourceUrl(env, job, state, woztellPayload);

      if (!sourceUrl) {
        console.log("IMAGE_SOURCE_MISSING:", JSON.stringify({
          type: job.type || "",
          source: job.source || "",
          campaignId: job.campaignId || "",
          hasLastUploadedImage: Boolean(getLastUploadedImage(state).fileId || getLastUploadedImage(state).url),
          hasLastGeneratedImage: Boolean(getLastImageUrlFromState(state))
        }));
        throw new Error("IMAGE_SOURCE_MISSING: cannot edit without an uploaded or generated image source");
      }

      generatedImage = await generateImageEditWithOpenAI(env, {
        prompt: prompt,
        sourceUrl: sourceUrl
      });
    } else {
      generatedImage = await generateImageWithOpenAI(env, prompt);
    }

    console.log("IMAGE_R2_UPLOAD_START:", JSON.stringify({
      mimeType: generatedImage.mimeType || "",
      byteLength: generatedImage.bytes ? generatedImage.bytes.byteLength : 0
    }));

    publicUrl = await saveGeneratedImageToR2(env, {
      bytes: generatedImage.bytes,
      mimeType: generatedImage.mimeType,
      phone: woztellPayload.from || "unknown"
    });

    console.log("IMAGE_R2_PUBLIC_URL:", publicUrl);

    await saveLastImageToKV(env, woztellPayload, {
      imageUrl: publicUrl,
      prompt: prompt,
      source: job.type
    });

    const imageSendResult = await sendWoztellImageMessage(env, {
      channelId: woztellPayload.channel,
      recipientId: woztellPayload.from,
      imageUrl: publicUrl
    });

    console.log("WOZTELL_IMAGE_SEND_OK:", JSON.stringify(imageSendResult));

    await sleep(700);

    await sendWoztellTextMessage(env, {
      channelId: woztellPayload.channel,
      recipientId: woztellPayload.from,
      text: USER_MESSAGES.imageReady
    });

    await saveDraftToGoogleSheets(env, {
      action: "save_or_update_draft",
      phone: woztellPayload.from || "",
      channel: woztellPayload.channel || "",
      channel_id: woztellPayload.channel || "",
      campaign_id: job.campaignId || "",
      message_type: job.type === "edit_image" ? "REVISED_IMAGE" : "GENERATED_IMAGE",
      status: "draft_pending_review",
      platform: "instagram,facebook",
      platforms: ["instagram", "facebook"],
      original_caption: consolidatedMessagesText(job.messages || []),
      instagram_copy: getLastCopyFromState(state),
      copy: getLastCopyFromState(state),
      facebook_copy: "",
      cta: "",
      hashtags: extractHashtags(getLastCopyFromState(state)),
      session_id: job.doName || "",
      message_id: (job.messages || []).map(function (msg) { return msg.messageId; }).join(","),
      file_id: publicUrl,
      image_url: publicUrl,
      uploaded_image_url: getLastUploadedImage(state).url || "",
      uploaded_image_analysis: state.uploaded_image_analysis || {},
      draft_version: Number(state.draft_version || 1),
      approval_status: state.approval_status || "",
      publish_status: state.publish_status || "",
      ready_to_publish: Boolean(state.ready_to_publish)
    });

  await notifyConversationDO(env, job.doName, {
    type: "image_ready",
    campaignId: job.campaignId || "",
    imageUrl: publicUrl,
    prompt: prompt
  });

    console.log("IMAGE_PIPELINE_DONE:", JSON.stringify({
      doName: job.doName || "",
      imageUrl: publicUrl
    }));
  } catch (error) {
    captureError(error, {
      stage: "processImageQueueJob",
      traceId: job.traceId || "",
      turnId: job.turnId || "",
      doName: job.doName || ""
    });
    console.error("IMAGE_PIPELINE_ERROR:", JSON.stringify({
      message: String(error.message || error),
      stack: String(error.stack || ""),
      type: job.type || "",
      doName: job.doName || "",
      imageUrl: publicUrl || ""
    }));

    if (woztellPayload.channel && woztellPayload.from) {
      await sendWoztellTextMessage(env, {
        channelId: woztellPayload.channel,
        recipientId: woztellPayload.from,
        traceId: job.traceId || "",
        turnId: job.turnId || "",
        doName: job.doName || "",
        text: USER_MESSAGES.imageFailed
      });
      logEvent("USER_FALLBACK_SENT", {
        traceId: job.traceId || "",
        turnId: job.turnId || "",
        doName: job.doName || "",
        reason: "image_pipeline_error"
      });
    }

    throw error;
  }
}

function isAudioMessage(parsedMessage) {
  const type = String(parsedMessage.type || "").toUpperCase();
  const mimeType = String(parsedMessage.mimeType || "").toLowerCase();

  return ["AUDIO", "VOICE", "PTT"].includes(type) ||
    (type === "FILE" && mimeType.startsWith("audio/"));
}

async function resolveWoztellFileUrl(env, params) {
  return await getWoztellFileInfo(env, params);
}

async function convertAudioMessageToText(env, woztellPayload, parsedMessage) {
  console.log("AUDIO_RECEIVED:", JSON.stringify({
    type: parsedMessage.type || "",
    mimeType: parsedMessage.mimeType || "",
    hasFileId: Boolean(parsedMessage.fileId),
    caption: parsedMessage.text || ""
  }));

  if (!parsedMessage.fileId) {
    throw new Error("AUDIO_FILE_ID_MISSING");
  }

  console.log("AUDIO_FILE_ID_EXTRACTED:", parsedMessage.fileId);

  const fileInfo = await resolveWoztellFileUrl(env, {
    appId: woztellPayload.app || "",
    fileId: parsedMessage.fileId
  });

  console.log("AUDIO_URL_RESOLVED:", JSON.stringify({
    fileId: parsedMessage.fileId,
    urlPreview: safeUrlPreview(fileInfo.url || ""),
    fileType: fileInfo.fileType || "",
    size: fileInfo.size || 0
  }));

  const transcript = await transcribeAudioWithOpenAI(env, fileInfo.url, {
    fileType: fileInfo.fileType || parsedMessage.mimeType || "",
    fileName: parsedMessage.fileName || "audio.ogg",
    size: fileInfo.size || 0
  });

  if (!transcript || transcript.trim().length < 2) {
    throw new Error("AUDIO_TRANSCRIPTION_EMPTY");
  }

  const cleanTranscript = cleanUserVisibleText(transcript);
  const cleanCaption = cleanUserVisibleText(parsedMessage.text || "");
  const text = [cleanTranscript, cleanCaption && cleanCaption !== cleanTranscript ? cleanCaption : ""].filter(Boolean).join("\n");

  logEvent("LEGACY_AUDIO_TEXT_PREFIX_BLOCKED", {
    messageId: parsedMessage.messageId || "",
    fileId: parsedMessage.fileId || "",
    source: "direct_audio_conversion"
  });
  logEvent("AUDIO_TRANSCRIPT_CLEANED", {
    messageId: parsedMessage.messageId || "",
    fileId: parsedMessage.fileId || "",
    textPreview: cleanTranscript.slice(0, 240),
    source: "direct_audio_conversion"
  });
  logEvent("AUDIO_TRANSCRIPT_USED_AS_USER_TEXT", {
    messageId: parsedMessage.messageId || "",
    fileId: parsedMessage.fileId || "",
    textLength: text.length,
    source: "direct_audio_conversion"
  });

  return Object.assign({}, parsedMessage, {
    type: "TEXT",
    text: text,
    audioTranscript: cleanTranscript,
    originalType: parsedMessage.type,
    originalFileId: parsedMessage.fileId,
    fileId: ""
  });
}

async function transcribeAudioWithOpenAI(env, audioUrl, metadata) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const maxAudioSeconds = getNumberEnv(env.MAX_AUDIO_SECONDS, 180);

  if (metadata && metadata.durationSeconds && Number(metadata.durationSeconds) > maxAudioSeconds) {
    throw new Error("AUDIO_TOO_LONG");
  }

  console.log("AUDIO_DOWNLOAD_START:", JSON.stringify({
    url: audioUrl,
    fileType: metadata && metadata.fileType || "",
    size: metadata && metadata.size || 0
  }));

  const audioRes = await fetchWithTimeout(audioUrl, {}, 45000, "AUDIO_DOWNLOAD_TIMEOUT");

  if (!audioRes.ok) {
    throw new Error("AUDIO_DOWNLOAD_ERROR " + audioRes.status + ": " + await audioRes.text());
  }

  const contentType = audioRes.headers.get("content-type") || metadata && metadata.fileType || "audio/ogg";
  const bytes = new Uint8Array(await audioRes.arrayBuffer());

  console.log("AUDIO_DOWNLOAD_OK:", JSON.stringify({
    contentType: contentType,
    byteLength: bytes.byteLength
  }));

  const model = getTranscriptionModel(env);

  console.log("AUDIO_TRANSCRIPTION_START:", JSON.stringify({
    model: model,
    contentType: contentType,
    byteLength: bytes.byteLength
  }));
  console.log("AUDIO_TRANSCRIPTION_MODEL:", model);

  const formData = new FormData();
  const extension = audioExtensionFromContentType(contentType);

  formData.append("model", model);
  formData.append("language", "es");
  formData.append("response_format", "json");
  formData.append("file", new Blob([bytes], { type: contentType }), "audio." + extension);

  const res = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY
    },
    body: formData
  }, 90000, "AUDIO_TRANSCRIPTION_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("AUDIO_TRANSCRIPTION_HTTP_ERROR " + res.status + ": " + responseText);
  }

  const data = parseMaybeJson(responseText);
  const transcript = String(data.text || data.transcript || "").trim();

  console.log("AUDIO_TRANSCRIPTION_RESULT:", JSON.stringify({
    textPreview: transcript.slice(0, 500),
    length: transcript.length
  }));

  return transcript;
}

function audioExtensionFromContentType(contentType) {
  const clean = String(contentType || "").toLowerCase();

  if (clean.includes("mpeg") || clean.includes("mp3")) return "mp3";
  if (clean.includes("mp4") || clean.includes("m4a")) return "m4a";
  if (clean.includes("wav")) return "wav";
  if (clean.includes("webm")) return "webm";
  if (clean.includes("ogg") || clean.includes("opus")) return "ogg";

  return "ogg";
}

function isAudioTooLongError(error) {
  return String(error && error.message || error).includes("AUDIO_TOO_LONG");
}

function isAudioEmptyError(error) {
  return String(error && error.message || error).includes("AUDIO_TRANSCRIPTION_EMPTY");
}

function summarizeErrorForLog(error) {
  return summarizeTextForLog(error && error.message || error);
}

function summarizeTextForLog(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/(OPENAI_API_KEY|ANTHROPIC_API_KEY|WOZTELL_ACCESS_TOKEN|WOZTELL_OPEN_API_TOKEN|GOOGLE_SHEETS_SECRET)=\S+/gi, "$1=[REDACTED]")
    .replace(/"Authorization"\s*:\s*"[^"]+"/gi, "\"Authorization\":\"[REDACTED]\"")
    .replace(/\b\d{8,15}\b/g, "[PHONE_REDACTED]")
    .slice(0, 500);
}

function normalizeOpenAIReasoningEffort(value, context) {
  const allowed = ["none", "low", "medium", "high", "xhigh"];
  const raw = String(value || "low").trim().toLowerCase();

  if (allowed.includes(raw)) {
    return raw;
  }

  logEvent("OPENAI_REASONING_EFFORT_NORMALIZED", {
    traceId: context && context.traceId || "",
    turnId: context && context.turnId || "",
    doName: context && context.doName || "",
    model: context && context.model || "",
    source: context && context.source || "",
    configuredValue: raw || "(empty)",
    normalizedValue: "low",
    allowedValues: allowed
  });

  return "low";
}

async function callOrchestratorPlan(env, params) {
  const provider = String(env.ORCHESTRATOR_PROVIDER || "openai").toLowerCase();
  const model = env.ORCHESTRATOR_MODEL || (provider === "openai" ? "gpt-5.4-mini" : "");
  const traceId = params && params.userTurn && params.userTurn.trace_id || "";
  const turnId = params && params.userTurn && params.userTurn.turn_id || "";

  console.log("ORCHESTRATOR_PROVIDER_SELECTED:", JSON.stringify({
    provider: provider,
    model: model,
    doName: params.doName || ""
  }));
  logEvent("ORCHESTRATOR_PROVIDER_SELECTED", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    provider: provider,
    model: model
  });
  logEvent("ORCHESTRATOR_MODEL_SELECTED", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    provider: provider,
    model: model
  });
  logEvent("ORCHESTRATOR_ENV_CHECK", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    provider: provider,
    fallbackProvider: String(env.ORCHESTRATOR_FALLBACK_PROVIDER || "").toLowerCase(),
    hasOpenAiApiKey: Boolean(env.OPENAI_API_KEY),
    hasAnthropicApiKey: Boolean(env.ANTHROPIC_API_KEY),
    hasWoztellAccessToken: Boolean(env.WOZTELL_ACCESS_TOKEN),
    hasWoztellOpenApiToken: Boolean(env.WOZTELL_OPEN_API_TOKEN)
  });

  try {
    if (provider === "openai") {
      return await openaiOrchestratorProvider(env, params);
    }

    return await claudeOrchestratorProvider(env, params);
  } catch (error) {
    const fallbackProvider = String(env.ORCHESTRATOR_FALLBACK_PROVIDER || "").toLowerCase();

    if (provider !== "claude" && fallbackProvider === "claude") {
      if (!env.ANTHROPIC_API_KEY) {
        logEvent("ORCHESTRATOR_FALLBACK_SKIPPED_MISSING_KEY", {
          traceId: traceId,
          turnId: turnId,
          doName: params.doName || "",
          fromProvider: provider,
          fallbackProvider: "claude",
          missingKey: "ANTHROPIC_API_KEY",
          originalError: summarizeErrorForLog(error)
        }, {
          level: "error",
          traceId: traceId
        });
        throw error;
      }

      logEvent("ORCHESTRATOR_FALLBACK_USED", {
        traceId: traceId,
        turnId: turnId,
        doName: params.doName || "",
        fromProvider: provider,
        fallbackProvider: "claude",
        reason: summarizeErrorForLog(error)
      }, {
        level: "error",
        traceId: traceId
      });
      return await claudeOrchestratorProvider(env, params);
    }

    throw error;
  }
}

async function claudeOrchestratorProvider(env, params) {
  return await callClaudeOrchestratorPlan(env, params);
}

async function openaiOrchestratorProvider(env, params) {
  const context = buildOrchestratorRequestContext(env, params);
  const traceId = context.userTurn.trace_id || "";
  const turnId = context.userTurn.turn_id || "";
  const model = env.ORCHESTRATOR_MODEL || "gpt-5.4-mini";
  const reasoningEffort = normalizeOpenAIReasoningEffort(env.OPENAI_REASONING_EFFORT, {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    model: model,
    source: "orchestrator"
  });

  if (!env.OPENAI_API_KEY) {
    logEvent("OPENAI_API_KEY_MISSING", {
      traceId: traceId,
      turnId: turnId,
      doName: params.doName || "",
      provider: "openai",
      model: model
    }, {
      level: "error",
      traceId: traceId
    });
    throw new Error("Missing OPENAI_API_KEY");
  }

  const payload = buildNeutralOrchestratorPayload(env, params, context);

  console.log("ORCHESTRATOR_INPUT_COMPACTED:", JSON.stringify({
    doName: params.doName || "",
    turnId: context.userTurn.turn_id,
    keys: Object.keys(context.compactInput),
    currentTurnTextLength: context.compactInput.current_turn_text.length,
    previousStateMode: context.compactInput.relevant_previous_state && context.compactInput.relevant_previous_state.note ? "omitted" : "included"
  }));
  logEvent("ORCHESTRATOR_INPUT_COMPACTED", {
    traceId: context.userTurn.trace_id || "",
    turnId: context.userTurn.turn_id,
    doName: params.doName || "",
    provider: "openai",
    keys: Object.keys(context.compactInput),
    currentTurnTextLength: context.compactInput.current_turn_text.length
  });

  logEvent("OPENAI_REQUEST_START", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    endpoint: "https://api.openai.com/v1/responses",
    model: model,
    reasoningEffort: reasoningEffort,
    inputShape: {
      compactKeys: Object.keys(context.compactInput),
      currentTurnTextLength: context.compactInput.current_turn_text.length,
      actionCount: getAllowedOrchestratorActions().length
    }
  });

  const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model,
      input: [
        {
          role: "user",
          content: JSON.stringify(payload)
        }
      ],
      reasoning: {
        effort: reasoningEffort
      },
      text: {
        verbosity: "low"
      },
      max_output_tokens: 1800
    })
  }, 45000, "OPENAI_ORCHESTRATOR_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    logEvent("OPENAI_REQUEST_FAILED", {
      traceId: traceId,
      turnId: turnId,
      doName: params.doName || "",
      model: model,
      status: res.status,
      errorSummary: summarizeTextForLog(responseText)
    }, {
      level: "error",
      traceId: traceId
    });
    throw new Error("OPENAI_ORCHESTRATOR_ERROR " + res.status + ": " + responseText);
  }

  logEvent("OPENAI_RESPONSE_RECEIVED", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    model: model,
    status: res.status,
    responseLength: responseText.length
  });

  const responseJson = parseMaybeJson(responseText);
  const text = extractOpenAIResponseText(responseJson);
  logEvent("ORCHESTRATOR_RAW_RESPONSE_SHAPE", {
    traceId: traceId,
    turnId: turnId,
    doName: params.doName || "",
    provider: "openai",
    model: model,
    hasOutputText: Boolean(responseJson && responseJson.output_text),
    outputCount: Array.isArray(responseJson && responseJson.output) ? responseJson.output.length : 0,
    extractedTextLength: String(text || "").length
  });
  console.log("ORCHESTRATOR_RAW_RESPONSE_SHAPE:", JSON.stringify({
    provider: "openai",
    model: model,
    hasOutputText: Boolean(responseJson && responseJson.output_text),
    outputCount: Array.isArray(responseJson && responseJson.output) ? responseJson.output.length : 0,
    extractedTextLength: String(text || "").length
  }));

  let parsedPlan;
  try {
    parsedPlan = parseJsonFromText(text);
  } catch (error) {
    logEvent("OPENAI_JSON_PARSE_FAILED", {
      traceId: traceId,
      turnId: turnId,
      doName: params.doName || "",
      provider: "openai",
      model: model,
      extractedTextLength: String(text || "").length,
      errorSummary: summarizeErrorForLog(error)
    }, {
      level: "error",
      traceId: traceId
    });
    throw error;
  }

  const plan = normalizePlan(parsedPlan);

  logOrchestratorPlanSelected(plan, context.userTurn, params, "openai");
  return plan;
}

async function runOpenAIDebugCheck(env, params) {
  const model = env.ORCHESTRATOR_MODEL || "gpt-5.4-mini";
  const traceId = params && params.traceId || "";
  const doName = params && params.doName || "";
  const reasoningEffort = normalizeOpenAIReasoningEffort(env.OPENAI_REASONING_EFFORT, {
    traceId: traceId,
    doName: doName,
    model: model,
    source: "debug-openai"
  });

  if (!env.OPENAI_API_KEY) {
    logEvent("OPENAI_API_KEY_MISSING", {
      traceId: traceId,
      doName: doName,
      provider: "openai",
      model: model,
      source: "debug-openai"
    }, {
      level: "error",
      traceId: traceId
    });

    return {
      ok: false,
      status: 0,
      model: model,
      reasoningEffort: reasoningEffort,
      error: "OPENAI_API_KEY_MISSING"
    };
  }

  logEvent("OPENAI_REQUEST_START", {
    traceId: traceId,
    doName: doName,
    endpoint: "https://api.openai.com/v1/responses",
    model: model,
    reasoningEffort: reasoningEffort,
    source: "debug-openai"
  });

  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        input: [
          {
            role: "user",
            content: "Return exactly this JSON: {\"ok\":true}"
          }
        ],
        reasoning: {
          effort: reasoningEffort
        },
        text: {
          verbosity: "low"
        },
        max_output_tokens: 80
      })
    }, 30000, "OPENAI_DEBUG_TIMEOUT");

    const responseText = await res.text();

    if (!res.ok) {
      logEvent("OPENAI_REQUEST_FAILED", {
        traceId: traceId,
        doName: doName,
        model: model,
        reasoningEffort: reasoningEffort,
        source: "debug-openai",
        status: res.status,
        errorSummary: summarizeTextForLog(responseText)
      }, {
        level: "error",
        traceId: traceId
      });

      return {
        ok: false,
        status: res.status,
        model: model,
        reasoningEffort: reasoningEffort,
        error: summarizeTextForLog(responseText)
      };
    }

    logEvent("OPENAI_RESPONSE_RECEIVED", {
      traceId: traceId,
      doName: doName,
      model: model,
      reasoningEffort: reasoningEffort,
      source: "debug-openai",
      status: res.status,
      responseLength: responseText.length
    });

    return {
      ok: true,
      status: res.status,
      model: model,
      reasoningEffort: reasoningEffort
    };
  } catch (error) {
    logEvent("OPENAI_REQUEST_FAILED", {
      traceId: traceId,
      doName: doName,
      model: model,
      reasoningEffort: reasoningEffort,
      source: "debug-openai",
      status: 0,
      errorSummary: summarizeErrorForLog(error)
    }, {
      level: "error",
      traceId: traceId
    });

    return {
      ok: false,
      status: 0,
      model: model,
      reasoningEffort: reasoningEffort,
      error: summarizeErrorForLog(error)
    };
  }
}

function formatOpenAIDebugForWhatsApp(diagnostic) {
  const data = diagnostic || {};

  return [
    "OpenAI debug",
    "status: " + (data.ok ? "ok" : "fail"),
    "model: " + (data.model || ""),
    "reasoning_effort: " + (data.reasoningEffort || ""),
    "http_status: " + String(data.status || 0),
    data.error ? "error: " + data.error : ""
  ].filter(Boolean).join("\n");
}

function buildOrchestratorRequestContext(env, params) {
  const userTurn = params.userTurn || buildUserTurn(params.messages || [], params.campaignState || {});
  const mediaBatch = userTurn.media_batch || buildMediaBatch(params.campaignState || {}, params.messages || []);
  const mediaBatchSummary = userTurn.media_batch_summary || buildMediaBatchSummary(mediaBatch);
  const compactInput = buildOrchestratorInput({
    messages: params.messages || [],
    campaignState: params.campaignState || {},
    userTurn: userTurn,
    conversationSummary: params.conversationSummary || null,
    userStyleProfile: params.userStyleProfile || null,
    customerMemory: params.customerMemory || null,
    utilityMemory: params.utilityMemory || null,
    activeContext: params.activeContext || null
  });
  const orchestratorInputSummary = buildOrchestratorInputSummary({
    messages: params.messages || [],
    campaignState: params.campaignState || {},
    mediaBatch: mediaBatch,
    mediaBatchSummary: mediaBatchSummary
  });

  return {
    userTurn: userTurn,
    mediaBatch: mediaBatch,
    mediaBatchSummary: mediaBatchSummary,
    compactInput: compactInput,
    orchestratorInputSummary: orchestratorInputSummary
  };
}

function buildNeutralOrchestratorPayload(env, params, context) {
  const compactInput = context.compactInput;
  const mediaBatch = context.mediaBatch;
  const mediaBatchSummary = context.mediaBatchSummary;

  return {
    instruction: [
      "Return valid JSON only. Do not answer the user directly.",
      "You are a neutral WhatsApp core orchestrator, not a marketing-only agent.",
      "First classify the user intent. Only use marketing actions when intent is marketing.",
      "If the user explicitly asks to generate, create, design or edit an image, classify intent as image_generation and use generate_image or edit_image. This is allowed even when the request is not marketing.",
      "If intent is reminder or list and core utilities are enabled, return should_handle_in_core true and no marketing actions.",
      "For general list, reminder, support, order, CRM or question requests, do not ask whether the user wants text or image.",
      "For image_question or image_ocr, use vision analysis only; do not generate marketing copy unless the user explicitly asks for a post, ad, campaign, Instagram, copy, or content calendar.",
      "If the request is unclear, ask one brief clarification question.",
      "Use the customer conversation profile: answer clear requests directly, ask one missing detail at a time, and never return a generic meta-menu for clear user intent.",
      "Never publish to Meta. Never call unavailable modules as if they were active."
    ].join(" "),
    customer_conversation_profile: getConversationPromptGuidance(),
    plan_schema: ORCHESTRATOR_PLAN_SCHEMA,
    available_intents: ["general", "marketing", "image_generation", "reminder", "list", "image_question", "image_ocr", "crm", "orders", "support", "elderly", "unknown"],
    available_actions: getAllowedOrchestratorActions(),
    action_policy: {
      marketing_actions_only_when_intent_is_marketing: true,
      image_generation_actions_allowed_when_intent_is_image_generation: true,
      non_marketing_requests_should_not_generate_copy_or_images_by_default: true,
      pass_to_agent_when_core_module_is_disabled: true
    },
    orchestrator_input: compactInput,
    current_turn_summary: compactInput.current_turn_summary,
    current_turn_text: compactInput.current_turn_text,
    client_profile: params.clientProfile || {},
    campaign_state: compactInput.campaign_state_brief,
    relevant_previous_state: compactInput.relevant_previous_state,
    active_context: compactInput.active_context,
    current_turn_media: compactInput.current_turn_media,
    previous_relevant_media: compactInput.previous_relevant_media,
    stale_media: compactInput.stale_media,
    campaign_assets: mediaBatch.assets,
    media_batch_summary: mediaBatchSummary,
    conversation_summary: compactInput.conversation_summary,
    user_style_profile: compactInput.user_style_profile,
    customer_memory: compactInput.customer_memory,
    utility_memory: compactInput.utility_memory,
    uploaded_image_analysis: mediaBatchSummary,
    current_asset_source: compactInput.campaign_state_brief.current_asset_source || "",
    asset_count: mediaBatch.assets.length,
    analyzed_asset_count: mediaBatch.analyzedAssetCount,
    failed_asset_count: mediaBatch.failedAssetCount,
    constraints: {
      no_meta_publish_yet: true,
      openai_images_quality: "low",
      copy_model: getSpecialistModel(env, "copywriter"),
      image_model: getImageGenerationModel(env)
    },
    module_notes: {
      reminders: "Core utility. Do not schedule real production reminders unless the runtime module is enabled.",
      lists: "Core utility. Handle as lists/notes, not marketing.",
      marketing: "Specialized module. Use existing marketing actions only for marketing intent.",
      crmLite: "Optional future module.",
      orders: "Optional future module.",
      support: "Optional future module.",
      elderly: "Optional future module."
    }
  };
}

function logOrchestratorPlanSelected(plan, userTurn, params, provider) {
  console.log("ORCHESTRATOR_ACTIONS_SELECTED:", JSON.stringify({
    doName: params.doName || "",
    intent: plan.intent || "",
    actions: mapOrchestratorActions(plan).map(function (action) { return action.type; })
  }));
  logEvent("ORCHESTRATOR_INTENT_DETECTED", {
    traceId: userTurn.trace_id || "",
    turnId: userTurn.turn_id,
    doName: params.doName || "",
    provider: provider || "",
    intent: plan.intent || "",
    confidence: plan.confidence || 0,
    targetModule: plan.target_module || "",
    shouldHandleInCore: Boolean(plan.should_handle_in_core)
  });
  logEvent("ORCHESTRATOR_ACTIONS_SELECTED", {
    traceId: userTurn.trace_id || "",
    turnId: userTurn.turn_id,
    doName: params.doName || "",
    actions: mapOrchestratorActions(plan).map(function (action) { return action.type; })
  });
}

async function callClaudeOrchestratorPlan(env, params) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  if (!env.CLAUDE_ORCHESTRATOR_AGENT_ID || !env.CLAUDE_ORCHESTRATOR_ENVIRONMENT_ID) {
    throw new Error("Missing Claude fallback configuration");
  }

  const sessionId = await createClaudeOrchestratorSession(env);
  const userTurn = params.userTurn || buildUserTurn(params.messages || [], params.campaignState || {});
  const mediaBatch = userTurn.media_batch || buildMediaBatch(params.campaignState || {}, params.messages || []);
  const mediaBatchSummary = userTurn.media_batch_summary || buildMediaBatchSummary(mediaBatch);
  const compactInput = buildOrchestratorInput({
    messages: params.messages || [],
    campaignState: params.campaignState || {},
    userTurn: userTurn,
    conversationSummary: params.conversationSummary || null,
    userStyleProfile: params.userStyleProfile || null,
    customerMemory: params.customerMemory || null,
    utilityMemory: params.utilityMemory || null,
    activeContext: params.activeContext || null
  });
  const orchestratorInputSummary = buildOrchestratorInputSummary({
    messages: params.messages || [],
    campaignState: params.campaignState || {},
    mediaBatch: mediaBatch,
    mediaBatchSummary: mediaBatchSummary
  });

  console.log("ORCHESTRATOR_INPUT_SUMMARY:", JSON.stringify({
    doName: params.doName || "",
    messageCount: orchestratorInputSummary.message_count,
    assetCount: orchestratorInputSummary.asset_count,
    fileIds: orchestratorInputSummary.file_ids,
    analyzedAssetCount: orchestratorInputSummary.analyzed_asset_count,
    failedAssetCount: orchestratorInputSummary.failed_asset_count,
    workflow_status: orchestratorInputSummary.workflow_status,
    campaign_type: orchestratorInputSummary.campaign_type,
    usedFallback: false
  }));
  console.log("ORCHESTRATOR_INPUT_COMPACTED:", JSON.stringify({
    doName: params.doName || "",
    turnId: userTurn.turn_id,
    keys: Object.keys(compactInput),
    currentTurnTextLength: compactInput.current_turn_text.length,
    previousStateMode: compactInput.relevant_previous_state && compactInput.relevant_previous_state.note ? "omitted" : "included"
  }));
  logEvent("ORCHESTRATOR_INPUT_COMPACTED", {
    traceId: userTurn.trace_id || "",
    turnId: userTurn.turn_id,
    doName: params.doName || "",
    keys: Object.keys(compactInput),
    currentTurnTextLength: compactInput.current_turn_text.length,
    previousStateMode: compactInput.relevant_previous_state && compactInput.relevant_previous_state.note ? "omitted" : "included",
    hasConversationSummary: Boolean(compactInput.conversation_summary),
    hasUserStyleProfile: Boolean(compactInput.user_style_profile),
    hasCustomerMemory: Boolean(compactInput.customer_memory)
  });

  const payload = {
    instruction: [
      "Return valid JSON only. Do not answer the user directly.",
      "You are a neutral WhatsApp core orchestrator, not a marketing-only agent.",
      "First classify intent as general, marketing, image_generation, reminder, list, image_question, image_ocr, crm, orders, support, elderly, or unknown.",
      "Only use marketing actions when intent is marketing.",
      "If the user explicitly asks to generate, create, design or edit an image, classify intent as image_generation and use generate_image or edit_image.",
      "Do not ask whether the user wants text or image for ordinary lists, reminders, support, orders, CRM, or general questions.",
      "Use the customer conversation profile: answer clear requests directly, ask one missing detail at a time, and never return a generic meta-menu for clear user intent.",
      "If intent is unclear, ask one brief clarification question."
    ].join(" "),
    customer_conversation_profile: getConversationPromptGuidance(),
    plan_schema: ORCHESTRATOR_PLAN_SCHEMA,
    available_intents: ["general", "marketing", "image_generation", "reminder", "list", "image_question", "image_ocr", "crm", "orders", "support", "elderly", "unknown"],
    available_actions: getAllowedOrchestratorActions(),
    action_policy: {
      marketing_actions_only_when_intent_is_marketing: true,
      image_generation_actions_allowed_when_intent_is_image_generation: true,
      non_marketing_requests_should_not_generate_copy_or_images_by_default: true
    },
    orchestrator_input: compactInput,
    current_turn_summary: compactInput.current_turn_summary,
    current_turn_text: compactInput.current_turn_text,
    client_profile: params.clientProfile || {},
    campaign_state: compactInput.campaign_state_brief,
    relevant_previous_state: compactInput.relevant_previous_state,
    active_context: compactInput.active_context,
    current_turn_media: compactInput.current_turn_media,
    previous_relevant_media: compactInput.previous_relevant_media,
    stale_media: compactInput.stale_media,
    campaign_assets: mediaBatch.assets,
    media_batch_summary: mediaBatchSummary,
    conversation_summary: compactInput.conversation_summary,
    user_style_profile: compactInput.user_style_profile,
    customer_memory: compactInput.customer_memory,
    utility_memory: compactInput.utility_memory,
    uploaded_image_analysis: mediaBatchSummary,
    current_asset_source: compactInput.campaign_state_brief.current_asset_source || "",
    asset_count: mediaBatch.assets.length,
    analyzed_asset_count: mediaBatch.analyzedAssetCount,
    failed_asset_count: mediaBatch.failedAssetCount,
    orchestrator_input_summary: orchestratorInputSummary,
    conversation_state: {
      client_profile: params.clientProfile || {},
      campaign_state: compactInput.campaign_state_brief
    },
    lastCopy: compactInput.relevant_previous_state.last_copy || "",
    lastImageUrl: compactInput.relevant_previous_state.last_image_url || "",
    lastUploadedImage: params.campaignState && params.campaignState.last_uploaded_image || null,
    uploadedImageAnalysis: params.campaignState && params.campaignState.uploaded_image_analysis || mediaBatchSummary,
    currentAssetSource: params.campaignState && params.campaignState.current_asset_source || "",
    uploaded_image_rules: [
      "The orchestrator must not analyze image pixels directly.",
      "Media is always an array. Use campaign_assets and media_batch_summary as the source of truth for uploaded images.",
      "last_uploaded_image exists only for compatibility and may represent the latest item, not the full visual context.",
      "If asset_count is greater than 1, treat uploaded images as a batch and reason from media_batch_summary.",
      "If the user asks for copy based on uploaded image assets, actions must include analyze_uploaded_image before generate_copy.",
      "If the user asks to design/edit using uploaded image assets, actions must include analyze_uploaded_image before edit_image and edit_image.source must be uploaded_image.",
      "If the user asks for both copy and design with uploaded image assets, include analyze_uploaded_image, edit_image with source uploaded_image, and generate_copy.",
      "If the user uploaded an image without clear instructions, ask: ¿Quieres que use esta imagen solo como base para el copy, o también quieres que la convierta en un diseño para Instagram?",
      "If the user uploaded multiple images without clear instructions, ask if they should be used for posts, a calendar, or visual reference.",
      "If the user gives a clear instruction with multiple images, use campaign_type bulk_from_assets and choose create_content_calendar or generate_bulk_posts as appropriate.",
      "Use last_generated_image only when the user asks to edit the latest generated image or make another version of the image the assistant created."
    ],
    draft_rules: [
      "If the user approves content, use approve_draft. Do not publish.",
      "If the user says listo para publicar, publicar ahora, queda listo, or confirms publishing after approval, use mark_ready_to_publish.",
      "If the user asks for changes after approval, use request_changes plus the needed generation/edit actions.",
      "Never return action published. Meta API is not implemented yet.",
      "Audio transcripts are normal text instructions."
    ],
    bulk_calendar_rules: [
      "If the user asks for 3 or more posts, a weekly plan, a monthly plan, or content planning, use create_content_calendar first.",
      "Use campaign_type weekly_content_plan for this week or 5-7 posts, monthly_content_plan for monthly requests, and bulk_from_assets when multiple uploaded images are the source.",
      "If the user approves the calendar, use generate_bulk_posts.",
      "If the user says aprueba todos, approve all calendar or bulk posts.",
      "If the user says aprueba el 1 y 2, use approve_draft with post_numbers [1,2].",
      "If the user says cambia el 3 or haz mas premium el 5, use request_changes with post_numbers and a brief.",
      "If the user says listo para publicar todos, use mark_ready_to_publish for all posts. Do not publish to Meta."
    ],
    constraints: {
      no_meta_publish_yet: true,
      openai_images_quality: "low",
      copy_model: getSpecialistModel(env, "copywriter"),
      image_model: getImageGenerationModel(env)
    }
  };

  const text = await sendTextToClaudeSession(env, {
    sessionId: sessionId,
    text: JSON.stringify(payload)
  });

  console.log("ORCHESTRATOR_RAW_TEXT:", String(text || "").slice(0, 3000));

  const plan = normalizePlan(parseJsonFromText(text));

  logOrchestratorPlanSelected(plan, userTurn, params, "claude");

  return plan;
}

const ORCHESTRATOR_PLAN_SCHEMA = {
  intent: "general",
  confidence: 0,
  should_handle_in_core: false,
  target_module: "core",
  needs_clarification: false,
  clarification_question: "",
  user_facing_ack: "",
  actions: [
    {
    type: "generate_copy",
    brief: "",
    platforms: ["instagram"],
    use_uploaded_image: false
    },
    {
      type: "generate_image",
      prompt: "",
      source: "text_only"
    },
    {
      type: "edit_image",
      prompt: "",
      source: "uploaded_image"
    },
    {
      type: "create_content_calendar",
      campaign_type: "weekly_content_plan",
      post_count: 5,
      platforms: ["instagram", "facebook"],
      calendar_items: []
    },
    {
      type: "generate_bulk_posts",
      post_numbers: []
    },
    {
      type: "mark_ready_to_publish"
    },
    {
      type: "request_changes"
    }
  ],
  final_response_mode: "send_copy_only",
  state_updates: {
    active_topic: "",
    expected_next_target: "copy",
    workflow_status: "waiting_user_review"
  }
};

async function createClaudeOrchestratorSession(env) {
  const res = await anthropicFetch("https://api.anthropic.com/v1/sessions", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      agent: {
        type: "agent",
        id: env.CLAUDE_ORCHESTRATOR_AGENT_ID
      },
      environment_id: env.CLAUDE_ORCHESTRATOR_ENVIRONMENT_ID
    })
  }, 30000);

  if (!res.ok) {
    throw new Error("CLAUDE_ORCHESTRATOR_CREATE_SESSION_ERROR " + res.status + ": " + await res.text());
  }

  const data = await res.json();
  return data.id;
}

async function sendTextToClaudeSession(env, params) {
  const streamPromise = anthropicFetch(
    "https://api.anthropic.com/v1/sessions/" + params.sessionId + "/events/stream",
    {
      method: "GET",
      headers: anthropicHeaders(env)
    },
    60000
  );

  const eventRes = await anthropicFetch("https://api.anthropic.com/v1/sessions/" + params.sessionId + "/events", {
    method: "POST",
    headers: anthropicHeaders(env),
    body: JSON.stringify({
      events: [
        {
          type: "user.message",
          content: [
            {
              type: "text",
              text: params.text
            }
          ]
        }
      ]
    })
  }, 30000);

  if (!eventRes.ok) {
    throw new Error("CLAUDE_ORCHESTRATOR_EVENT_ERROR " + eventRes.status + ": " + await eventRes.text());
  }

  const streamRes = await streamPromise;

  if (!streamRes.ok) {
    throw new Error("CLAUDE_ORCHESTRATOR_STREAM_ERROR " + streamRes.status + ": " + await streamRes.text());
  }

  return await readClaudeStreamText(streamRes, 55000);
}

function anthropicHeaders(env) {
  return {
    "Content-Type": "application/json",
    "x-api-key": env.ANTHROPIC_API_KEY,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "managed-agents-2026-04-01"
  };
}

async function anthropicFetch(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    controller.abort("timeout");
  }, timeoutMs || 60000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readClaudeStreamText(streamRes, timeoutMs) {
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalText = "";
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const result = await reader.read();

    if (result.done) break;

    buffer += decoder.decode(result.value, { stream: true });

    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const events = parseSSEChunk(chunk);

      for (const event of events) {
        console.log("CLAUDE_STREAM_EVENT_TYPE:", event.type || "");

        const text = extractTextFromClaudeEvent(event);

        if (text) {
          console.log("CLAUDE_AGENT_TEXT_EXTRACTED:", text.slice(0, 500));
          finalText += text;
        }
      }
    }
  }

  return finalText.trim();
}

function parseSSEChunk(chunk) {
  return chunk
    .split("\n")
    .filter(function (line) { return line.startsWith("data:"); })
    .map(function (line) { return line.replace(/^data:\s*/, ""); })
    .map(function (text) {
      try {
        return JSON.parse(text);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function extractTextFromClaudeEvent(event) {
  if (!event) return "";

  if (event.type === "user.message") {
    return "";
  }

  const allowedTypes = [
    "agent.message",
    "agent.message.delta",
    "content_block_delta"
  ];

  if (!allowedTypes.includes(event.type)) {
    return "";
  }

  if (typeof event.text === "string") {
    return event.text;
  }

  if (event.delta && typeof event.delta.text === "string") {
    return event.delta.text;
  }

  if (event.delta && event.delta.type === "text_delta" && typeof event.delta.text === "string") {
    return event.delta.text;
  }

  if (event.message && typeof event.message.text === "string") {
    return event.message.text;
  }

  if (event.message && Array.isArray(event.message.content)) {
    return event.message.content.map(function (block) {
      return block && typeof block.text === "string" ? block.text : "";
    }).join("");
  }

  if (Array.isArray(event.content)) {
    return event.content.map(function (block) {
      return block && typeof block.text === "string" ? block.text : "";
    }).join("");
  }

  return "";
}

function parseJsonFromText(text) {
  const clean = String(text || "").trim();

  try {
    const direct = JSON.parse(clean);

    if (isOrchestratorPlanShape(direct)) {
      return direct;
    }
  } catch (error) {
    // Fall through to block/object extraction.
  }

  const fencedPlans = extractJsonCodeBlocks(clean)
    .map(function (block) {
      try {
        return JSON.parse(block);
      } catch (error) {
        console.error("ORCHESTRATOR_FENCED_JSON_PARSE_ERROR:", String(error.message || error));
        return null;
      }
    })
    .filter(isOrchestratorPlanShape);

  if (fencedPlans.length > 0) {
    return fencedPlans[fencedPlans.length - 1];
  }

  const balancedPlans = extractBalancedJsonObjects(clean)
    .map(function (objectText) {
      try {
        return JSON.parse(objectText);
      } catch (error) {
        console.error("ORCHESTRATOR_BALANCED_JSON_PARSE_ERROR:", String(error.message || error));
        return null;
      }
    })
    .filter(isOrchestratorPlanShape);

  if (balancedPlans.length > 0) {
    return balancedPlans[balancedPlans.length - 1];
  }

  logEvent("ORCHESTRATOR_JSON_INVALID", {
    textLength: clean.length,
    startsWithJsonObject: clean.startsWith("{"),
    startsWithJsonFence: clean.startsWith("```")
  }, {
    level: "error"
  });
  throw new Error("ORCHESTRATOR_PLAN_NOT_JSON: " + clean.slice(0, 1000));
}

function extractJsonCodeBlocks(text) {
  const value = String(text || "");
  const blocks = [];
  let cursor = 0;

  while (cursor < value.length) {
    const fenceStart = value.indexOf("```", cursor);

    if (fenceStart === -1) break;

    const headerEnd = value.indexOf("\n", fenceStart + 3);

    if (headerEnd === -1) break;

    const header = value.slice(fenceStart + 3, headerEnd).trim().toLowerCase();
    const fenceEnd = value.indexOf("```", headerEnd + 1);

    if (fenceEnd === -1) break;

    if (header === "json" || header.startsWith("json ")) {
      blocks.push(value.slice(headerEnd + 1, fenceEnd).trim());
    }

    cursor = fenceEnd + 3;
  }

  return blocks;
}

function extractBalancedJsonObjects(text) {
  const value = String(text || "");
  const objects = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (start === -1) {
      if (char === "{") {
        start = i;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        objects.push(value.slice(start, i + 1));
        start = -1;
        inString = false;
        escaped = false;
      }
    }
  }

  return objects;
}

function isOrchestratorPlanShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "instruction") ||
    Object.prototype.hasOwnProperty.call(value, "plan_schema") ||
    Object.prototype.hasOwnProperty.call(value, "available_actions")
  ) {
    return false;
  }

  return Object.prototype.hasOwnProperty.call(value, "needs_clarification") &&
    Object.prototype.hasOwnProperty.call(value, "actions") &&
    Object.prototype.hasOwnProperty.call(value, "state_updates") &&
    (
      Object.prototype.hasOwnProperty.call(value, "final_response_mode") ||
      Object.prototype.hasOwnProperty.call(value, "intent")
    );
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.actions)) {
    throw new Error("ORCHESTRATOR_PLAN_INVALID_SHAPE");
  }

  const allowedActions = [
    "generate_copy",
    "generate_image",
    "edit_image",
    "analyze_uploaded_image",
    "save_draft_to_sheets",
    "create_content_calendar",
    "generate_bulk_posts",
    "approve_draft",
    "mark_ready_to_publish",
    "request_changes",
    "ask_clarification"
  ];

  const intent = normalizeOrchestratorIntent(plan.intent || "");
  const actions = Array.isArray(plan.actions)
    ? plan.actions.filter(function (action) {
      if (!action || !allowedActions.includes(action.type)) return false;
      if ((intent === "image_question" || intent === "image_ocr") && action.type === "analyze_uploaded_image") return true;
      if (intent === "image_generation" && ["generate_image", "edit_image", "analyze_uploaded_image"].includes(action.type)) return true;
      if (intent && intent !== "marketing" && action.type !== "ask_clarification") return false;
      return true;
    }).map(function (action) {
      return {
        type: action.type,
        brief: String(action.brief || ""),
        prompt: String(action.prompt || ""),
        source: String(action.source || ""),
        platforms: Array.isArray(action.platforms) ? action.platforms.map(String) : [],
        use_uploaded_image: Boolean(action.use_uploaded_image),
        campaign_type: normalizeCampaignType(action.campaign_type || action.campaignType || ""),
        post_count: Number(action.post_count || action.postCount || 0),
        post_numbers: Array.isArray(action.post_numbers || action.postNumbers)
          ? (action.post_numbers || action.postNumbers).map(Number).filter(function (num) { return Number.isFinite(num) && num > 0; })
          : [],
        calendar_items: Array.isArray(action.calendar_items || action.calendarItems)
          ? normalizeContentCalendar(action.calendar_items || action.calendarItems)
          : []
      };
    })
    : [];

  return {
    intent: intent || "unknown",
    confidence: clampConfidence(plan.confidence),
    should_handle_in_core: Boolean(plan.should_handle_in_core),
    target_module: normalizeTargetModule(plan.target_module || plan.targetModule || ""),
    needs_clarification: Boolean(plan.needs_clarification),
    clarification_question: String(plan.clarification_question || ""),
    user_facing_ack: String(plan.user_facing_ack || ""),
    actions: actions,
    final_response_mode: String(plan.final_response_mode || "send_copy_only"),
    state_updates: typeof plan.state_updates === "object" && plan.state_updates ? plan.state_updates : {}
  };
}

function normalizeOrchestratorIntent(intent) {
  const clean = String(intent || "").trim();
  const allowed = ["general", "marketing", "image_generation", "reminder", "list", "image_question", "image_ocr", "crm", "orders", "support", "elderly", "unknown"];
  return allowed.includes(clean) ? clean : "unknown";
}

function normalizeTargetModule(moduleName) {
  const clean = String(moduleName || "").trim();
  const allowed = ["core", "marketing", "image_generation", "vision", "reminders", "lists", "crmLite", "orders", "support", "elderly"];
  return allowed.includes(clean) ? clean : "core";
}

function clampConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

async function generateCopyWithOpenAI(env, params) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const model = getSpecialistModel(env, "copywriter");
  const reasoningEffort = normalizeOpenAIReasoningEffort(env.OPENAI_REASONING_EFFORT, {
    model: model,
    source: "copy"
  });
  const visualAnalysis = params.uploaded_image_analysis || params.campaign_state && params.campaign_state.uploaded_image_analysis || {};
  const hasVisualAnalysis = visualAnalysis && typeof visualAnalysis === "object" && Object.keys(visualAnalysis).length > 0;

  if (hasVisualAnalysis) {
    console.log("USING_UPLOADED_IMAGE_FOR_COPY:", JSON.stringify({
      main_subject: visualAnalysis.main_subject || "",
      product_type: visualAnalysis.product_type || "",
      confidence: visualAnalysis.confidence || 0
    }));
  }

  const prompt = [
    "Eres el copywriter de Yishido para WhatsApp.",
    "Redacta SOLO el texto final que se enviara al usuario.",
    "No generes imagenes. No digas que no puedes generar imagenes.",
    "Si el usuario pidio modificar texto previo, modifica ese texto.",
    "Usa el idioma del usuario.",
    "Hazlo claro, comercial y listo para publicar.",
    "",
    "Brief:",
    params.brief || "",
    "",
    "Mensajes consolidados:",
    consolidatedMessagesText(params.messages || []),
    "",
    "Ultimo copy disponible:",
    params.conversationState && (params.conversationState.last_copy || params.conversationState.lastCopy) || "",
    "",
    "Fuente de activo actual:",
    params.current_asset_source || params.campaign_state && params.campaign_state.current_asset_source || "",
    "",
    "Analisis visual de imagen subida:",
    hasVisualAnalysis ? JSON.stringify(visualAnalysis, null, 2) : "No hay analisis visual disponible.",
    "",
    "Instrucciones para usar el analisis visual:",
    "- Si hay analisis visual, basa el copy en lo que realmente aparece en la imagen.",
    "- Usa producto detectado, texto visible, colores, estilo, marketing_notes y recommended_angle.",
    "- Si hay warnings, evita afirmar cosas dudosas.",
    "- No uses contexto de campanas anteriores si contradice el analisis visual."
  ].join("\n");

  const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model,
      input: [
        {
          role: "user",
          content: prompt
        }
      ],
      reasoning: {
        effort: reasoningEffort
      },
      text: {
        verbosity: "medium"
      },
      max_output_tokens: 1600
    })
  }, 30000, "OPENAI_COPY_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("OPENAI_COPY_ERROR " + res.status + ": " + responseText);
  }

  const data = JSON.parse(responseText);
  const output = extractOpenAIResponseText(data);

  if (!output) {
    throw new Error("OPENAI_COPY_EMPTY_OUTPUT: " + responseText);
  }

  return output.trim();
}

async function analyzeUploadedImageWithOpenAI(env, params) {
  const uploadedImage = params.uploadedImage || {};
  let imageUrl = uploadedImage.url || "";

  if (!imageUrl && uploadedImage.fileId) {
    const fileInfo = await getWoztellFileInfo(env, {
      appId: uploadedImage.app || params.woztellPayload && params.woztellPayload.app || "",
      fileId: uploadedImage.fileId
    });
    imageUrl = fileInfo.url || "";
  }

  if (!imageUrl) {
    console.log("IMAGE_SOURCE_MISSING:", JSON.stringify({
      reason: "vision_analysis_missing_uploaded_image_url",
      fileId: uploadedImage.fileId || ""
    }));
    throw new Error("IMAGE_SOURCE_MISSING: uploaded image URL not available");
  }

  console.log("IMAGE_ANALYSIS_START:", JSON.stringify({
    imageUrlPreview: safeUrlPreview(imageUrl),
    captionPreview: String(params.caption || "").slice(0, 500)
  }));

  const primaryModel = getVisionModel(env);
  const fallbackModel = getVisionModel(Object.assign({}, env, {
    VISION_MODEL: env.VISION_FALLBACK_MODEL || env.VISION_MODEL
  }));

  try {
    const primary = await callVisionModel(env, {
      model: primaryModel,
      imageUrl: imageUrl,
      caption: params.caption || ""
    });

    if (primary && Number(primary.confidence || 0) >= 0.65) {
      return primary;
    }

    console.log("IMAGE_ANALYSIS_FALLBACK_USED:", JSON.stringify({
      reason: "primary_low_confidence_or_empty",
      primaryConfidence: primary && primary.confidence || 0,
      fallbackModel: fallbackModel
    }));

    const fallback = await callVisionModel(env, {
      model: fallbackModel,
      imageUrl: imageUrl,
      caption: params.caption || ""
    });

    if (fallback && Number(fallback.confidence || 0) > 0) {
      return fallback;
    }

    throw new Error("Vision fallback returned empty or zero-confidence analysis");
  } catch (error) {
    console.error("IMAGE_ANALYSIS_ERROR:", JSON.stringify({
      model: primaryModel,
      message: String(error.message || error)
    }));

    console.log("IMAGE_ANALYSIS_FALLBACK_USED:", JSON.stringify({
      reason: "primary_error",
      fallbackModel: fallbackModel
    }));

    const fallback = await callVisionModel(env, {
      model: fallbackModel,
      imageUrl: imageUrl,
      caption: params.caption || ""
    });

    if (!fallback || Number(fallback.confidence || 0) <= 0) {
      throw new Error("Vision fallback returned empty or zero-confidence analysis");
    }

    return fallback;
  }
}

async function callVisionModel(env, params) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  console.log("IMAGE_ANALYSIS_MODEL:", params.model);

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      main_subject: { type: "string" },
      product_type: { type: "string" },
      visible_text: { type: "string" },
      brand_or_labels: { type: "string" },
      colors: {
        type: "array",
        items: { type: "string" }
      },
      style: { type: "string" },
      objects_detected: {
        type: "array",
        items: { type: "string" }
      },
      marketing_notes: { type: "string" },
      possible_use_cases: {
        type: "array",
        items: { type: "string" }
      },
      recommended_angle: { type: "string" },
      warnings: {
        type: "array",
        items: { type: "string" }
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      }
    },
    required: [
      "main_subject",
      "product_type",
      "visible_text",
      "brand_or_labels",
      "colors",
      "style",
      "objects_detected",
      "marketing_notes",
      "possible_use_cases",
      "recommended_angle",
      "warnings",
      "confidence"
    ]
  };

  let requestBody = buildVisionRequestBody({
    model: params.model,
    imageUrl: params.imageUrl,
    caption: params.caption || "",
    schema: schema,
    useJsonSchema: true
  });

  let visionResponse = await sendVisionRequest(env, requestBody);

  if (!visionResponse.ok && isVisionSchemaConfigError(visionResponse.responseText)) {
    console.log("VISION_SCHEMA_UNSUPPORTED_RETRY_PLAIN_JSON:", JSON.stringify({
      model: params.model,
      status: visionResponse.status
    }));

    requestBody = buildVisionRequestBody({
      model: params.model,
      imageUrl: params.imageUrl,
      caption: params.caption || "",
      schema: schema,
      useJsonSchema: false
    });

    visionResponse = await sendVisionRequest(env, requestBody);
  }

  if (!visionResponse.ok) {
    throw new Error("VISION_ANALYSIS_ERROR " + visionResponse.status + ": " + visionResponse.responseText);
  }

  const data = JSON.parse(visionResponse.responseText);
  const output = extractOpenAIResponseText(data);

  console.log("VISION_RAW_OUTPUT:", JSON.stringify(summarizeVisionTextForLog(output)));

  if (!output) {
    throw new Error("VISION_ANALYSIS_EMPTY_OUTPUT: " + responseText);
  }

  const parsed = parseVisionAnalysisJson(output);

  console.log("VISION_PARSED_JSON:", JSON.stringify(summarizeVisionAnalysisForLog(parsed)));

  console.log("IMAGE_ANALYSIS_RESULT:", JSON.stringify({
    model: params.model,
    confidence: parsed.confidence,
    main_subject: parsed.main_subject,
    product_type: parsed.product_type
  }));

  return parsed;
}

function safeUrlPreview(value) {
  const raw = String(value || "");
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    return parsed.protocol + "//" + parsed.hostname + "/... length=" + raw.length;
  } catch (error) {
    const head = raw.slice(0, 12);
    return head + (raw.length > 12 ? "***" : "") + " length=" + raw.length;
  }
}

function summarizeVisionTextForLog(text) {
  const raw = String(text || "");

  return {
    textLength: raw.length,
    startsWithJson: raw.trim().startsWith("{"),
    preview: redactSensitiveLogText(raw.slice(0, 240))
  };
}

function summarizeVisionAnalysisForLog(analysis) {
  const clean = analysis && typeof analysis === "object" ? analysis : {};

  return {
    main_subject: redactSensitiveLogText(String(clean.main_subject || "").slice(0, 160)),
    product_type: redactSensitiveLogText(String(clean.product_type || "").slice(0, 120)),
    visible_text_length: String(clean.visible_text || "").length,
    brand_or_labels_length: String(clean.brand_or_labels || "").length,
    color_count: Array.isArray(clean.colors) ? clean.colors.length : 0,
    object_count: Array.isArray(clean.objects_detected) ? clean.objects_detected.length : 0,
    warning_count: Array.isArray(clean.warnings) ? clean.warnings.length : 0,
    confidence: Number(clean.confidence || 0)
  };
}

function redactSensitiveLogText(text) {
  return String(text || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/\b\d{4,}\b/g, "[NUM]")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[URL]");
}

function buildVisionRequestBody(params) {
  const promptText = [
    "Analiza esta imagen para un asistente general de WhatsApp.",
    "Devuelve solo JSON estructurado.",
    "Identifica el sujeto principal, texto visible, marcas, colores, estilo, objetos y posibles usos.",
    "Si el usuario pide OCR, prioriza visible_text. Si pregunta como funciona algo, describe solo lo visible y marca incertidumbre en warnings.",
    "Incluye marketing_notes solo si la imagen o el caption sugieren un uso comercial o de contenido.",
    "No inventes datos no visibles. Si algo no se ve, dejalo vacio o agregalo en warnings.",
    "El JSON debe tener estas llaves exactas:",
    "main_subject, product_type, visible_text, brand_or_labels, colors, style, objects_detected, marketing_notes, possible_use_cases, recommended_angle, warnings, confidence.",
    "confidence debe ser un numero entre 0 y 1.",
    "",
    "Caption/contexto del usuario:",
    params.caption || ""
  ].join("\n");

  const body = {
    model: params.model,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: promptText
          },
          {
            type: "input_image",
            image_url: params.imageUrl
          }
        ]
      }
    ],
    max_output_tokens: 2400
  };

  if (params.useJsonSchema) {
    body.text = {
      format: {
        type: "json_schema",
        name: "uploaded_image_analysis",
        strict: true,
        schema: params.schema
      }
    };
  }

  return body;
}

async function sendVisionRequest(env, requestBody) {
  console.log("VISION_CONFIG_USED:", JSON.stringify({
    model: requestBody.model,
    hasJsonSchema: Boolean(requestBody.text && requestBody.text.format),
    verbosity: requestBody.text && requestBody.text.verbosity || "not_set",
    imageUrlPreview: safeUrlPreview(requestBody.input[0].content[1].image_url),
    maxOutputTokens: requestBody.max_output_tokens
  }));

  console.log("VISION_REQUEST_BODY_PREVIEW:", JSON.stringify({
    model: requestBody.model,
    text: requestBody.text || null,
    inputPreview: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            textPreview: requestBody.input[0].content[0].text.slice(0, 500)
          },
          {
            type: "input_image",
            image_url: safeUrlPreview(requestBody.input[0].content[1].image_url)
          }
        ]
      }
    ],
    max_output_tokens: requestBody.max_output_tokens
  }));

  const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  }, 45000, "VISION_ANALYSIS_TIMEOUT");

  const responseText = await res.text();

  console.log("VISION_RESPONSE_STATUS:", String(res.status));

  return {
    ok: res.ok,
    status: res.status,
    responseText: responseText
  };
}

function isVisionSchemaConfigError(responseText) {
  const text = String(responseText || "").toLowerCase();

  return text.includes("json_schema") ||
    text.includes("text.format") ||
    text.includes("response_format") ||
    text.includes("unsupported") && text.includes("schema");
}

function parseVisionAnalysisJson(text) {
  const clean = String(text || "").trim();
  const candidates = [];

  try {
    candidates.push(JSON.parse(clean));
  } catch (error) {
    // Continue with balanced extraction.
  }

  const fencedBlocks = extractJsonCodeBlocks(clean);

  for (const blockText of fencedBlocks) {
    try {
      candidates.push(JSON.parse(blockText));
    } catch (error) {
      console.error("IMAGE_ANALYSIS_INVALID_JSON:", JSON.stringify({
        reason: "fenced_json_parse_error",
        message: String(error.message || error),
        preview: blockText.slice(0, 500)
      }));
    }
  }

  const balancedObjects = extractBalancedJsonObjects(clean);

  for (const objectText of balancedObjects) {
    try {
      candidates.push(JSON.parse(objectText));
    } catch (error) {
      console.error("IMAGE_ANALYSIS_INVALID_JSON:", JSON.stringify({
        reason: "balanced_object_parse_error",
        message: String(error.message || error),
        preview: objectText.slice(0, 500)
      }));
    }
  }

  for (let i = candidates.length - 1; i >= 0; i--) {
    const candidate = normalizeVisionAnalysis(candidates[i]);

    if (isVisionAnalysisShape(candidate)) {
      return candidate;
    }
  }

  console.error("IMAGE_ANALYSIS_INVALID_JSON:", JSON.stringify({
    reason: "no_valid_analysis_shape",
    preview: clean.slice(0, 1000)
  }));

  throw new Error("IMAGE_ANALYSIS_INVALID_JSON");
}

function normalizeVisionAnalysis(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const confidence = Object.prototype.hasOwnProperty.call(value, "confidence")
    ? Number(value.confidence)
    : 0.5;

  return {
    main_subject: String(value.main_subject || ""),
    product_type: String(value.product_type || ""),
    visible_text: String(value.visible_text || ""),
    brand_or_labels: String(value.brand_or_labels || ""),
    colors: Array.isArray(value.colors) ? value.colors.map(String) : [],
    style: String(value.style || ""),
    objects_detected: Array.isArray(value.objects_detected) ? value.objects_detected.map(String) : [],
    marketing_notes: String(value.marketing_notes || ""),
    possible_use_cases: Array.isArray(value.possible_use_cases) ? value.possible_use_cases.map(String) : [],
    recommended_angle: String(value.recommended_angle || ""),
    warnings: Array.isArray(value.warnings) ? value.warnings.map(String) : [],
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5
  };
}

function isVisionAnalysisShape(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, "main_subject") &&
    Object.prototype.hasOwnProperty.call(value, "product_type") &&
    Object.prototype.hasOwnProperty.call(value, "confidence")
  );
}

function extractOpenAIResponseText(data) {
  if (data.output_text) return data.output_text;

  if (Array.isArray(data.output)) {
    let text = "";

    for (const item of data.output) {
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (typeof content.text === "string") text += content.text;
          if (typeof content.output_text === "string") text += content.output_text;
        }
      }
    }

    return text.trim();
  }

  return "";
}

async function generateImageWithOpenAI(env, prompt) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const model = getImageGenerationModel(env);
  const requestBody = {
    model: model,
    prompt: prompt,
    size: "1024x1024",
    quality: "low"
  };

  console.log("IMAGE_OPENAI_REQUEST:", JSON.stringify({
    endpoint: "images/generations",
    model: model,
    size: requestBody.size,
    quality: requestBody.quality,
    promptPreview: prompt.slice(0, 500)
  }));

  const res = await fetchWithTimeout("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  }, 90000, "OPENAI_IMAGE_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    console.error("IMAGE_OPENAI_RESPONSE_ERROR:", JSON.stringify({
      status: res.status,
      body: responseText.slice(0, 2000)
    }));
    throw new Error("OPENAI_IMAGE_ERROR " + res.status + ": " + responseText);
  }

  console.log("IMAGE_OPENAI_RESPONSE_OK:", JSON.stringify({
    status: res.status,
    bodyPreview: responseText.slice(0, 500)
  }));

  return await parseOpenAIImageResponse(responseText);
}

async function generateImageEditWithOpenAI(env, params) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const source = await downloadImageBytes(params.sourceUrl);
  const formData = new FormData();
  const model = getImageGenerationModel(env);

  formData.append("model", model);
  formData.append("prompt", params.prompt);
  formData.append("size", "1024x1024");
  formData.append("quality", "low");
  formData.append("image", new Blob([source.bytes], { type: source.mediaType }), "source." + source.extension);

  console.log("IMAGE_OPENAI_REQUEST:", JSON.stringify({
    endpoint: "images/edits",
    model: model,
    size: "1024x1024",
    quality: "low",
    sourceMediaType: source.mediaType,
    sourceBytes: source.bytes.byteLength,
    promptPreview: params.prompt.slice(0, 500)
  }));

  const res = await fetchWithTimeout("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY
    },
    body: formData
  }, 90000, "OPENAI_IMAGE_EDIT_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    console.error("IMAGE_OPENAI_RESPONSE_ERROR:", JSON.stringify({
      endpoint: "images/edits",
      status: res.status,
      body: responseText.slice(0, 2000),
      fallback: "images/generations"
    }));
    return await generateImageWithOpenAI(env, params.prompt);
  }

  console.log("IMAGE_OPENAI_RESPONSE_OK:", JSON.stringify({
    endpoint: "images/edits",
    status: res.status,
    bodyPreview: responseText.slice(0, 500)
  }));

  return await parseOpenAIImageResponse(responseText);
}

async function parseOpenAIImageResponse(responseText) {
  const data = JSON.parse(responseText);

  if (!data.data || !data.data[0]) {
    throw new Error("OPENAI_IMAGE_EMPTY_RESPONSE: " + responseText);
  }

  if (data.data[0].b64_json) {
    console.log("IMAGE_OPENAI_BASE64_RECEIVED:", JSON.stringify({
      base64Length: data.data[0].b64_json.length
    }));

    return {
      bytes: base64ToUint8Array(data.data[0].b64_json),
      mimeType: "image/png"
    };
  }

  if (data.data[0].url) {
    const imageRes = await fetch(data.data[0].url);

    if (!imageRes.ok) {
      throw new Error("OPENAI_IMAGE_URL_DOWNLOAD_ERROR " + imageRes.status);
    }

    return {
      bytes: new Uint8Array(await imageRes.arrayBuffer()),
      mimeType: imageRes.headers.get("content-type") || "image/png"
    };
  }

  throw new Error("OPENAI_IMAGE_NO_USABLE_DATA: " + responseText);
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

async function enqueueImageJob(env, job) {
  if (!env.IMAGE_QUEUE) {
    throw new Error("IMAGE_QUEUE binding is missing");
  }

  await env.IMAGE_QUEUE.send(Object.assign({
    createdAt: new Date().toISOString()
  }, job));
}

async function enqueueAudioJob(env, ctx, job) {
  const queueJob = Object.assign({
    createdAt: new Date().toISOString()
  }, job);

  if (env.AUDIO_QUEUE) {
    await env.AUDIO_QUEUE.send(queueJob);

    console.log("AUDIO_JOB_ENQUEUED:", JSON.stringify({
      mode: "AUDIO_QUEUE",
      doName: queueJob.doName || "",
      messageId: queueJob.messageId || "",
      fileId: queueJob.fileId || ""
    }));

    return;
  }

  if (!ctx || typeof ctx.waitUntil !== "function") {
    throw new Error("AUDIO_QUEUE binding is missing and waitUntil is unavailable");
  }

  ctx.waitUntil(processAudioQueueJob(env, queueJob).catch(async function (error) {
    console.error("AUDIO_PIPELINE_FAILED:", JSON.stringify({
      mode: "waitUntil",
      message: String(error.message || error),
      stack: String(error.stack || ""),
      doName: queueJob.doName || "",
      messageId: queueJob.messageId || "",
      fileId: queueJob.fileId || ""
    }));

    await notifyConversationDO(env, queueJob.doName || buildConversationName(queueJob.woztellPayload || {}), {
      type: "audio_failed",
      messageId: queueJob.messageId || "",
      fileId: queueJob.fileId || "",
      error: String(error.message || error),
      failedAt: new Date().toISOString()
    });
  }));

  console.log("AUDIO_JOB_ENQUEUED:", JSON.stringify({
    mode: "waitUntil",
    doName: queueJob.doName || "",
    messageId: queueJob.messageId || "",
    fileId: queueJob.fileId || ""
  }));
}

async function processAudioQueueJob(env, job) {
  logEvent("AUDIO_JOB_RECEIVED", {
    traceId: job.traceId || "",
    doName: job.doName || "",
    messageId: job.messageId || "",
    fileId: job.fileId || ""
  });
  console.log("AUDIO_JOB_RECEIVED:", JSON.stringify({
    doName: job.doName || "",
    messageId: job.messageId || "",
    fileId: job.fileId || ""
  }));
  console.log("AUDIO_PIPELINE_START:", JSON.stringify({
    doName: job.doName || "",
    messageId: job.messageId || "",
    fileId: job.fileId || "",
    channel: job.channel || "",
    phone: job.phone || ""
  }));

  try {
    if (!job.fileId) {
      throw new Error("AUDIO_FILE_ID_MISSING");
    }

    const woztellPayload = job.woztellPayload || {};
    const parsedMessage = job.parsedMessage || {};

    const fileInfo = await resolveWoztellFileUrl(env, {
      appId: job.app || woztellPayload.app || "",
      fileId: job.fileId
    });

    console.log("AUDIO_URL_RESOLVED:", JSON.stringify({
      fileId: job.fileId,
      urlPreview: safeUrlPreview(fileInfo.url || ""),
      fileType: fileInfo.fileType || "",
      size: fileInfo.size || 0
    }));

    const audio = await downloadAudioWithRetries(fileInfo.url, {
      fileType: fileInfo.fileType || parsedMessage.mimeType || "",
      size: fileInfo.size || 0,
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || ""
    }, 3);

    const transcript = await transcribeAudioBytesWithRetries(env, audio.bytes, {
      contentType: audio.contentType,
      fileName: parsedMessage.fileName || "audio.ogg",
      size: fileInfo.size || audio.bytes.byteLength || 0,
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || ""
    }, 2);

    if (!transcript || transcript.trim().length < 2) {
      throw new Error("AUDIO_TRANSCRIPTION_EMPTY");
    }

    const cleanTranscript = cleanUserVisibleText(transcript);

    logEvent("LEGACY_AUDIO_TEXT_PREFIX_BLOCKED", {
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || "",
      source: "audio_queue"
    });
    logEvent("AUDIO_TRANSCRIPT_CLEANED", {
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || "",
      textPreview: cleanTranscript.slice(0, 240),
      source: "audio_queue"
    });
    logEvent("AUDIO_TRANSCRIPT_NORMALIZED", {
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      textPreview: cleanTranscript.slice(0, 240),
      source: "audio_queue"
    });
    logEvent("AUDIO_TRANSCRIPT_USED_AS_USER_TEXT", {
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || "",
      textLength: cleanTranscript.length,
      source: "audio_queue"
    });

    await notifyConversationDO(env, job.doName || buildConversationName(woztellPayload), {
      type: "audio_transcribed",
      messageId: job.messageId || parsedMessage.messageId || woztellPayload.messageId || "",
      transcript: cleanTranscript,
      transcribedAt: new Date().toISOString()
    });

    console.log("AUDIO_PIPELINE_DONE:", JSON.stringify({
      doName: job.doName || "",
      messageId: job.messageId || "",
      transcriptLength: cleanTranscript.length
    }));
    console.log("AUDIO_BATCH_TRANSCRIPTION_DONE:", JSON.stringify({
      doName: job.doName || "",
      messageId: job.messageId || "",
      audioCount: 1,
      transcribedCount: 1,
      failedCount: 0
    }));
  } catch (error) {
    captureError(error, {
      stage: "processAudioQueueJob",
      traceId: job.traceId || "",
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || ""
    });
    console.error("AUDIO_PIPELINE_FAILED:", JSON.stringify({
      message: String(error.message || error),
      stack: String(error.stack || ""),
      doName: job.doName || "",
      messageId: job.messageId || "",
      fileId: job.fileId || ""
    }));

    await notifyConversationDO(env, job.doName || buildConversationName(job.woztellPayload || {}), {
      type: "audio_failed",
      messageId: job.messageId || "",
      fileId: job.fileId || "",
      error: String(error.message || error),
      failedAt: new Date().toISOString()
    });

    throw error;
  }
}

async function downloadAudioWithRetries(audioUrl, metadata, maxAttempts) {
  let lastError;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      console.log("AUDIO_DOWNLOAD_START:", JSON.stringify({
        attempt: attempt,
        url: audioUrl,
        fileType: metadata && metadata.fileType || "",
        size: metadata && metadata.size || 0
      }));
      logEvent("AUDIO_DOWNLOAD_START", {
        traceId: metadata && metadata.traceId || "",
        doName: metadata && metadata.doName || "",
        messageId: metadata && metadata.messageId || "",
        fileId: metadata && metadata.fileId || "",
        attempt: attempt,
        fileType: metadata && metadata.fileType || "",
        size: metadata && metadata.size || 0
      });

      const audioRes = await fetchWithTimeout(audioUrl, {}, 45000, "AUDIO_DOWNLOAD_TIMEOUT");

      if (!audioRes.ok) {
        throw new Error("AUDIO_DOWNLOAD_ERROR " + audioRes.status + ": " + await audioRes.text());
      }

      const contentType = audioRes.headers.get("content-type") || metadata && metadata.fileType || "audio/ogg";
      const bytes = new Uint8Array(await audioRes.arrayBuffer());

      console.log("AUDIO_DOWNLOAD_OK:", JSON.stringify({
        attempt: attempt,
        contentType: contentType,
        byteLength: bytes.byteLength
      }));
      logEvent("AUDIO_DOWNLOAD_OK", {
        traceId: metadata && metadata.traceId || "",
        doName: metadata && metadata.doName || "",
        messageId: metadata && metadata.messageId || "",
        fileId: metadata && metadata.fileId || "",
        attempt: attempt,
        contentType: contentType,
        byteLength: bytes.byteLength
      });

      return {
        bytes: bytes,
        contentType: contentType
      };
    } catch (error) {
      lastError = error;

      if (String(error.message || error).includes("AUDIO_DOWNLOAD_TIMEOUT")) {
        logEvent("AUDIO_TRANSCRIPTION_FAILED", {
          traceId: metadata && metadata.traceId || "",
          doName: metadata && metadata.doName || "",
          messageId: metadata && metadata.messageId || "",
          fileId: metadata && metadata.fileId || "",
          stage: "download",
          attempt: attempt,
          maxAttempts: attempts,
          message: String(error.message || error)
        }, {
          level: "error",
          traceId: metadata && metadata.traceId || ""
        });
        console.error("AUDIO_DOWNLOAD_TIMEOUT:", JSON.stringify({
          attempt: attempt,
          maxAttempts: attempts,
          message: String(error.message || error)
        }));
      }

      if (attempt < attempts) {
        console.log("AUDIO_DOWNLOAD_RETRY:", JSON.stringify({
          attempt: attempt,
          nextAttempt: attempt + 1,
          message: String(error.message || error)
        }));
        await sleep(750 * attempt);
      }
    }
  }

  throw lastError || new Error("AUDIO_DOWNLOAD_FAILED");
}

async function transcribeAudioBytesWithRetries(env, bytes, metadata, maxAttempts) {
  let lastError;
  const attempts = Math.max(1, Number(maxAttempts || 1));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await transcribeAudioBytesOnce(env, bytes, metadata, attempt);
    } catch (error) {
      lastError = error;

      if (attempt < attempts) {
        console.log("AUDIO_TRANSCRIPTION_RETRY:", JSON.stringify({
          attempt: attempt,
          nextAttempt: attempt + 1,
          message: String(error.message || error)
        }));
        await sleep(1000 * attempt);
      }
    }
  }

  console.log("AUDIO_TRANSCRIPTION_FAILED:", JSON.stringify({
    attempts: attempts,
    message: String(lastError && lastError.message || lastError || "AUDIO_TRANSCRIPTION_FAILED")
  }));
  logEvent("AUDIO_TRANSCRIPTION_FAILED", {
    traceId: metadata && metadata.traceId || "",
    doName: metadata && metadata.doName || "",
    messageId: metadata && metadata.messageId || "",
    fileId: metadata && metadata.fileId || "",
    attempts: attempts,
    message: String(lastError && lastError.message || lastError || "AUDIO_TRANSCRIPTION_FAILED")
  }, {
    level: "error",
    traceId: metadata && metadata.traceId || ""
  });
  throw lastError || new Error("AUDIO_TRANSCRIPTION_FAILED");
}

async function transcribeAudioBytesOnce(env, bytes, metadata, attempt) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const contentType = metadata && metadata.contentType || metadata && metadata.fileType || "audio/ogg";
  const model = getTranscriptionModel(env);

  console.log("AUDIO_TRANSCRIPTION_START:", JSON.stringify({
    attempt: attempt || 1,
    model: model,
    contentType: contentType,
    byteLength: bytes.byteLength
  }));
  logEvent("AUDIO_TRANSCRIPTION_START", {
    traceId: metadata && metadata.traceId || "",
    doName: metadata && metadata.doName || "",
    messageId: metadata && metadata.messageId || "",
    fileId: metadata && metadata.fileId || "",
    attempt: attempt || 1,
    model: model,
    contentType: contentType,
    byteLength: bytes.byteLength
  });
  console.log("AUDIO_TRANSCRIPTION_MODEL:", model);

  const formData = new FormData();
  const extension = audioExtensionFromContentType(contentType);

  formData.append("model", model);
  formData.append("language", "es");
  formData.append("response_format", "json");
  formData.append("file", new Blob([bytes], { type: contentType }), "audio." + extension);

  const res = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.OPENAI_API_KEY
    },
    body: formData
  }, 90000, "AUDIO_TRANSCRIPTION_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("AUDIO_TRANSCRIPTION_HTTP_ERROR " + res.status + ": " + responseText);
  }

  const data = parseMaybeJson(responseText);
  const transcript = String(data.text || data.transcript || "").trim();

  console.log("AUDIO_TRANSCRIPTION_RESULT:", JSON.stringify({
    attempt: attempt || 1,
    textPreview: transcript.slice(0, 500),
    length: transcript.length
  }));
  console.log("AUDIO_TRANSCRIPTION_OK:", JSON.stringify({
    attempt: attempt || 1,
    length: transcript.length
  }));
  logEvent("AUDIO_TRANSCRIPTION_OK", {
    traceId: metadata && metadata.traceId || "",
    doName: metadata && metadata.doName || "",
    messageId: metadata && metadata.messageId || "",
    fileId: metadata && metadata.fileId || "",
    attempt: attempt || 1,
    length: transcript.length
  });

  return transcript;
}

async function sendParsedMessageToConversationDO(env, params) {
  if (!env.CONVERSATION_DO) {
    throw new Error("CONVERSATION_DO binding is missing");
  }

  const woztellPayload = params.payload || {};
  const doName = params.doName || buildConversationName(woztellPayload);
  const id = env.CONVERSATION_DO.idFromName(doName);
  const stub = env.CONVERSATION_DO.get(id);

  const res = await stub.fetch("https://conversation.local/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "woztell_message",
      doName: doName,
      payload: woztellPayload,
      parsedMessage: params.parsedMessage || extractWoztellMessage(woztellPayload)
    })
  });

  const text = await res.text();

  console.log("AUDIO_DO_BUFFER_RESULT:", text.slice(0, 1000));

  if (!res.ok) {
    throw new Error("AUDIO_DO_BUFFER_ERROR " + res.status + ": " + text);
  }

  return text;
}

async function sendAudioUserFallback(env, params) {
  if (!params || !params.channel || !params.from) {
    console.error("AUDIO_USER_FALLBACK_SKIPPED:", JSON.stringify(params || {}));
    return;
  }

  await sendWoztellTextMessage(env, {
    channelId: params.channel,
    recipientId: params.from,
    text: USER_MESSAGES.audioFailed
  });

  console.log("AUDIO_USER_FALLBACK_SENT:", JSON.stringify({
    channel: params.channel,
    from: params.from
  }));
}

async function notifyConversationDO(env, doName, payload) {
  if (!env.CONVERSATION_DO || !doName) return;

  try {
    const id = env.CONVERSATION_DO.idFromName(doName);
    const stub = env.CONVERSATION_DO.get(id);

    await stub.fetch("https://conversation.local/tool-result", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (error) {
    console.error("DO_TOOL_RESULT_NOTIFY_ERROR:", String(error.message || error));
  }
}

async function saveGeneratedImageToR2(env, params) {
  if (!env.IMAGES_BUCKET) {
    throw new Error("IMAGES_BUCKET binding is missing");
  }

  if (!env.R2_PUBLIC_BASE_URL) {
    throw new Error("R2_PUBLIC_BASE_URL is missing");
  }

  const mimeType = params.mimeType || "image/png";
  const extension = mimeType.includes("jpeg") || mimeType.includes("jpg") ? "jpg" : "png";
  const key = "generated/" + sanitizeKeyPart(params.phone || "unknown") + "/" + Date.now() + "-" + randomId(8) + "." + extension;

  console.log("IMAGE_R2_UPLOAD_START:", JSON.stringify({
    key: key,
    mimeType: mimeType,
    byteLength: params.bytes ? params.bytes.byteLength : 0
  }));

  await env.IMAGES_BUCKET.put(key, params.bytes, {
    httpMetadata: {
      contentType: mimeType
    }
  });

  console.log("IMAGE_R2_UPLOAD_OK:", JSON.stringify({
    key: key
  }));

  const publicUrl = String(env.R2_PUBLIC_BASE_URL).replace(/\/$/, "") + "/" + key;

  console.log("IMAGE_R2_PUBLIC_URL:", publicUrl);

  return publicUrl;
}

async function saveLastImageToKV(env, woztellPayload, data) {
  if (!env.SESSIONS_KV) return;

  const key = "last_image:" + (woztellPayload.channel || "unknown_channel") + ":" + (woztellPayload.from || "unknown_user");

  await env.SESSIONS_KV.put(key, JSON.stringify({
    imageUrl: data.imageUrl || "",
    latestPrompt: data.prompt || "",
    source: data.source || "",
    updatedAt: new Date().toISOString()
  }), {
    expirationTtl: 60 * 60 * 48
  });
}

async function saveDraftToGoogleSheets(env, draftData) {
  if (!env.GOOGLE_SHEETS_WEBHOOK_URL) {
    console.log("GOOGLE_SHEETS_SKIPPED_NO_WEBHOOK");
    return { skipped: true };
  }

  const rawPayload = Object.assign({
    action: "save_or_update_draft",
    secret: env.GOOGLE_SHEETS_SECRET || "",
    created_at: new Date().toISOString()
  }, draftData);

  const payload = withSheetsCompatColumns(rawPayload);

  console.log("SHEETS_ACTION:", payload.action);
  console.log("SHEETS_COMPAT_COLUMNS_MODE:", "legacy_14_columns");
  console.log("SHEETS_DRAFT_PAYLOAD:", JSON.stringify(payload));

  const res = await fetchWithTimeout(env.GOOGLE_SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 30000, "GOOGLE_SHEETS_SAVE_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("GOOGLE_SHEETS_SAVE_ERROR " + res.status + ": " + responseText);
  }

  const result = parseMaybeJson(responseText);

  console.log("SHEETS_DRAFT_RESULT:", JSON.stringify(result));

  return result;
}

async function updateDraftStatusInGoogleSheets(env, statusData) {
  if (!env.GOOGLE_SHEETS_WEBHOOK_URL) {
    console.log("GOOGLE_SHEETS_UPDATE_SKIPPED_NO_WEBHOOK");
    return { skipped: true };
  }

  const rawPayload = Object.assign({
    action: "update_status",
    secret: env.GOOGLE_SHEETS_SECRET || "",
    updated_at: new Date().toISOString()
  }, statusData);

  const payload = withSheetsCompatColumns(rawPayload);

  console.log("SHEETS_ACTION:", payload.action);
  console.log("SHEETS_COMPAT_COLUMNS_MODE:", "legacy_14_columns");
  console.log("SHEETS_DRAFT_PAYLOAD:", JSON.stringify(payload));

  const res = await fetchWithTimeout(env.GOOGLE_SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }, 30000, "GOOGLE_SHEETS_UPDATE_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("GOOGLE_SHEETS_UPDATE_ERROR " + res.status + ": " + responseText);
  }

  const result = parseMaybeJson(responseText);

  console.log("SHEETS_DRAFT_RESULT:", JSON.stringify(result));

  return result;
}

function withSheetsCompatColumns(payload) {
  const action = String(payload.action || "save_or_update_draft");
  const platformValue = payload.Plataforma || payload.platform || payload.platforms || "";
  const copyText = payload.copy || payload.instagram_copy || payload.Instagram_Copy || "";
  const fileValue = payload.File_ID || payload.file_id || payload.image_url || payload.uploaded_image_url || payload.generated_image_url || payload.last_image_url || "";

  const compatColumns = {
    Fecha: payload.Fecha || payload.created_at || payload.updated_at || new Date().toISOString(),
    Telefono: payload.Telefono || payload.phone || payload.from || "",
    Canal: payload.Canal || payload.channel_id || payload.channel || "",
    Tipo: payload.Tipo || inferSheetsTipo(action, payload),
    Estado: payload.Estado || payload.status || payload.draft_status || inferSheetsEstado(action, payload),
    Plataforma: normalizeSheetsPlatform(platformValue),
    Caption_Original: payload.Caption_Original || payload.original_caption || payload.caption_original || payload.user_text || payload.caption || "",
    Instagram_Copy: payload.Instagram_Copy || payload.instagram_copy || copyText || "",
    Facebook_Copy: payload.Facebook_Copy || payload.facebook_copy || "",
    CTA: payload.CTA || payload.cta || "",
    Hashtags: normalizeSheetsHashtags(payload.Hashtags || payload.hashtags || ""),
    Session_ID: payload.Session_ID || payload.session_id || payload.sessionId || payload.campaign_id || "",
    Message_ID: payload.Message_ID || payload.message_id || payload.messageId || "",
    File_ID: fileValue
  };

  return Object.assign({}, payload, compatColumns, {
    action: action
  });
}

function inferSheetsTipo(action, payload) {
  if (action === "approve_draft") return "APPROVAL";
  if (action === "mark_ready_to_publish") return "READY_TO_PUBLISH";
  if (action === "request_changes") return "CHANGES_REQUESTED";

  const type = String(payload.message_type || payload.type || "").toUpperCase();
  if (type === "AUDIO" || type === "IMAGE" || type === "VIDEO") return type;

  return "DRAFT";
}

function inferSheetsEstado(action, payload) {
  if (action === "approve_draft") return "draft_approved";
  if (action === "mark_ready_to_publish") return "ready_to_publish";
  if (action === "request_changes") return "draft_changes_requested";

  return payload.ready_to_publish ? "ready_to_publish" : "draft_pending_review";
}

function normalizeSheetsPlatform(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(function (item) {
      return String(item).trim();
    }).filter(Boolean).join(",");
  }

  return String(value || "").trim();
}

function normalizeSheetsHashtags(value) {
  if (Array.isArray(value)) {
    return value.filter(Boolean).map(function (item) {
      return String(item).trim();
    }).filter(Boolean).join(" ");
  }

  return String(value || "").trim();
}

async function getWoztellFileInfo(env, params) {
  const token = env.WOZTELL_OPEN_API_TOKEN || env.WOZTELL_ACCESS_TOKEN;

  if (!token) {
    throw new Error("Missing WOZTELL_OPEN_API_TOKEN");
  }

  const query = `
    query GetFile($appId: ID, $fileId: ID) {
      apiViewer(appId: $appId) {
        file(fileId: $fileId) {
          fileId
          fileType
          size
          url
        }
      }
    }
  `;

  const res = await fetchWithTimeout("https://open.api.woztell.com/v3", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    body: JSON.stringify({
      query: query,
      variables: {
        appId: params.appId,
        fileId: params.fileId
      }
    })
  }, 30000, "WOZTELL_FILE_INFO_TIMEOUT");

  const responseText = await res.text();

  if (!res.ok) {
    throw new Error("WOZTELL_FILE_INFO_ERROR " + res.status + ": " + responseText);
  }

  const data = JSON.parse(responseText);

  if (data.errors && data.errors.length) {
    throw new Error("WOZTELL_FILE_INFO_GRAPHQL_ERROR: " + JSON.stringify(data.errors));
  }

  const file = data && data.data && data.data.apiViewer && data.data.apiViewer.file;

  if (!file || !file.url) {
    throw new Error("WOZTELL_FILE_INFO_NO_URL: " + responseText);
  }

  return file;
}

async function sendLongTextByWoztell(env, params) {
  const parts = splitTextForWhatsApp(params.text, 2500);

  for (const part of parts) {
    await sendWoztellTextMessage(env, {
      channelId: params.channelId,
      recipientId: params.recipientId,
      text: part
    });
    await sleep(500);
  }
}

async function sendConversationalResponse(env, params) {
  const enabled = String(env && env.CONVERSATIONAL_SPLIT_ENABLED || "true").toLowerCase() !== "false";
  const maxChars = getNumberEnv(env && env.CONVERSATIONAL_SPLIT_MAX_CHARS, 650);
  const delayMs = getNumberEnv(env && env.CONVERSATIONAL_SPLIT_DELAY_MS, 750);
  const baseReplyInput = {
    userTurn: params && params.userTurn || {},
    intent: params && params.intent || params && params.supervisorPlan && params.supervisorPlan.intent || "",
    supervisorPlan: params && params.supervisorPlan || {},
    systemResult: { text: params && params.text || "" },
    visibleFacts: params && params.visibleFacts || [],
    nextAction: params && params.nextAction || "",
    recentMediaCount: countRecentMediaImages(params && params.recentMediaAssets || []),
    locale: "es",
    maxChars: maxChars,
    traceId: params && params.traceId || "",
    turnId: params && params.turnId || ""
  };
  let reply = composeCustomerReply({
    userTurn: baseReplyInput.userTurn,
    intent: baseReplyInput.intent,
    supervisorPlan: baseReplyInput.supervisorPlan,
    systemResult: baseReplyInput.systemResult,
    visibleFacts: baseReplyInput.visibleFacts,
    nextAction: baseReplyInput.nextAction,
    recentMediaCount: baseReplyInput.recentMediaCount,
    locale: baseReplyInput.locale,
    maxChars: baseReplyInput.maxChars,
    traceId: baseReplyInput.traceId,
    turnId: baseReplyInput.turnId
  }, env || {});
  const modelReplyText = await composeCustomerReplyWithOpenAI(env || {}, Object.assign({}, params || {}, baseReplyInput), reply.text);
  if (modelReplyText) {
    reply = composeCustomerReply(Object.assign({}, baseReplyInput, {
      systemResult: { text: modelReplyText }
    }), env || {});
  }
  if (shouldBlockBadGenericReply(params && params.text || "", params && params.userTurn || {}) ||
    shouldBlockBadGenericReply(reply.text, params && params.userTurn || {})) {
    const forcedText = buildForcedDirectGeneralAnswer(params && params.userTurn || {}, params && params.text || "");
    logEvent("BAD_GENERIC_REPLY_BLOCKED", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      textPreview: String(reply.text || "").slice(0, 240)
    });
    logEvent("DIRECT_GENERAL_ANSWER_FORCED", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      textLength: forcedText.length
    });
    reply = composeCustomerReply({
      userTurn: params && params.userTurn || {},
      intent: params && params.intent || params && params.supervisorPlan && params.supervisorPlan.intent || "general",
      systemResult: { text: forcedText },
      visibleFacts: params && params.visibleFacts || [],
      nextAction: params && params.nextAction || "",
      locale: "es",
      maxChars: maxChars,
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || ""
    }, env || {});
    logEvent("CUSTOMER_REPLY_REGENERATED_FROM_USER_TURN", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      textLength: reply.text.length
    });
  }
  if (shouldBlockFalseNoImageReply(reply.text, params && params.userTurn || {}, params && params.recentMediaAssets || [])) {
    logEvent("FALSE_NO_IMAGE_REPLY_BLOCKED", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      textPreview: String(reply.text || "").slice(0, 240)
    });
    logEvent("RECENT_MEDIA_FOUND_BEFORE_NO_IMAGE_REPLY", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      imageCount: countUserTurnImages(params && params.userTurn || {}) || countRecentMediaImages(params && params.recentMediaAssets || [])
    });
    logEvent("RECENT_MEDIA_USED_TO_REPAIR_IMAGE_REPLY", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      imageCount: countUserTurnImages(params && params.userTurn || {}) || countRecentMediaImages(params && params.recentMediaAssets || []),
      reason: "false_no_image_reply"
    });
    reply = composeCustomerReply({
      userTurn: params && params.userTurn || {},
      intent: params && params.intent || params && params.supervisorPlan && params.supervisorPlan.intent || "image_review",
      systemResult: { text: "Si tengo imagenes recientes de la conversacion. Las uso como evidencia para responderte." },
      visibleFacts: params && params.visibleFacts || [],
      nextAction: params && params.nextAction || "",
      locale: "es",
      maxChars: maxChars,
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || ""
    }, env || {});
  }
  if (shouldBlockFalseOnlyOneImageReply(reply.text, params && params.userTurn || {}, params && params.recentMediaAssets || [])) {
    logEvent("FALSE_ONLY_ONE_IMAGE_REPLY_BLOCKED", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      textPreview: String(reply.text || "").slice(0, 240),
      imageCount: countUserTurnImages(params && params.userTurn || {}) || countRecentMediaImages(params && params.recentMediaAssets || [])
    });
    logEvent("RECENT_MEDIA_USED_TO_REPAIR_IMAGE_REPLY", {
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || "",
      doName: params && params.doName || "",
      imageCount: countUserTurnImages(params && params.userTurn || {}) || countRecentMediaImages(params && params.recentMediaAssets || []),
      reason: "false_only_one_image_reply"
    });
    reply = composeCustomerReply({
      userTurn: params && params.userTurn || {},
      intent: params && params.intent || params && params.supervisorPlan && params.supervisorPlan.intent || "image_review",
      systemResult: { text: "Si tengo las imagenes recientes de la conversacion. Las uso juntas para responderte." },
      visibleFacts: params && params.visibleFacts || [],
      nextAction: params && params.nextAction || "",
      locale: "es",
      maxChars: maxChars,
      traceId: params && params.traceId || "",
      turnId: params && params.turnId || ""
    }, env || {});
  }
  if (!reply.shouldSend) return { partCount: 0 };
  const text = reply.text;
  const parts = enabled ? reply.splitMessages : [text].filter(Boolean);

  if (parts.length > 1) {
    logEvent("CONVERSATIONAL_SPLIT_APPLIED", {
      traceId: params.traceId || "",
      turnId: params.turnId || "",
      doName: params.doName || "",
      partCount: parts.length,
      maxChars: maxChars
    });
  }

  for (let index = 0; index < parts.length; index++) {
    await sendWoztellTextMessage(env, {
      channelId: params.channelId,
      recipientId: params.recipientId,
      memberId: params.memberId,
      appId: params.appId,
      traceId: params.traceId || "",
      turnId: params.turnId || "",
      doName: params.doName || "",
      text: parts[index]
    });
    logEvent("CONVERSATIONAL_MESSAGE_PART_SENT", {
      traceId: params.traceId || "",
      turnId: params.turnId || "",
      doName: params.doName || "",
      index: index + 1,
      total: parts.length
    });
    if (index < parts.length - 1) await sleep(delayMs);
  }

  return {
    partCount: parts.length
  };
}

async function composeCustomerReplyWithOpenAI(env, params, localDraftText) {
  if (!shouldUseCustomerReplyAI(env, params)) return "";

  const model = getCustomerReplyModel(env || {});
  const traceId = params && params.traceId || params && params.userTurn && params.userTurn.trace_id || "";
  const turnId = params && params.turnId || params && params.userTurn && params.userTurn.turn_id || "";
  const doName = params && params.doName || "";
  const promptPayload = buildCustomerReplyPromptPayload({
    userTurn: params && params.userTurn || {},
    intent: params && params.intent || params && params.supervisorPlan && params.supervisorPlan.intent || "",
    supervisorPlan: params && params.supervisorPlan || {},
    systemResult: { text: params && params.text || localDraftText || "" },
    visibleFacts: params && params.visibleFacts || [],
    nextAction: params && params.nextAction || "",
    recentMediaCount: countRecentMediaImages(params && params.recentMediaAssets || []),
    locale: "es"
  });

  promptPayload.local_fallback_draft = String(localDraftText || "").trim();

  logEvent("CUSTOMER_REPLY_AI_START", {
    traceId: traceId,
    turnId: turnId,
    doName: doName,
    model: model,
    intent: promptPayload.routing_context.intent,
    imageCount: promptPayload.user_turn.counts.image,
    audioCount: promptPayload.user_turn.counts.audio
  });

  try {
    const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.OPENAI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: model,
        input: [
          {
            role: "user",
            content: JSON.stringify(promptPayload)
          }
        ],
        text: {
          verbosity: "low"
        },
        max_output_tokens: 700
      })
    }, 30000, "CUSTOMER_REPLY_AI_TIMEOUT");

    const responseText = await res.text();

    if (!res.ok) {
      logEvent("CUSTOMER_REPLY_AI_FAILED", {
        traceId: traceId,
        turnId: turnId,
        doName: doName,
        model: model,
        status: res.status,
        errorSummary: summarizeTextForLog(responseText)
      }, { level: "error", traceId: traceId });
      return "";
    }

    const responseJson = parseMaybeJson(responseText);
    const outputText = extractOpenAIResponseText(responseJson);
    const parsed = parseCustomerReplyModelOutput(outputText);
    const text = String(parsed.text || "").trim();

    if (!parsed.shouldSend || !text || looksUnsafeCustomerReply(text)) {
      logEvent("CUSTOMER_REPLY_AI_REJECTED", {
        traceId: traceId,
        turnId: turnId,
        doName: doName,
        model: model,
        reason: !parsed.shouldSend ? "should_send_false" : !text ? "empty_text" : "unsafe_text"
      }, { level: "error", traceId: traceId });
      return "";
    }

    logEvent("CUSTOMER_REPLY_AI_OK", {
      traceId: traceId,
      turnId: turnId,
      doName: doName,
      model: model,
      textLength: text.length
    });

    return text;
  } catch (error) {
    logEvent("CUSTOMER_REPLY_AI_FALLBACK", {
      traceId: traceId,
      turnId: turnId,
      doName: doName,
      model: model,
      reason: summarizeErrorForLog(error)
    }, { level: "error", traceId: traceId });
    return "";
  }
}

function shouldUseCustomerReplyAI(env, params) {
  if (!env || !env.OPENAI_API_KEY) return false;
  if (String(env.CUSTOMER_REPLY_AI_ENABLED || "false").toLowerCase() !== "true") return false;
  if (String(getCustomerReplyModel(env || {})).toLowerCase() === "mock") return false;
  const text = String(params && params.text || "").trim();
  const turn = params && params.userTurn || {};
  const imageCount = countUserTurnImages(turn);
  const audioCount = Number(turn.audio_count || turn.counts && turn.counts.audio || 0);
  const hasUserText = Boolean(cleanUserVisibleText(turn.combinedUserText || turn.current_turn_text || ""));
  return Boolean(text || imageCount || audioCount || hasUserText);
}

function parseCustomerReplyModelOutput(outputText) {
  const raw = String(outputText || "").trim();
  if (!raw) return { text: "", shouldSend: false };

  const parsedReply = parseCustomerReplyJson(raw);
  if (parsedReply) return parsedReply;

  if (!raw.startsWith("{") && !raw.startsWith("```")) {
    return {
      text: raw,
      shouldSend: true
    };
  }

  try {
    const parsed = parseJsonFromText(raw);
    return {
      text: String(parsed && parsed.text || "").trim(),
      shouldSend: parsed && Object.prototype.hasOwnProperty.call(parsed, "shouldSend")
        ? Boolean(parsed.shouldSend)
        : true
    };
  } catch (_) {
    return {
      text: raw,
      shouldSend: true
    };
  }
}

function parseCustomerReplyJson(text) {
  const raw = String(text || "").trim();
  const candidates = [raw];
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidates.unshift(fenced[1].trim());

  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith("{")) continue;

    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && ("text" in parsed || "shouldSend" in parsed)) {
        return {
          text: String(parsed.text || "").trim(),
          shouldSend: Object.prototype.hasOwnProperty.call(parsed, "shouldSend")
            ? Boolean(parsed.shouldSend)
            : true
        };
      }
    } catch (_) {
      // Keep the fallback path for non-JSON or malformed model text.
    }
  }

  return null;
}

function looksUnsafeCustomerReply(text) {
  return /(OPENAI_API_KEY|ANTHROPIC_API_KEY|WOZTELL_ACCESS_TOKEN|WOZTELL_OPEN_API_TOKEN|GOOGLE_SHEETS_SECRET)=/i.test(String(text || ""));
}

function shouldBlockBadGenericReply(replyText, userTurn) {
  const userText = cleanUserVisibleText(userTurn && (userTurn.combinedUserText || userTurn.current_turn_text) || "");

  if (!isClearUserRequestText(userText)) return false;

  return containsAssistantStancePattern(replyText, [
    "quieres que lo explique",
    "quieres que lo resuma",
    "revise algun detalle puntual",
    "revise algún detalle puntual",
    "que quieres que haga con esto",
    "qué quieres que haga con esto",
    "dime si quieres que"
  ]);
}

function shouldBlockFalseNoImageReply(replyText, userTurn, recentMediaAssets) {
  const deniesImage = containsAssistantStancePattern(replyText, [
    "no veo la imagen",
    "no veo ninguna imagen",
    "no puedo ver la imagen",
    "no puedo ver ninguna imagen",
    "no hay imagen",
    "no encuentro la imagen",
    "no tengo la imagen",
    "no veo imagen"
  ]);
  return Boolean(deniesImage && (countUserTurnImages(userTurn) > 0 || countRecentMediaImages(recentMediaAssets) > 0));
}

function shouldBlockFalseOnlyOneImageReply(replyText, userTurn, recentMediaAssets) {
  const onlyOne = containsAssistantStancePattern(replyText, [
    "me llego solo una imagen",
    "me llegó solo una imagen",
    "solo me llego una imagen",
    "solo me llegó una imagen",
    "solo veo una imagen",
    "me llego una sola imagen",
    "me llegó una sola imagen",
    "reenviame la otra",
    "reenvíame la otra",
    "reenvia la otra",
    "reenvía la otra"
  ]);
  return Boolean(onlyOne && Math.max(countUserTurnImages(userTurn), countRecentMediaImages(recentMediaAssets)) > 1);
}

function countRecentMediaImages(recentMediaAssets) {
  return normalizeRecentMediaAssets(recentMediaAssets || []).filter(function (asset) {
    return String(asset.mediaType || "IMAGE").toUpperCase() === "IMAGE";
  }).length;
}

function containsAssistantStancePattern(replyText, patterns) {
  const raw = String(replyText || "").trim();
  const text = normalizeTextForIntent(raw);
  if (!text) return false;

  const normalizedPatterns = (patterns || []).map(function (pattern) {
    return normalizeTextForIntent(pattern);
  }).filter(Boolean);
  const matches = normalizedPatterns.map(function (pattern) {
    return { pattern: pattern, index: text.indexOf(pattern) };
  }).filter(function (match) {
    return match.index >= 0;
  }).sort(function (first, second) {
    return first.index - second.index;
  });

  if (!matches.length) return false;

  const first = matches[0];
  if (isPatternQuotedOrVisibleText(text, first.index)) return false;

  const firstSentence = text.split(/[.!?\n]/)[0] || text;
  if (firstSentence.includes(first.pattern)) return true;

  return first.index <= 80;
}

function isPatternQuotedOrVisibleText(normalizedText, patternIndex) {
  const before = normalizedText.slice(Math.max(0, patternIndex - 120), patternIndex);
  return /\b(texto visible|visible text|visible_text|texto detectado|ocr|se lee|dice|aparece|captura|pantalla|imagen muestra|en la imagen|en la captura|texto de la imagen)\b/.test(before);
}

function countUserTurnImages(userTurn) {
  const turn = userTurn || {};
  if (turn.counts && Number(turn.counts.image || 0)) return Number(turn.counts.image || 0);
  if (Array.isArray(turn.images) && turn.images.length) return turn.images.length;
  if (turn.media_batch && Array.isArray(turn.media_batch.assets)) {
    return turn.media_batch.assets.filter(function (asset) {
      return String(asset.media_type || "").toUpperCase() === "IMAGE";
    }).length;
  }
  return 0;
}

function isClearUserRequestText(text) {
  const clean = normalizeTextForIntent(text);
  if (!clean) return false;
  if (clean.includes("?")) return true;
  return /\b(que|qué|como|cómo|cual|cuál|dame|dime|explica|explicame|explícame|responde|recomienda|recomiendame|necesito|quiero|haz|prepara|ayudame|ayúdame|opina|opinion|opinión|ingredientes|desayuno|receta|libro)\b/.test(clean);
}

function buildForcedDirectGeneralAnswer(userTurn, fallbackText) {
  const userText = cleanUserVisibleText(userTurn && (userTurn.combinedUserText || userTurn.current_turn_text) || "");
  const normalized = normalizeTextForIntent(userText);
  const local = composeGeneralTextAnswer(userText);

  if (/\blibro\b/.test(normalized) && /\baguacate\b/.test(normalized)) {
    return [
      "Te respondo las dos cosas.",
      "Sobre el libro: si me dices el titulo exacto puedo opinar mejor; en general miraria si te esta aportando ideas utiles, si es claro y si te deja acciones concretas para aplicar.",
      "Para aguacate molido te recomiendo: limon, sal, pimienta, cilantro, cebolla morada picada y un toque de tomate. Si lo quieres mas cremoso, un chorrito de aceite de oliva; si lo quieres con picante, aji o jalapeno."
    ].join("\n\n");
  }

  if (/\bdesayuno\b/.test(normalized)) {
    return [
      "Una idea rapida de desayuno:",
      "Tostada con aguacate molido, huevo, sal, pimienta y limon. Si quieres algo mas completo, agrega tomate o queso fresco y acompana con fruta.",
      "Queda balanceado: grasa buena del aguacate, proteina del huevo y energia suficiente para empezar el dia."
    ].join("\n\n");
  }

  if (local) return local;

  if (/^como se hace|^como funciona|^que es|^por que|^para que/i.test(normalized)) {
    return "Te respondo directo: funciona por un principio base, luego por sus partes y finalmente por como se aplica. Si me compartes el tema exacto, te doy la explicacion paso a paso sin rodeos.";
  }

  return String(fallbackText || "").trim() && !shouldBlockBadGenericReply(fallbackText, { combinedUserText: "" })
    ? String(fallbackText).trim()
    : "Te respondo directo: si me das el tema exacto, te doy una respuesta concreta y util sin menu ni rodeos.";
}

async function sendWoztellTextMessage(env, params) {
  const parsedReply = parseCustomerReplyModelOutput(params.text);
  const cleanText = fixMojibake(parsedReply.text || params.text);

  if (parsedReply.text !== String(params.text || "").trim() || parsedReply.shouldSend === false) {
    logEvent("USER_RESPONSE_JSON_UNWRAPPED", {
      textLength: cleanText.length,
      shouldSend: parsedReply.shouldSend
    });
  }

  if (!parsedReply.shouldSend || !cleanText.trim()) {
    logEvent("USER_RESPONSE_BLOCKED_EMPTY", {
      channelId: params.channelId || "",
      recipientId: params.recipientId || ""
    });
    return { ok: true, blocked: true };
  }

  console.log("WOZTELL_TEXT_SEND_PREVIEW:", JSON.stringify({
    channelId: params.channelId || "",
    recipientId: params.recipientId || "",
    textPreview: cleanText.slice(0, 1000)
  }));

  return await sendWoztellResponse(env, {
    channelId: params.channelId,
    recipientId: params.recipientId,
    memberId: params.memberId,
    appId: params.appId,
    swallowErrors: params.swallowErrors,
    response: [
      {
        type: "TEXT",
        text: cleanText
      }
    ]
  });
}

function fixMojibake(text) {
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

async function sendWoztellImageMessage(env, params) {
  return await sendWoztellResponse(env, {
    channelId: params.channelId,
    recipientId: params.recipientId,
    memberId: params.memberId,
    appId: params.appId,
    swallowErrors: params.swallowErrors,
    logPrefix: "WOZTELL_IMAGE_SEND",
    response: [
      {
        type: "IMAGE",
        url: params.imageUrl
      }
    ]
  });
}

async function sendWoztellResponse(env, params) {
  const tokenInfo = selectWoztellSendToken(env);

  if (!tokenInfo.token) {
    const missingResult = {
      ok: false,
      failed: true,
      status: 0,
      body: "Missing WOZTELL_ACCESS_TOKEN or WOZTELL_OPEN_API_TOKEN"
    };
    console.error("WOZTELL_SEND_FAILED:", JSON.stringify(missingResult));
    if (params.swallowErrors) return missingResult;
    return missingResult;
  }

  const url = "https://bot.api.woztell.com/sendResponses?accessToken=" + encodeURIComponent(tokenInfo.token);
  const baseParams = Object.assign({}, params, {
    memberId: params.memberId || activeLogContext.memberId || "",
    appId: params.appId || activeLogContext.appId || ""
  });
  const attempts = buildWoztellSendAttempts(baseParams);
  let parsed = null;
  let lastFailure = null;

  console.log("WOZTELL_SEND_ENDPOINT:", JSON.stringify({
    endpoint: "https://bot.api.woztell.com/sendResponses",
    hasAccessTokenQuery: true
  }));
  console.log("WOZTELL_SEND_AUTH_MODE:", JSON.stringify({
    tokenType: tokenInfo.mode,
    hasWoztellAccessToken: Boolean(env.WOZTELL_ACCESS_TOKEN),
    hasWoztellOpenApiToken: Boolean(env.WOZTELL_OPEN_API_TOKEN)
  }));

  for (const attempt of attempts) {
    const payload = attempt.payload;

    logWoztellSendShape(payload, attempt.mode);

    if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
      console.log("WOZTELL_IMAGE_SEND_PAYLOAD:", JSON.stringify(redactWoztellPayloadForLog(payload)));
    }

    let res;

    try {
      res = await fetchWithTimeout(url, {
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

      if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
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
    break;
  }

  if (!parsed) {
    return lastFailure || { ok: false, failed: true, status: 0, body: "WOZTELL_SEND_FAILED" };
  }

  if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
    console.log("WOZTELL_IMAGE_SEND_OK:", JSON.stringify({
      status: res.status,
      body: parsed
    }));
  }

  console.log("USER_RESPONSE_SENT:", JSON.stringify({
    channelId: params.channelId || "",
    recipientId: params.recipientId || "",
    responseCount: Array.isArray(params.response) ? params.response.length : 0,
    responseTypes: (Array.isArray(params.response) ? params.response : []).map(function (item) {
      return item.type || "";
    })
  }));
  logEvent("USER_RESPONSE_SENT", {
    traceId: params.traceId || activeLogContext.traceId || "",
    turnId: params.turnId || activeLogContext.turnId || "",
    doName: params.doName || activeLogContext.doName || "",
    channelId: params.channelId || "",
    recipientId: params.recipientId || "",
    responseCount: Array.isArray(params.response) ? params.response.length : 0,
    responseTypes: (Array.isArray(params.response) ? params.response : []).map(function (item) {
      return item.type || "";
    })
  });

  return parsed;
}

function selectWoztellSendToken(env) {
  if (env.WOZTELL_ACCESS_TOKEN) {
    return {
      token: env.WOZTELL_ACCESS_TOKEN,
      mode: "WOZTELL_ACCESS_TOKEN"
    };
  }

  if (env.WOZTELL_OPEN_API_TOKEN) {
    return {
      token: env.WOZTELL_OPEN_API_TOKEN,
      mode: "WOZTELL_OPEN_API_TOKEN"
    };
  }

  return {
    token: "",
    mode: "none"
  };
}

function buildWoztellSendAttempts(params) {
  return buildAdapterWoztellSendAttempts(params || {});
}

function logWoztellSendShape(payload, mode) {
  console.log("WOZTELL_SEND_BODY_SHAPE:", JSON.stringify({
    mode: mode,
    keys: Object.keys(payload),
    responseCount: Array.isArray(payload.response) ? payload.response.length : 0,
    responseTypes: (Array.isArray(payload.response) ? payload.response : []).map(function (item) {
      return item.type || "";
    })
  }));
  console.log("WOZTELL_SEND_CHANNEL_ID:", JSON.stringify({
    present: Boolean(payload.channelId),
    valuePreview: String(payload.channelId || "").slice(0, 8)
  }));
  console.log("WOZTELL_SEND_MEMBER_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload.memberId)
  }));
  console.log("WOZTELL_SEND_RECIPIENT_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload.recipientId)
  }));
  console.log("WOZTELL_SEND_APP_ID_PRESENT:", JSON.stringify({
    present: Boolean(payload.appId)
  }));
}

function shouldRetryWoztellWithMember(responseText, memberId) {
  return Boolean(memberId && String(responseText || "").toLowerCase().includes("app could not be found"));
}

function redactWoztellPayloadForLog(payload) {
  return {
    channelId: payload.channelId || "",
    hasMemberId: Boolean(payload.memberId),
    hasRecipientId: Boolean(payload.recipientId),
    hasAppId: Boolean(payload.appId),
    responseCount: Array.isArray(payload.response) ? payload.response.length : 0,
    responseTypes: (Array.isArray(payload.response) ? payload.response : []).map(function (item) {
      return item.type || "";
    })
  };
}

async function downloadImageBytes(url) {
  const res = await fetchWithTimeout(url, {}, 45000, "IMAGE_DOWNLOAD_TIMEOUT");

  if (!res.ok) {
    throw new Error("IMAGE_DOWNLOAD_ERROR " + res.status + ": " + await res.text());
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";

  if (!contentType.startsWith("image/")) {
    throw new Error("DOWNLOAD_NOT_IMAGE: " + contentType);
  }

  const mediaType = normalizeImageMediaType(contentType);

  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    mediaType: mediaType,
    extension: mediaType.includes("png") ? "png" : mediaType.includes("webp") ? "webp" : "jpg"
  };
}

function normalizeCoordinatorData(data) {
  const clean = data || {};
  const clientProfile = normalizeClientProfile(clean.clientProfile || clean.client_profile || {});
  const campaignState = normalizeCampaignState(clean.campaignState || clean.campaign_state || clean.conversationState || {});

  return {
    doName: String(clean.doName || ""),
    channel: String(clean.channel || ""),
    phone: String(clean.phone || ""),
    member: String(clean.member || ""),
    app: String(clean.app || ""),
    channelIdentity: clean.channelIdentity || clean.channel_identity || null,
    messageEventMeta: clean.messageEventMeta || clean.message_event_meta || null,
    lastInboundAt: String(clean.lastInboundAt || clean.last_inbound_at || ""),
    pendingMessages: Array.isArray(clean.pendingMessages) ? clean.pendingMessages : [],
    currentTurnId: String(clean.currentTurnId || ""),
    currentTraceId: String(clean.currentTraceId || ""),
    processedMessageIds: Array.isArray(clean.processedMessageIds) ? clean.processedMessageIds.slice(-80) : [],
    firstMessageAt: Number(clean.firstMessageAt || 0),
    lastMessageAt: Number(clean.lastMessageAt || 0),
    processAfter: Number(clean.processAfter || 0),
    hasMedia: Boolean(clean.hasMedia),
    processing: Boolean(clean.processing),
    processingStartedAt: clean.processingStartedAt || null,
    updatedAt: String(clean.updatedAt || new Date().toISOString()),
    clientProfile: clientProfile,
    campaignState: campaignState,
    conversationLog: Array.isArray(clean.conversationLog || clean.conversation_log) ? (clean.conversationLog || clean.conversation_log).slice(-30) : [],
    conversationSummary: clean.conversationSummary || clean.conversation_summary || null,
    userStyleProfile: clean.userStyleProfile || clean.user_style_profile || null,
    customerMemory: clean.customerMemory || clean.customer_memory || null,
    utilityMemory: clean.utilityMemory || clean.utility_memory || null,
    requestContext: clean.requestContext || clean.request_context || null,
    recentMedia: normalizeRecentMedia(clean.recentMedia || clean.recent_media || []),
    recentMediaAssets: normalizeRecentMediaAssets(clean.recentMediaAssets || clean.recent_media_assets || []),
    coreUtilityState: normalizeCoreUtilityState(clean.coreUtilityState || clean.core_utility_state || {}),
    activeContext: normalizeConversationContext(clean.activeContext || clean.active_context || {}),
    archivedCampaigns: Array.isArray(clean.archivedCampaigns) ? clean.archivedCampaigns.slice(-5) : []
  };
}

function normalizeRecentMedia(items) {
  return (Array.isArray(items) ? items : []).map(function (item) {
    return {
      file_id: String(item.file_id || item.fileId || ""),
      url: String(item.url || ""),
      media_type: String(item.media_type || item.mediaType || "IMAGE").toUpperCase(),
      mime_type: String(item.mime_type || item.mimeType || ""),
      message_id: String(item.message_id || item.messageId || ""),
      turn_id: String(item.turn_id || item.turnId || ""),
      caption: String(item.caption || ""),
      received_at: String(item.received_at || item.receivedAt || new Date().toISOString()),
      status: String(item.status || "received")
    };
  }).filter(function (item) {
    return item.file_id || item.message_id || item.url;
  }).slice(-30);
}

function addRecentMedia(items, item) {
  const list = normalizeRecentMedia(items);
  const incoming = normalizeRecentMedia([item])[0];
  if (!incoming) return list;
  const existing = list.find(function (candidate) {
    return incoming.file_id && candidate.file_id === incoming.file_id ||
      incoming.message_id && candidate.message_id === incoming.message_id;
  });
  if (existing) {
    existing.url = incoming.url || existing.url;
    existing.status = incoming.status || existing.status;
    existing.caption = incoming.caption || existing.caption;
    existing.turn_id = incoming.turn_id || existing.turn_id;
    existing.received_at = incoming.received_at || existing.received_at;
    return list.slice(-30);
  }
  return list.concat([incoming]).slice(-30);
}

function normalizeRecentMediaAssets(items) {
  return (Array.isArray(items) ? items : []).map(function (item) {
    return {
      messageId: String(item.messageId || item.message_id || ""),
      fileId: String(item.fileId || item.file_id || ""),
      url: String(item.url || ""),
      mediaType: String(item.mediaType || item.media_type || "IMAGE").toUpperCase(),
      mimeType: String(item.mimeType || item.mime_type || ""),
      caption: String(item.caption || ""),
      receivedAt: String(item.receivedAt || item.received_at || new Date().toISOString()),
      turnId: String(item.turnId || item.turn_id || item.request_id || ""),
      traceId: String(item.traceId || item.trace_id || "")
    };
  }).filter(function (item) {
    return item.fileId || item.messageId || item.url;
  }).slice(-60);
}

function addRecentMediaAsset(items, item) {
  const list = normalizeRecentMediaAssets(items);
  const incoming = normalizeRecentMediaAssets([item])[0];
  if (!incoming) return list;
  const existing = list.find(function (candidate) {
    return incoming.fileId && candidate.fileId === incoming.fileId ||
      incoming.messageId && candidate.messageId === incoming.messageId;
  });
  if (existing) {
    existing.url = incoming.url || existing.url;
    existing.mediaType = incoming.mediaType || existing.mediaType;
    existing.mimeType = incoming.mimeType || existing.mimeType;
    existing.caption = incoming.caption || existing.caption;
    existing.receivedAt = incoming.receivedAt || existing.receivedAt;
    existing.turnId = incoming.turnId || existing.turnId;
    existing.traceId = incoming.traceId || existing.traceId;
    return list.slice(-60);
  }
  return list.concat([incoming]).slice(-60);
}

function recentMediaAssetToCampaignAsset(item) {
  const asset = normalizeRecentMediaAssets([item])[0];
  if (!asset) return null;
  return normalizeCampaignAssets([{
    file_id: asset.fileId,
    url: asset.url,
    media_type: asset.mediaType || "IMAGE",
    mime_type: asset.mimeType || "",
    message_id: asset.messageId,
    caption: asset.caption,
    turn_id: asset.turnId,
    request_id: asset.turnId,
    received_at: asset.receivedAt,
    status: asset.url ? "received" : "url_pending"
  }])[0] || null;
}

function getRecentMediaAssets(data, now, maxAgeMs) {
  const current = Number(now || Date.now());
  return normalizeRecentMediaAssets(data && data.recentMediaAssets || []).filter(function (asset) {
    const at = Date.parse(asset.receivedAt || "") || 0;
    return asset.fileId && (!at || current - at <= maxAgeMs);
  });
}

function shortMediaId(value) {
  const text = String(value || "");
  if (text.length <= 10) return text;
  return text.slice(0, 5) + "..." + text.slice(-4);
}

function attachReferencedMediaToMessage(message, data, now) {
  const clean = Object.assign({}, message || {});
  if (clean.media && clean.media.length) return clean;

  const quotedId = String(clean.quotedMessageId || clean.replyToMessageId || "").trim();
  const quotedFileId = String(clean.quotedFileId || "").trim();
  const traceId = clean.traceId || data && data.currentTraceId || "";
  const turnId = clean.turnId || data && data.currentTurnId || "";
  const doName = data && data.doName || "";

  if (quotedId || quotedFileId) {
    logEvent("QUOTED_MEDIA_REFERENCE_DETECTED", {
      traceId: traceId,
      turnId: turnId,
      doName: doName,
      messageId: clean.messageId || "",
      quotedMessageId: quotedId,
      quotedFileId: quotedFileId
    });
    const quotedAsset = findReferencedMediaAsset(data, { messageId: quotedId, fileId: quotedFileId });
    if (quotedAsset) {
      logEvent("QUOTED_MEDIA_RESOLVED", {
        traceId: traceId,
        turnId: turnId,
        doName: doName,
        messageId: clean.messageId || "",
        quotedMessageId: quotedId,
        fileId: quotedAsset.file_id || ""
      });
      return attachAssetAsReferencedMedia(clean, quotedAsset, "quoted");
    }
    logEvent("QUOTED_MEDIA_NOT_FOUND", {
      traceId: traceId,
      turnId: turnId,
      doName: doName,
      messageId: clean.messageId || "",
      quotedMessageId: quotedId,
      quotedFileId: quotedFileId
    });
  }

  if (shouldUseRecentMediaFallbackForMessage(clean)) {
    const recentAsset = findRecentMediaAsset(data, now, 90000);
    if (recentAsset) {
      logEvent("RECENT_MEDIA_FALLBACK_USED", {
        traceId: traceId,
        turnId: turnId,
        doName: doName,
        messageId: clean.messageId || "",
        fileId: recentAsset.file_id || ""
      });
      return attachAssetAsReferencedMedia(clean, recentAsset, "recent_fallback");
    }
  }

  return clean;
}

function attachAssetAsReferencedMedia(message, asset, source) {
  const clean = Object.assign({}, message || {});
  const mediaItem = {
    type: String(asset.media_type || "IMAGE").toUpperCase(),
    fileId: String(asset.file_id || ""),
    mimeType: String(asset.mime_type || ""),
    fileName: "",
    caption: String(asset.caption || ""),
    referenced: true,
    referenceSource: source
  };
  clean.media = (clean.media || []).concat([mediaItem]).filter(function (item) {
    return item && item.fileId;
  });
  clean.referencedMedia = (clean.referencedMedia || []).concat([{
    fileId: mediaItem.fileId,
    messageId: String(asset.message_id || ""),
    source: source,
    url: String(asset.url || "")
  }]);
  if (["TEXT", "AUDIO"].includes(String(clean.type || "").toUpperCase())) {
    logEvent("AUDIO_TEXT_WITH_REFERENCED_MEDIA", {
      traceId: clean.traceId || "",
      turnId: clean.turnId || "",
      messageId: clean.messageId || "",
      type: clean.type || "",
      fileId: mediaItem.fileId,
      source: source
    });
  }
  return clean;
}

function findReferencedMediaAsset(data, ref) {
  const messageId = String(ref && ref.messageId || "");
  const fileId = String(ref && ref.fileId || "");
  const recent = normalizeRecentMedia(data && data.recentMedia || []);
  const recentAssets = normalizeRecentMediaAssets(data && data.recentMediaAssets || [])
    .map(recentMediaAssetToCampaignAsset)
    .filter(Boolean);
  const campaignAssets = normalizeCampaignAssets(data && data.campaignState && data.campaignState.campaign_assets || []);
  return recentAssets.concat(recent, campaignAssets).find(function (asset) {
    return fileId && asset.file_id === fileId || messageId && asset.message_id === messageId;
  }) || null;
}

function findRecentMediaAsset(data, now, maxAgeMs) {
  const current = Number(now || Date.now());
  const recentAssets = normalizeRecentMediaAssets(data && data.recentMediaAssets || [])
    .map(recentMediaAssetToCampaignAsset)
    .filter(Boolean);
  const recent = recentAssets.concat(normalizeRecentMedia(data && data.recentMedia || []));
  return recent.slice().reverse().find(function (asset) {
    const at = Date.parse(asset.received_at || "") || 0;
    return asset.file_id && (!at || current - at <= maxAgeMs);
  }) || null;
}

function shouldUseRecentMediaFallbackForMessage(message) {
  const type = String(message && message.type || "").toUpperCase();
  if (!["TEXT", "AUDIO"].includes(type)) return false;
  const text = normalizeTextForIntent(message && (message.text || message.audioTranscript) || "");
  if (!text) return false;
  return /\b(esta imagen|esa imagen|la imagen|esta foto|esa foto|esto|esta parte|esta|esa)\b/.test(text);
}

function normalizeCoreUtilityState(state) {
  const clean = state && typeof state === "object" ? state : {};
  const listsState = normalizeListState(clean.listsState || { lists: clean.lists || {} });

  return {
    reminders: Array.isArray(clean.reminders) ? clean.reminders.slice(-100) : [],
    listsState: listsState,
    lists: listsState.lists,
    activeList: String(clean.activeList || clean.active_list || "")
  };
}

function createEmptyConversationContext(reason) {
  return {
    activeIntent: "general",
    contextId: "ctx_" + Date.now() + "_" + randomId(6),
    lastUserGoal: "",
    pendingClarification: "",
    lastOfferedAction: "",
    lastOfferedIntent: "",
    lastOfferedAt: "",
    currentTurnMedia: emptyMediaContext(),
    previousRelevantMedia: emptyMediaContext(),
    staleMedia: emptyMediaContext(),
    resetReason: String(reason || ""),
    updatedAt: new Date().toISOString()
  };
}

function normalizeConversationContext(context) {
  const clean = context && typeof context === "object" ? context : {};
  const empty = createEmptyConversationContext("normalize_default");

  return {
    activeIntent: String(clean.activeIntent || clean.active_intent || empty.activeIntent),
    contextId: String(clean.contextId || clean.context_id || empty.contextId),
    lastUserGoal: String(clean.lastUserGoal || clean.last_user_goal || ""),
    pendingClarification: String(clean.pendingClarification || clean.pending_clarification || ""),
    currentTurnMedia: normalizeMediaContext(clean.currentTurnMedia || clean.current_turn_media || {}),
    previousRelevantMedia: normalizeMediaContext(clean.previousRelevantMedia || clean.previous_relevant_media || {}),
    staleMedia: normalizeMediaContext(clean.staleMedia || clean.stale_media || {}),
    lastOfferedAction: String(clean.lastOfferedAction || clean.last_offered_action || ""),
    lastOfferedIntent: String(clean.lastOfferedIntent || clean.last_offered_intent || ""),
    lastOfferedAt: String(clean.lastOfferedAt || clean.last_offered_at || ""),
    resetReason: String(clean.resetReason || clean.reset_reason || ""),
    updatedAt: String(clean.updatedAt || clean.updated_at || new Date().toISOString())
  };
}

function updateConversationContext(context, params) {
  const current = normalizeConversationContext(context);
  const userTurn = params && params.userTurn || {};
  const route = params && params.route || {};
  const campaignState = params && params.campaignState || {};
  const activeIntent = route.intent || inferActiveIntentFromTurn(userTurn) || current.activeIntent || "general";
  const shouldOpenNewContext = shouldOpenNewContextFromTurn(current, userTurn, activeIntent);

  return {
    activeIntent: activeIntent,
    contextId: shouldOpenNewContext ? "ctx_" + Date.now() + "_" + randomId(6) : current.contextId,
    lastUserGoal: String(params && params.lastUserGoal || userTurn.current_turn_text || current.lastUserGoal || "").slice(0, 500),
    pendingClarification: String(params && Object.prototype.hasOwnProperty.call(params, "pendingClarification") ? params.pendingClarification : current.pendingClarification || ""),
    currentTurnMedia: normalizeMediaContext(userTurn.currentTurnMedia || userTurn.current_turn_media || {}),
    previousRelevantMedia: normalizeMediaContext(userTurn.previousRelevantMedia || userTurn.previous_relevant_media || {}),
    staleMedia: normalizeMediaContext(userTurn.staleMedia || userTurn.stale_media || summarizeStaleMedia(campaignState, userTurn)),
    lastOfferedAction: String(params && Object.prototype.hasOwnProperty.call(params, "lastOfferedAction") ? params.lastOfferedAction : current.lastOfferedAction || ""),
    lastOfferedIntent: String(params && Object.prototype.hasOwnProperty.call(params, "lastOfferedIntent") ? params.lastOfferedIntent : current.lastOfferedIntent || ""),
    lastOfferedAt: String(params && Object.prototype.hasOwnProperty.call(params, "lastOfferedAt") ? params.lastOfferedAt : current.lastOfferedAt || ""),
    resetReason: "",
    updatedAt: new Date().toISOString()
  };
}

function shouldOpenNewContextFromTurn(context, userTurn, activeIntent) {
  const turn = userTurn || {};
  const current = normalizeConversationContext(context);
  if (!current.contextId) return true;
  if (turn.context_policy === "new_request_from_current_turn") return true;
  if (activeIntent && current.activeIntent && activeIntent !== current.activeIntent && turn.context_policy !== "use_previous_context") return true;
  if (turn.currentTurnMedia && turn.currentTurnMedia.asset_count && activeIntent !== current.activeIntent) return true;
  return false;
}

function inferActiveIntentFromTurn(userTurn) {
  const text = normalizeTextForIntent(userTurn && userTurn.current_turn_text || "");
  if (!text) return "";
  if (shouldExitMarketingContext(text)) return "general";
  return "";
}

function emptyMediaContext() {
  return {
    asset_count: 0,
    image_count: 0,
    video_count: 0,
    file_count: 0,
    file_ids: []
  };
}

function normalizeMediaContext(value) {
  const clean = value && typeof value === "object" ? value : {};
  const fileIds = Array.isArray(clean.file_ids || clean.fileIds)
    ? (clean.file_ids || clean.fileIds).map(String).filter(Boolean)
    : [];

  return {
    asset_count: Number(clean.asset_count || clean.assetCount || 0),
    image_count: Number(clean.image_count || clean.imageCount || 0),
    video_count: Number(clean.video_count || clean.videoCount || 0),
    file_count: Number(clean.file_count || clean.fileCount || 0),
    file_ids: fileIds
  };
}

function summarizeAssetsForContext(assets) {
  const list = normalizeCampaignAssets(assets || []);
  return {
    asset_count: list.length,
    image_count: list.filter(function (asset) { return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE"; }).length,
    video_count: list.filter(function (asset) { return String(asset.media_type || "").toUpperCase() === "VIDEO"; }).length,
    file_count: list.filter(function (asset) { return String(asset.media_type || "").toUpperCase() === "FILE"; }).length,
    file_ids: list.map(function (asset) { return asset.file_id; }).filter(Boolean)
  };
}

function summarizeStaleMedia(campaignState, userTurn) {
  const allAssets = normalizeCampaignAssets(campaignState && campaignState.campaign_assets || []);
  const currentIds = new Set([]
    .concat(userTurn && userTurn.currentTurnMedia && userTurn.currentTurnMedia.file_ids || [])
    .concat(userTurn && userTurn.previousRelevantMedia && userTurn.previousRelevantMedia.file_ids || []));
  const stale = allAssets.filter(function (asset) {
    return !currentIds.has(asset.file_id);
  });

  return summarizeAssetsForContext(stale);
}

function buildContextSnapshot(data) {
  const context = normalizeConversationContext(data && data.activeContext || {});

  return {
    activeIntent: context.activeIntent,
    contextId: context.contextId,
    lastUserGoal: context.lastUserGoal,
    pendingClarification: context.pendingClarification,
    lastOfferedAction: context.lastOfferedAction,
    activeList: data && data.coreUtilityState && data.coreUtilityState.activeList || "",
    pendingReminders: countPendingReminders(data && data.coreUtilityState && data.coreUtilityState.reminders || []),
    currentTurnMedia: context.currentTurnMedia.asset_count,
    previousRelevantMedia: context.previousRelevantMedia.asset_count,
    staleMedia: context.staleMedia.asset_count
  };
}

function formatContextForWhatsApp(data) {
  const snapshot = buildContextSnapshot(data || {});

  return [
    "Contexto actual",
    "activeIntent: " + snapshot.activeIntent,
    "contextId: " + snapshot.contextId,
    "lastUserGoal: " + (snapshot.lastUserGoal || "(vacio)"),
    "pendingClarification: " + (snapshot.pendingClarification || "(ninguna)"),
    "activeList: " + (snapshot.activeList || "(ninguna)"),
    "pending reminders count: " + snapshot.pendingReminders,
    "currentTurnMedia count: " + snapshot.currentTurnMedia,
    "previousRelevantMedia count: " + snapshot.previousRelevantMedia,
    "staleMedia count: " + snapshot.staleMedia
  ].join("\n");
}

function formatDebugMediaForWhatsApp(data, now) {
  const current = Number(now || Date.now());
  const recent = normalizeRecentMediaAssets(data && data.recentMediaAssets || []);
  const pending = Array.isArray(data && data.pendingMessages) ? data.pendingMessages : [];
  const rows = recent.slice(-8).map(function (asset, index) {
    const at = Date.parse(asset.receivedAt || "") || current;
    const ageSeconds = Math.max(0, Math.round((current - at) / 1000));
    return [
      String(index + 1) + ".",
      "fileId=" + shortMediaId(asset.fileId),
      "turnId=" + shortMediaId(asset.turnId),
      "age=" + ageSeconds + "s"
    ].join(" ");
  });

  return [
    "Debug media",
    "recentMediaAssets count: " + recent.length,
    "pendingCount: " + pending.length,
    "currentTurnId: " + shortMediaId(data && data.currentTurnId || ""),
    rows.length ? rows.join("\n") : "(sin media reciente)"
  ].join("\n");
}

function clearMediaState(data, reason) {
  const next = normalizeCoordinatorData(data || {});
  next.recentMediaAssets = [];
  next.campaignState.campaign_assets = [];
  next.campaignState.media_batch_summary = null;
  next.campaignState.last_uploaded_image = null;
  next.campaignState.uploaded_image_analysis = null;
  next.campaignState.current_asset_source = "";
  next.campaignState.collecting_assets = false;
  if (["collecting_assets", "waiting_asset_usage_decision", "media_received"].includes(next.campaignState.workflow_status)) {
    next.campaignState.workflow_status = "idle";
    next.campaignState.expected_next_target = "unknown";
  }
  next.activeContext = Object.assign({}, normalizeConversationContext(next.activeContext), {
    currentTurnMedia: emptyMediaContext(),
    previousRelevantMedia: emptyMediaContext(),
    staleMedia: emptyMediaContext(),
    resetReason: String(reason || ""),
    updatedAt: new Date().toISOString()
  });

  logEvent("MEDIA_CONTEXT_CLEARED", {
    doName: next.doName || "",
    reason: reason || ""
  });

  return next;
}

function forgetAllConversationData(data, reason) {
  let next = normalizeCoordinatorData(data || {});
  next.pendingMessages = [];
  next.hasMedia = false;
  next.processing = false;
  next.processingStartedAt = null;
  next.firstMessageAt = 0;
  next.lastMessageAt = 0;
  next.processAfter = 0;
  next.currentTraceId = "";
  next.currentTurnId = "";
  next.recentMediaAssets = [];
  next = resetCampaignState(next, reason || "forget_all");
  next.activeContext = createEmptyConversationContext(reason || "forget_all");
  next.coreUtilityState = normalizeCoreUtilityState({});
  next.customerMemory = null;
  next.userStyleProfile = null;
  next.conversationSummary = null;
  next.utilityMemory = null;
  next.conversationLog = [];
  return next;
}

function isForgetAllText(text) {
  const normalized = normalizeTextForIntent(text);
  return /\b(resetea todo|borra todo|olvida todo|limpia todo|elimina todo)\b/.test(normalized);
}

function formatUserMemoryForWhatsApp(data) {
  const memory = data && data.customerMemory || {};
  const style = data && data.userStyleProfile || {};
  const utility = data && data.utilityMemory || {};
  const lines = [
    "Memoria guardada",
    "Nombre: " + (memory.name || "(no guardado)"),
    "Idioma: " + (memory.language || style.language || "(no detectado)"),
    "Estilo: " + (memory.response_preference || memory.style_preference || style.tone || "(sin preferencia)"),
    "Listas: " + ((utility.list_names || []).join(", ") || "(sin listas en memoria resumida)"),
    "Recordatorios pendientes: " + String(utility.reminder_count || 0)
  ];

  return lines.join("\n");
}

function formatReminderDebugForWhatsApp(decision) {
  const clean = decision || {};
  return [
    "Debug template reminder",
    "path: " + (clean.path || ""),
    "within24h: " + String(Boolean(clean.within24h)),
    "templateConfigured: " + String(Boolean(clean.templateConfigured)),
    "templateName: " + (clean.template && clean.template.name || "(no configurado)")
  ].join("\n");
}

function buildReminderForConversation(parsed, data, env, userTurn) {
  const clean = parsed || {};
  const mode = getReminderDeliveryMode(env);
  const lastInteraction = data && data.lastMessageAt
    ? new Date(data.lastMessageAt).toISOString()
    : new Date().toISOString();

  return Object.assign({}, clean, {
    userId: data && (data.phone || data.doName) || "",
    channelId: data && data.channel || "",
    memberId: data && data.member || "",
    appId: data && data.app || "",
    recipientId: data && data.phone || "",
    message: clean.message || clean.title || "",
    sourceContext: {
      turnId: userTurn && (userTurn.turn_id || userTurn.turnId) || "",
      traceId: userTurn && (userTurn.trace_id || userTurn.traceId) || "",
      currentTurnText: userTurn && userTurn.current_turn_text || clean.context || ""
    },
    lastUserInteractionAt: lastInteraction,
    deliveryMode: mode,
    requiresTemplateIfOutside24h: true,
    status: mode === "alarm" ? "scheduled_alarm" : "scheduled_mock"
  });
}

function applySupervisorMemoryUpdates(memory, updates) {
  const next = Object.assign({}, memory || {});
  for (const update of Array.isArray(updates) ? updates : []) {
    if (!update || !update.type) continue;
    if (update.type === "user_name") next.name = String(update.value || "").slice(0, 80);
    if (update.type === "response_preference") {
      next.response_preference = String(update.value || "").slice(0, 180);
      next.style_preference = next.response_preference;
    }
  }
  next.source = next.source || "safe_optional_memory_v1";
  next.updated_at = new Date().toISOString();
  return next;
}

function applySupervisorMediaScope(userTurn, supervisorPlan, campaignState, messages) {
  const plan = supervisorPlan || {};
  let selected = userTurn.media_batch || { assets: [] };

  if (plan.mediaScope === "previous_relevant") {
    selected = buildMediaBatch(campaignState, messages, { turnId: userTurn.turn_id, mode: "previous_relevant" });
  } else if (plan.mediaScope === "current_and_previous") {
    const current = buildMediaBatch(campaignState, messages, { turnId: userTurn.turn_id, mode: "current_turn" });
    const previous = buildMediaBatch(campaignState, messages, { turnId: userTurn.turn_id, mode: "previous_relevant" });
    selected = mergeMediaBatches(current, previous);
  } else if (plan.mediaScope === "all_pending_batch" || plan.mediaScope === "current_only") {
    selected = buildMediaBatch(campaignState, messages, { turnId: userTurn.turn_id, mode: "current_turn" });
  }

  userTurn.media_batch = selected;
  userTurn.media_batch_summary = buildMediaBatchSummary(selected);
  userTurn.image_count = selected.assets.filter(function (asset) {
    return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
  }).length;
  userTurn.current_turn_media = summarizeAssetsForContext(selected.assets);
  userTurn.currentTurnMedia = userTurn.current_turn_media;
}

function shouldUseRecentMediaAssetsForTurn(userTurn, messages) {
  const text = normalizeTextForIntent([
    userTurn && (userTurn.combinedUserText || userTurn.current_turn_text) || "",
    consolidatedMessagesText(messages || [])
  ].filter(Boolean).join("\n"));
  if (!text) return false;
  return /\b(listo|ya|eso es todo|esas son|dale|revisa|te mande \d+ imagenes|te mandé \d+ imágenes|te mande imagenes|te mandé imágenes|como no puedes ver|esta imagen|esa imagen|la imagen|esta parte|esta foto|esa foto|esto)\b/.test(text) ||
    isUserClaimingMoreImages(text);
}

function shouldUseRecentMediaAssetsForFollowup(userTurn, data, messages) {
  const context = normalizeConversationContext(data && data.activeContext || {});
  const text = normalizeTextForIntent([
    userTurn && (userTurn.combinedUserText || userTurn.current_turn_text) || "",
    consolidatedMessagesText(messages || [])
  ].filter(Boolean).join("\n"));

  return Boolean(context.lastOfferedAction && isAffirmativeMediaFollowupText(text));
}

function isAffirmativeMediaFollowupText(text) {
  const normalized = normalizeTextForIntent(text);
  if (!normalized) return false;
  return /^(si|sí|sii|si porfa|sí porfa|porfa|claro|dale|ok|okay|hazlo|de una|si dale|sí dale|si gracias|sí gracias)\.?$/.test(normalized) ||
    /\b(si|sí|claro|dale|ok|porfa|por favor)\b/.test(normalized) && normalized.length <= 40;
}

function collectRelevantMediaForTurn(userTurn, data, messages, options) {
  const turn = userTurn || {};
  const cleanData = normalizeCoordinatorData(data || {});
  const now = Number(options && options.now || Date.now());
  const maxAgeMs = Number(options && options.maxAgeMs || 180000);
  const traceId = turn.trace_id || cleanData.currentTraceId || "";
  const turnId = turn.turn_id || cleanData.currentTurnId || "";
  const doName = cleanData.doName || "";
  const selected = [];

  logEvent("RELEVANT_MEDIA_COLLECT_START", {
    traceId: traceId,
    turnId: turnId,
    doName: doName,
    currentImageCount: countUserTurnImages(turn)
  });

  for (const asset of normalizeCampaignAssets(turn.media_batch && turn.media_batch.assets || [])) {
    selected.push(asset);
  }

  for (const message of messages || []) {
    for (const reference of message.referencedMedia || []) {
      const asset = findReferencedMediaAsset(cleanData, {
        messageId: reference.messageId || "",
        fileId: reference.fileId || ""
      });
      if (asset) selected.push(asset);
    }
  }

  const wantsRecent = shouldUseRecentMediaAssetsForTurn(turn, messages) ||
    shouldUseRecentMediaAssetsForFollowup(turn, cleanData, messages) ||
    countUserTurnImages(turn) > 0 && getRecentMediaAssets(cleanData, now, maxAgeMs).length > countUserTurnImages(turn);
  if (wantsRecent) {
    const recent = getRecentMediaAssets(cleanData, now, maxAgeMs)
      .map(recentMediaAssetToCampaignAsset)
      .filter(Boolean);
    if (recent.length) {
      logEvent("RELEVANT_MEDIA_FROM_RECENT", {
        traceId: traceId,
        turnId: turnId,
        doName: doName,
        count: recent.length,
        fileIds: recent.map(function (asset) { return asset.file_id; }).filter(Boolean)
      });
      selected.push.apply(selected, recent);
    }

    const recentCampaignAssets = normalizeCampaignAssets(cleanData.campaignState.campaign_assets || []).filter(function (asset) {
      const at = Date.parse(asset.received_at || "") || 0;
      return asset.file_id && (!at || now - at <= maxAgeMs);
    });
    selected.push.apply(selected, recentCampaignAssets);
  }

  const beforeDedupe = selected.length;
  const assets = normalizeCampaignAssets(selected).filter(function (asset, index, list) {
    const id = asset.file_id || asset.message_id || "";
    return id && list.findIndex(function (candidate) {
      return (candidate.file_id || candidate.message_id || "") === id;
    }) === index;
  });
  if (beforeDedupe !== assets.length) {
    logEvent("MEDIA_BATCH_DEDUPED", {
      traceId: traceId,
      turnId: turnId,
      before: beforeDedupe,
      after: assets.length,
      reason: "relevant_media_collection"
    });
  }

  logEvent("RELEVANT_MEDIA_FINAL_COUNT", {
    traceId: traceId,
    turnId: turnId,
    doName: doName,
    count: assets.length,
    imageCount: assets.filter(function (asset) { return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE"; }).length
  });
  logEvent("RELEVANT_MEDIA_FINAL_FILE_IDS", {
    traceId: traceId,
    turnId: turnId,
    doName: doName,
    fileIds: assets.map(function (asset) { return asset.file_id; }).filter(Boolean)
  });

  return {
    assets: assets,
    fileIds: assets.map(function (asset) { return asset.file_id; }).filter(Boolean),
    assetCount: assets.length,
    analyzedAssetCount: assets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; }).length,
    failedAssetCount: assets.filter(function (asset) { return asset.status === "analysis_failed"; }).length
  };
}

function applyRelevantMediaToUserTurn(userTurn, mediaBatch, messages) {
  const batch = mediaBatch || { assets: [] };
  userTurn.media_batch = batch;
  userTurn.media_batch_summary = buildMediaBatchSummary(batch);
  userTurn.image_count = batch.assets.filter(function (asset) {
    return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
  }).length;
  userTurn.video_count = Math.max(userTurn.video_count || 0, batch.assets.filter(function (asset) {
    return String(asset.media_type || "").toUpperCase() === "VIDEO";
  }).length);
  userTurn.file_count = Math.max(userTurn.file_count || 0, batch.assets.filter(function (asset) {
    return String(asset.media_type || "").toUpperCase() === "FILE";
  }).length);
  userTurn.current_turn_media = summarizeAssetsForContext(batch.assets);
  userTurn.currentTurnMedia = userTurn.current_turn_media;
  attachUserTurnContract(userTurn, messages || userTurn.messages || [], batch);
  return userTurn;
}

function mergeMediaBatches(first, second) {
  const byFileId = new Map();
  for (const asset of [].concat(first && first.assets || [], second && second.assets || [])) {
    if (!asset || !asset.file_id) continue;
    byFileId.set(asset.file_id, asset);
  }
  const assets = Array.from(byFileId.values());
  return {
    assets: assets,
    fileIds: assets.map(function (asset) { return asset.file_id; }).filter(Boolean),
    assetCount: assets.length,
    analyzedAssetCount: assets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; }).length,
    failedAssetCount: assets.filter(function (asset) { return asset.status === "analysis_failed"; }).length
  };
}

function shouldSupervisorHandleVision(supervisorPlan, userTurn) {
  const plan = supervisorPlan || {};
  return plan.responseStrategy === "analyze_then_answer" &&
    (plan.targetModules || []).includes("vision") &&
    userTurn && userTurn.media_batch && userTurn.media_batch.assets && userTurn.media_batch.assets.length > 0;
}

function mapSupervisorVisionIntent(intent) {
  if (intent === "image_ocr") return "image_ocr";
  return intent || "image_question";
}

function logSupervisorPlan(plan, userTurn, data, recentConversationWindow) {
  const payload = {
    traceId: userTurn && userTurn.trace_id || "",
    turnId: userTurn && userTurn.turn_id || "",
    doName: data && data.doName || "",
    intent: plan.intent,
    activeTask: plan.activeTask,
    isContinuation: plan.isContinuation,
    isContextSwitch: plan.isContextSwitch,
    mediaScope: plan.mediaScope,
    targetModules: plan.targetModules,
    recentWindowCount: Array.isArray(recentConversationWindow) ? recentConversationWindow.length : 0
  };

  logEvent("SUPERVISOR_PLAN_CREATED", payload);
  logEvent("SUPERVISOR_CONTEXT_WINDOW_USED", Object.assign({}, payload, {
    recentWindowCount: payload.recentWindowCount
  }));
  if (plan.isContextSwitch) logEvent("SUPERVISOR_CONTEXT_SWITCH_DETECTED", payload);
  if (plan.isContinuation) logEvent("SUPERVISOR_CONTINUATION_DETECTED", payload);
  logEvent("SUPERVISOR_MEDIA_SCOPE_SELECTED", Object.assign({}, payload, { mediaScope: plan.mediaScope }));
  logEvent("SUPERVISOR_MODULES_SELECTED", Object.assign({}, payload, { targetModules: plan.targetModules }));
}

function isVisionUtilityRoute(route) {
  return route && (route.intent === "image_question" || route.intent === "image_ocr");
}

function shouldExitMarketingContext(text) {
  const normalized = normalizeTextForIntent(text);
  return /\b(no quiero|ya no quiero|deja de)\s+(post|posts|marketing|campana|campanas|contenido)\b/.test(normalized) ||
    /\b(asistente general|asistente neutral|no marketing)\b/.test(normalized);
}

function isExplicitMarketingRequest(text) {
  const normalized = normalizeTextForIntent(text);
  if (shouldExitMarketingContext(normalized)) return false;
  return /\b(post|posts|copy|caption|instagram|facebook|tiktok|redes sociales|campana|campanas|anuncio|ads|publicidad|publicacion|publicaciones|hashtag|calendario editorial|calendario de contenido|contenido para redes)\b/.test(normalized);
}

function isMarketingRoute(route, userTurn) {
  return Boolean(route && route.intent === "marketing") || isExplicitMarketingRequest(extractPlainTurnText(userTurn && userTurn.current_turn_text || ""));
}

function hasActiveMarketingWorkflow(campaignState) {
  const state = normalizeCampaignState(campaignState || {});
  return Boolean(
    state.collecting_assets ||
    ["collecting_assets", "waiting_asset_usage_decision", "copy_ready", "calendar_pending_approval", "draft_pending_review"].includes(state.workflow_status) ||
    ["bulk_from_assets", "weekly_content_plan", "monthly_content_plan"].includes(state.campaign_type)
  );
}

function clearCampaignStateForGeneralIntent(campaignState, meta) {
  const state = normalizeCampaignState(campaignState || {});
  if (!hasActiveMarketingWorkflow(state)) return state;

  logEvent("CAMPAIGN_STATE_IGNORED_FOR_GENERAL_INTENT", {
    traceId: meta && meta.traceId || "",
    turnId: meta && meta.turnId || "",
    doName: meta && meta.doName || "",
    intent: meta && meta.intent || "",
    previousWorkflowStatus: state.workflow_status,
    previousCampaignType: state.campaign_type
  });
  logEvent("CAMPAIGN_STATE_CLEARED_FOR_CONTEXT_SWITCH", {
    traceId: meta && meta.traceId || "",
    turnId: meta && meta.turnId || "",
    doName: meta && meta.doName || "",
    intent: meta && meta.intent || ""
  });

  return Object.assign({}, state, {
    active_topic: "",
    campaign_type: "single_post",
    workflow_status: "idle",
    expected_next_target: "unknown",
    collecting_assets: false,
    content_calendar: [],
    bulk_posts: [],
    current_asset_source: "",
    campaign_summary: "",
    product: "",
    objective: "",
    platforms: [],
    draft_status: "",
    approval_status: "",
    publish_status: "",
    ready_to_publish: false,
    updated_at: new Date().toISOString()
  });
}

async function sendWoztellTemplateMessage(env, params) {
  const template = params.template || {};
  if (!template.name) {
    throw new Error("REMINDER_TEMPLATE_NAME_REQUIRED");
  }

  return await sendWoztellResponse(env, {
    channelId: params.channelId,
    recipientId: params.recipientId,
    memberId: params.memberId,
    appId: params.appId,
    logPrefix: "WOZTELL_TEMPLATE_SEND",
    response: [
      {
        type: "TEMPLATE",
        templateName: template.name,
        language: template.language || "es",
        namespace: template.namespace || "",
        paramMode: template.paramMode || "body_text",
        params: [String(params.message || "")]
      }
    ]
  });
}

function resolveReminderReferences(parsed, activeContext) {
  const clean = Object.assign({}, parsed || {});
  const context = normalizeConversationContext(activeContext || {});
  const title = String(clean.title || "").trim();

  if (/\b(eso|esto|lo anterior|esa lista|la lista)\b/i.test(title) && context.lastUserGoal) {
    clean.title = title.replace(/\b(eso|esto|lo anterior|esa lista|la lista)\b/ig, context.lastUserGoal).replace(/\s+/g, " ").trim();
    clean.context = [clean.context || "", "Referencia resuelta: " + context.lastUserGoal].filter(Boolean).join("\n");
  }

  if (!clean.title && context.lastUserGoal && Array.isArray(clean.missingFields) && clean.missingFields.includes("title")) {
    clean.title = context.lastUserGoal;
    clean.context = [clean.context || "", "Referencia resuelta: " + context.lastUserGoal].filter(Boolean).join("\n");
    clean.missingFields = clean.missingFields.filter(function (field) {
      return field !== "title";
    });
  }

  return clean;
}

function formatListGoal(list) {
  const clean = list || {};
  const items = Array.isArray(clean.items) ? clean.items.map(function (item) { return item.text; }).filter(Boolean) : [];
  return "lista " + (clean.name || "pendientes") + (items.length ? ": " + items.join(", ") : "");
}

function formatVisionUtilityResponse(intent, summary, userTurn) {
  const data = summary || {};
  const assets = Array.isArray(data.assets) ? data.assets : [];
  const question = extractPlainTurnText(userTurn && userTurn.current_turn_text || "");
  const normalizedQuestion = normalizeTextForIntent(question);
  const visibleTexts = assets.map(function (asset) {
    return asset.analysis && asset.analysis.visible_text || "";
  }).filter(Boolean);
  const subjects = assets.map(function (asset) {
    const analysis = asset.analysis || {};
    return analysis.main_subject || analysis.product_type || analysis.brand_or_labels || "";
  }).filter(Boolean);
  const objects = Array.from(new Set(assets.flatMap(function (asset) {
    return asset.analysis && Array.isArray(asset.analysis.objects_detected) ? asset.analysis.objects_detected : [];
  }).filter(Boolean)));

  if (intent === "image_ocr") {
    if (!visibleTexts.length) {
      return "No encontré texto legible en la imagen" + (assets.length > 1 ? "es" : "") + ".";
    }

    return ["Texto extraido"].concat(visibleTexts.map(function (text, index) {
      return (visibleTexts.length > 1 ? "Imagen " + (index + 1) + ": " : "") + text;
    })).join("\n");
  }

  if (intent === "image_question" && /\b(que tal|como lo ves|vale la pena|conviene|recomiendas|bueno|buena)\b/.test(normalizedQuestion)) {
    const subject = subjects[0] || "el producto";
    const visible = visibleTexts.length ? " En la imagen se alcanza a ver: " + visibleTexts.join(" | ") + "." : "";
    const brand = assets.map(function (asset) {
      return asset.analysis && asset.analysis.brand_or_labels || "";
    }).filter(Boolean)[0] || "";
    const brandText = brand ? " " + brand : "";

    return [
      "Se ve bien como " + subject + brandText + ", con la cautela de que solo puedo evaluar lo visible en la foto." + visible,
      "Antes de comprarlo revisaria el modelo exacto, potencia/watts, bateria, resistencia al agua, garantia y si es original.",
      visibleTexts.join(" ").includes("$") ? "Por el precio visible podria estar bien si es original y cumple esas especificaciones." : "",
      data.failed_asset_count ? "Nota: " + data.failed_asset_count + " imagen(es) no se pudieron analizar." : ""
    ].filter(Boolean).join("\n");
  }

  return [
    question ? "Sobre tu pregunta: " + question : "Listo, revise la imagen.",
    subjects.length ? "Veo: " + subjects.join(" | ") : "",
    objects.length ? "Objetos detectados: " + objects.join(", ") : "",
    visibleTexts.length ? "Texto visible: " + visibleTexts.join(" | ") : "",
    data.failed_asset_count ? "Nota: " + data.failed_asset_count + " imagen(es) no se pudieron analizar." : "",
    userTurn && userTurn.context_policy === "use_previous_context" ? "Usé la media anterior que mencionaste." : ""
  ].filter(Boolean).join("\n");
}

function buildMediaFollowupPrompt(intent, summary) {
  const action = inferMediaFollowupAction(intent, summary, {});
  if (action === "image_ocr") return "awaiting_media_followup:image_ocr";
  if (action === "multi_image_review") return "awaiting_media_followup:multi_image_review";
  return "awaiting_media_followup:image_question";
}

function inferMediaFollowupAction(intent, summary, userTurn) {
  if (intent === "image_ocr") return "image_ocr";
  const assets = Array.isArray(summary && summary.assets) ? summary.assets : [];
  const hasVisibleText = assets.some(function (asset) {
    return Boolean(asset && asset.analysis && String(asset.analysis.visible_text || "").trim());
  });
  if (hasVisibleText) return "image_ocr";
  if (Number(userTurn && userTurn.image_count || assets.length || 0) > 1) return "multi_image_review";
  return "image_question";
}

function formatListForWhatsApp(list) {
  const clean = list || { name: "pendientes", items: [] };
  const items = Array.isArray(clean.items) ? clean.items : [];

  if (!items.length) {
    return "La lista " + clean.name + " está vacía.";
  }

  return ["Lista: " + clean.name].concat(items.map(function (item, index) {
    return (index + 1) + ". " + (item.done ? "[hecho] " : "") + item.text;
  })).join("\n");
}

function formatListConfirmationForWhatsApp(parsed, list, userTurn) {
  const clean = list || { name: "pendientes", items: [] };
  const items = Array.isArray(clean.items) ? clean.items : [];
  const itemTexts = items.map(function (item) { return item.text; }).filter(Boolean);
  const action = parsed && parsed.action || "list";
  const fromAudio = userTurn && userTurn.audio_count > 0;

  if (!items.length) return "La lista " + clean.name + " está vacía.";
  if (action === "add" || action === "create") {
    return "Listo, " + (fromAudio ? "creé" : "actualicé") + " tu lista de " + clean.name + " con: " + itemTexts.join(", ") + ".";
  }
  if (action === "remove") {
    return "Listo, actualicé tu lista de " + clean.name + ".\n" + formatListForWhatsApp(clean);
  }
  if (action === "mark_done") {
    return "Listo, marqué el item en tu lista de " + clean.name + ".\n" + formatListForWhatsApp(clean);
  }

  return formatListForWhatsApp(clean);
}

function formatListsIndexForWhatsApp(coreUtilityState) {
  const state = normalizeCoreUtilityState(coreUtilityState || {});
  const lists = Object.values(state.lists || {});

  if (!lists.length) {
    return "Todavía no tienes listas guardadas. Puedes decir: Hazme una lista de compras con arroz y pollo.";
  }

  return ["Listas guardadas"].concat(lists.map(function (list, index) {
    const count = Array.isArray(list.items) ? list.items.length : 0;
    const active = state.activeList && normalizeSimpleName(state.activeList) === normalizeSimpleName(list.name) ? " (activa)" : "";
    return (index + 1) + ". " + list.name + active + " - " + count + " item(s)";
  })).join("\n");
}

function formatRemindersForWhatsApp(reminders, env) {
  const mode = getReminderDeliveryMode(env);
  const items = listReminders(reminders || []).filter(function (item) {
    return !["cancelled", "done"].includes(item.status);
  });

  if (!items.length) {
    return "No tienes recordatorios pendientes.";
  }

  return ["Recordatorios pendientes", "modo: " + mode].concat(items.map(function (item, index) {
    return (index + 1) + ". " + item.title + (item.dueAt ? " - " + item.dueAt : "") + " [" + (item.status || "scheduled_mock") + "]";
  })).join("\n");
}

function countPendingReminders(reminders) {
  return (Array.isArray(reminders) ? reminders : []).filter(function (item) {
    return !["cancelled", "done"].includes(item.status);
  }).length;
}

function resolveActiveListName(parsed, coreUtilityState) {
  const route = parsed || {};
  const state = normalizeCoreUtilityState(coreUtilityState || {});
  const requested = String(route.listName || "").trim();

  if (requested && requested !== "pendientes") return requested;
  if (state.activeList) return state.activeList;
  if (requested) return requested;
  return "pendientes";
}

function cancelReminderByText(reminders, text) {
  const list = Array.isArray(reminders) ? reminders : [];
  const target = normalizeSimpleName(text);
  let cancelled = null;

  const next = list.map(function (item) {
    if (cancelled || ["cancelled", "done"].includes(item.status)) return item;
    const title = normalizeSimpleName(item.title || "");
    if (!target || !title.includes(target) && !target.includes(title)) return item;
    cancelled = Object.assign({}, item, {
      status: "cancelled",
      updatedAt: new Date().toISOString()
    });
    return cancelled;
  });

  if (cancelled) {
    logEvent("REMINDER_CANCEL_OK", {
      reminderId: cancelled.id,
      title: cancelled.title
    });
  }

  return {
    reminders: next,
    cancelled: cancelled
  };
}

function formatReminderCreatedForWhatsApp(reminder, env) {
  const mode = getReminderDeliveryMode(env);
  const deliveryNote = mode === "alarm"
    ? "Modo entrega: alarmas del Durable Object."
    : mode === "cron"
      ? "Modo entrega: scheduler/cron."
      : mode === "disabled"
        ? "Modo entrega: desactivado, solo queda guardado."
        : "Modo prueba: quedó guardado, no se enviará automáticamente hasta activar scheduler real.";

  return [
    "Listo, guardé el recordatorio.",
    "Asunto: " + (reminder.title || ""),
    reminder.dueAt ? "Fecha: " + reminder.dueAt : "",
    reminder.reminderOffsets && reminder.reminderOffsets.length ? "Avisos: " + reminder.reminderOffsets.join(", ") : "",
    deliveryNote
  ].filter(Boolean).join("\n");
}

function getReminderDeliveryMode(env) {
  const mode = String(env && env.REMINDERS_DELIVERY_MODE || "mock").toLowerCase();
  return ["mock", "alarm", "cron", "disabled"].includes(mode) ? mode : "mock";
}

function normalizeSimpleName(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

function normalizeClientProfile(profile) {
  const clean = profile || {};

  return {
    name: String(clean.name || ""),
    phone: String(clean.phone || ""),
    business_name: String(clean.business_name || clean.businessName || ""),
    preferences: typeof clean.preferences === "object" && clean.preferences ? clean.preferences : {},
    notes: String(clean.notes || ""),
    updated_at: String(clean.updated_at || clean.updatedAt || new Date().toISOString())
  };
}

function createEmptyCampaignState(reason) {
  const now = new Date().toISOString();

  return {
    campaign_id: "camp_" + Date.now() + "_" + randomId(6),
    active_topic: "",
    campaign_type: "single_post",
    workflow_status: "idle",
    expected_next_target: "unknown",
    collecting_assets: false,
    campaign_assets: [],
    active_task: null,
    task_media_assets: [],
    media_batch_summary: null,
    current_turn: null,
    active_turn: null,
    content_calendar: [],
    bulk_posts: [],
    last_copy: "",
    last_image_url: "",
    last_image_prompt: "",
    last_uploaded_image: null,
    uploaded_image_analysis: null,
    current_asset_source: "",
    campaign_summary: "",
    product: "",
    objective: "",
    platforms: [],
    draft_status: "",
    approval_status: "",
    publish_status: "",
    ready_to_publish: false,
    draft_version: 0,
    history: [],
    reset_reason: String(reason || ""),
    created_at: now,
    updated_at: now
  };
}

function normalizeCampaignState(state) {
  const clean = state || {};
  const empty = createEmptyCampaignState("normalize_default");

  return {
    campaign_id: String(clean.campaign_id || clean.campaignId || empty.campaign_id),
    active_topic: String(clean.active_topic || clean.activeTopic || ""),
    campaign_type: normalizeCampaignType(clean.campaign_type || clean.campaignType || "single_post"),
    workflow_status: String(clean.workflow_status || clean.workflowStatus || "idle"),
    expected_next_target: String(clean.expected_next_target || clean.expectedNextTarget || "unknown"),
    collecting_assets: Boolean(clean.collecting_assets || clean.collectingAssets || false),
    campaign_assets: normalizeCampaignAssets(clean.campaign_assets || clean.campaignAssets || []),
    active_task: normalizeActiveTask(clean.active_task || clean.activeTask || null),
    task_media_assets: normalizeCampaignAssets(clean.task_media_assets || clean.taskMediaAssets || []),
    media_batch_summary: clean.media_batch_summary || clean.mediaBatchSummary || null,
    current_turn: clean.current_turn || clean.currentTurn || null,
    active_turn: clean.active_turn || clean.activeTurn || null,
    content_calendar: normalizeContentCalendar(clean.content_calendar || clean.contentCalendar || []),
    bulk_posts: normalizeBulkPosts(clean.bulk_posts || clean.bulkPosts || []),
    last_copy: String(clean.last_copy || clean.lastCopy || ""),
    last_image_url: String(clean.last_image_url || clean.lastImageUrl || ""),
    last_image_prompt: String(clean.last_image_prompt || clean.lastImagePrompt || ""),
    last_uploaded_image: clean.last_uploaded_image || clean.lastUploadedImage || null,
    uploaded_image_analysis: clean.uploaded_image_analysis || clean.uploadedImageAnalysis || null,
    current_asset_source: String(clean.current_asset_source || clean.currentAssetSource || ""),
    campaign_summary: String(clean.campaign_summary || clean.campaignSummary || ""),
    product: String(clean.product || ""),
    objective: String(clean.objective || ""),
    platforms: Array.isArray(clean.platforms) ? clean.platforms.map(String) : [],
    draft_status: String(clean.draft_status || clean.draftStatus || ""),
    approval_status: String(clean.approval_status || clean.approvalStatus || ""),
    publish_status: String(clean.publish_status || clean.publishStatus || ""),
    ready_to_publish: Boolean(clean.ready_to_publish || clean.readyToPublish || false),
    draft_version: Number(clean.draft_version || clean.draftVersion || 0),
    history: Array.isArray(clean.history) ? clean.history.slice(-20) : [],
    reset_reason: String(clean.reset_reason || clean.resetReason || ""),
    created_at: String(clean.created_at || clean.createdAt || empty.created_at),
    updated_at: String(clean.updated_at || clean.updatedAt || new Date().toISOString())
  };
}

function normalizeCampaignStateUpdates(updates) {
  const clean = updates || {};
  const normalized = {};

  if (clean.active_topic || clean.activeTopic) normalized.active_topic = String(clean.active_topic || clean.activeTopic);
  if (clean.campaign_type || clean.campaignType) normalized.campaign_type = normalizeCampaignType(clean.campaign_type || clean.campaignType);
  if (clean.workflow_status || clean.workflowStatus) normalized.workflow_status = String(clean.workflow_status || clean.workflowStatus);
  if (clean.expected_next_target || clean.expectedNextTarget) normalized.expected_next_target = String(clean.expected_next_target || clean.expectedNextTarget);
  if (Object.prototype.hasOwnProperty.call(clean, "collecting_assets") || Object.prototype.hasOwnProperty.call(clean, "collectingAssets")) {
    normalized.collecting_assets = Boolean(clean.collecting_assets || clean.collectingAssets);
  }
  if (Array.isArray(clean.campaign_assets || clean.campaignAssets)) normalized.campaign_assets = normalizeCampaignAssets(clean.campaign_assets || clean.campaignAssets);
  if (clean.media_batch_summary || clean.mediaBatchSummary) normalized.media_batch_summary = clean.media_batch_summary || clean.mediaBatchSummary;
  if (clean.current_turn || clean.currentTurn) normalized.current_turn = clean.current_turn || clean.currentTurn;
  if (clean.active_turn || clean.activeTurn) normalized.active_turn = clean.active_turn || clean.activeTurn;
  if (Array.isArray(clean.content_calendar || clean.contentCalendar)) normalized.content_calendar = normalizeContentCalendar(clean.content_calendar || clean.contentCalendar);
  if (Array.isArray(clean.bulk_posts || clean.bulkPosts)) normalized.bulk_posts = normalizeBulkPosts(clean.bulk_posts || clean.bulkPosts);
  if (clean.campaign_summary || clean.campaignSummary) normalized.campaign_summary = String(clean.campaign_summary || clean.campaignSummary);
  if (clean.product) normalized.product = String(clean.product);
  if (clean.objective) normalized.objective = String(clean.objective);
  if (clean.current_asset_source || clean.currentAssetSource) normalized.current_asset_source = String(clean.current_asset_source || clean.currentAssetSource);
  if (Array.isArray(clean.platforms)) normalized.platforms = clean.platforms.map(String);
  if (clean.draft_status || clean.draftStatus) normalized.draft_status = String(clean.draft_status || clean.draftStatus);
  if (clean.approval_status || clean.approvalStatus) normalized.approval_status = String(clean.approval_status || clean.approvalStatus);
  if (clean.publish_status || clean.publishStatus) normalized.publish_status = String(clean.publish_status || clean.publishStatus);
  if (Object.prototype.hasOwnProperty.call(clean, "ready_to_publish") || Object.prototype.hasOwnProperty.call(clean, "readyToPublish")) {
    normalized.ready_to_publish = Boolean(clean.ready_to_publish || clean.readyToPublish);
  }

  return normalized;
}

function normalizeCampaignType(value) {
  const type = String(value || "").trim();

  return [
    "single_post",
    "weekly_content_plan",
    "monthly_content_plan",
    "bulk_from_assets"
  ].includes(type) ? type : "single_post";
}

function normalizeCampaignAssets(assets) {
  return (Array.isArray(assets) ? assets : []).map(function (asset, index) {
    return {
      asset_id: String(asset.asset_id || asset.assetId || "asset_" + (index + 1)),
      asset_index: Number(asset.asset_index || asset.assetIndex || index + 1),
      file_id: String(asset.file_id || asset.fileId || ""),
      url: String(asset.url || ""),
      media_type: String(asset.media_type || asset.mediaType || "IMAGE"),
      mime_type: String(asset.mime_type || asset.mimeType || ""),
      message_id: String(asset.message_id || asset.messageId || ""),
      caption: String(asset.caption || ""),
      turn_id: String(asset.turn_id || asset.turnId || ""),
      request_id: String(asset.request_id || asset.requestId || asset.turn_id || asset.turnId || ""),
      analysis: asset.analysis || null,
      analysis_error: String(asset.analysis_error || asset.analysisError || ""),
      received_at: String(asset.received_at || asset.receivedAt || new Date().toISOString()),
      status: String(asset.status || "received")
    };
  }).filter(function (asset) {
    return asset.file_id || asset.url;
  }).slice(-30);
}

function normalizeContentCalendar(items) {
  return (Array.isArray(items) ? items : []).map(function (item, index) {
    const postNumber = Number(item.post_number || item.postNumber || index + 1);

    return {
      post_id: String(item.post_id || item.postId || "post_" + postNumber),
      post_number: postNumber,
      content_type: String(item.content_type || item.contentType || "feed_post"),
      platform: normalizeSheetsPlatform(item.platform || item.platforms || "instagram,facebook"),
      topic: String(item.topic || ""),
      objective: String(item.objective || ""),
      content_pillar: String(item.content_pillar || item.contentPillar || ""),
      suggested_date: String(item.suggested_date || item.suggestedDate || ""),
      suggested_time: String(item.suggested_time || item.suggestedTime || ""),
      asset_id: String(item.asset_id || item.assetId || ""),
      needs_image_generation: Boolean(item.needs_image_generation || item.needsImageGeneration || false),
      status: String(item.status || "calendar_pending_approval"),
      approval_status: String(item.approval_status || item.approvalStatus || ""),
      publish_status: String(item.publish_status || item.publishStatus || "")
    };
  });
}

function normalizeBulkPosts(posts) {
  return (Array.isArray(posts) ? posts : []).map(function (post, index) {
    const postNumber = Number(post.post_number || post.postNumber || index + 1);

    return Object.assign({}, post, {
      post_id: String(post.post_id || post.postId || "post_" + postNumber),
      post_number: postNumber,
      status: String(post.status || "draft_pending_review"),
      approval_status: String(post.approval_status || post.approvalStatus || ""),
      publish_status: String(post.publish_status || post.publishStatus || "")
    });
  });
}

function addCampaignAsset(assets, asset) {
  const list = normalizeCampaignAssets(assets);
  const fileId = String(asset.file_id || asset.fileId || "");
  const url = String(asset.url || "");
  const existing = list.find(function (item) {
    return (fileId && item.file_id === fileId) || (url && item.url === url);
  });

  if (existing) {
    existing.url = existing.url || url;
    existing.status = existing.status || "received";
    existing.turn_id = existing.turn_id || String(asset.turn_id || asset.turnId || "");
    existing.request_id = existing.request_id || String(asset.request_id || asset.requestId || asset.turn_id || asset.turnId || "");
    existing.media_type = existing.media_type || String(asset.media_type || asset.mediaType || "IMAGE");
    existing.mime_type = existing.mime_type || String(asset.mime_type || asset.mimeType || "");
    return list;
  }

  list.push({
    asset_id: "asset_" + (list.length + 1),
    asset_index: list.length + 1,
    file_id: fileId,
    url: url,
    media_type: String(asset.media_type || asset.mediaType || "IMAGE"),
    mime_type: String(asset.mime_type || asset.mimeType || ""),
    message_id: String(asset.message_id || asset.messageId || ""),
    caption: String(asset.caption || ""),
    turn_id: String(asset.turn_id || asset.turnId || ""),
    request_id: String(asset.request_id || asset.requestId || asset.turn_id || asset.turnId || ""),
    analysis: asset.analysis || null,
    analysis_error: String(asset.analysis_error || asset.analysisError || ""),
    received_at: String(asset.received_at || new Date().toISOString()),
    status: String(asset.status || "received")
  });

  return list.slice(-30);
}

function shouldAskHowToUseCollectedAssets(data, messages) {
  const assets = data && data.campaignState && data.campaignState.campaign_assets || [];

  if (assets.length < 2) return false;
  if (data.campaignState.expected_next_target === "asset_usage_decision") return false;

  const onlyMedia = messages.length > 0 && messages.every(function (message) {
    return Boolean(message.fileId) && ["IMAGE", "VIDEO"].includes(message.type || "");
  });
  const hasClearInstruction = messages.some(function (message) {
    return hasClearBulkAssetInstruction(message.text || "");
  });

  return onlyMedia && !hasClearInstruction;
}

function shouldAskHowToUseImageOnlyTurn(userTurn, messages) {
  const turn = userTurn || {};

  if (Number(turn.image_count || 0) !== 1) return false;
  if (Number(turn.text_count || 0) > 0) return false;

  const cleanMessages = Array.isArray(messages) ? messages : [];
  if (!cleanMessages.length) return true;

  return cleanMessages.every(function (message) {
    return Boolean(message.fileId) && String(message.type || "").toUpperCase() === "IMAGE" && !String(message.text || "").trim();
  });
}

function hasClearBulkAssetInstruction(text) {
  const normalized = normalizeTextForIntent(text);

  return [
    "post",
    "posts",
    "publicacion",
    "publicaciones",
    "copy",
    "caption",
    "calendario",
    "planifica",
    "usa",
    "referencia",
    "diseno",
    "diseño"
  ].some(function (keyword) {
    return normalized.includes(keyword);
  });
}

function hasBulkCampaign(campaignState) {
  return Boolean(campaignState && (
    campaignState.campaign_type === "weekly_content_plan" ||
    campaignState.campaign_type === "monthly_content_plan" ||
    campaignState.campaign_type === "bulk_from_assets" ||
    (campaignState.content_calendar && campaignState.content_calendar.length) ||
    (campaignState.bulk_posts && campaignState.bulk_posts.length)
  ));
}

function resetCampaignState(data, reason) {
  const previous = data.campaignState || {};

  data.archivedCampaigns = Array.isArray(data.archivedCampaigns) ? data.archivedCampaigns.slice(-5) : [];

  if (previous.campaign_id && (previous.last_copy || previous.last_image_url || previous.campaign_summary || previous.active_topic)) {
    data.archivedCampaigns.push({
      campaign_id: previous.campaign_id,
      active_topic: previous.active_topic || "",
      campaign_summary: previous.campaign_summary || "",
      product: previous.product || "",
      objective: previous.objective || "",
      platforms: previous.platforms || [],
      closed_reason: reason || "",
      closed_at: new Date().toISOString()
    });
  }

  data.campaignState = createEmptyCampaignState(reason);

  console.log("CAMPAIGN_STATE_RESET:", JSON.stringify({
    reason: reason || "",
    newCampaignId: data.campaignState.campaign_id,
    archivedCount: data.archivedCampaigns.length
  }));

  return data;
}

function markDraftPendingReview(campaignState, reason) {
  const previousStatus = campaignState.draft_status || "";

  campaignState.draft_status = "draft_pending_review";
  campaignState.workflow_status = "waiting_user_review";
  campaignState.approval_status = "";
  campaignState.ready_to_publish = false;
  campaignState.draft_version = Number(campaignState.draft_version || 0) + 1;
  campaignState.updated_at = new Date().toISOString();

  console.log("DRAFT_STATUS_CHANGED:", JSON.stringify({
    from: previousStatus,
    to: campaignState.draft_status,
    reason: reason || "",
    campaignId: campaignState.campaign_id,
    draftVersion: campaignState.draft_version
  }));

  console.log("DRAFT_CREATED:", JSON.stringify({
    campaignId: campaignState.campaign_id,
    status: campaignState.draft_status,
    draftVersion: campaignState.draft_version
  }));
}

function markDraftChangesRequested(campaignState) {
  const previousStatus = campaignState.draft_status || "";

  campaignState.draft_status = "draft_changes_requested";
  campaignState.workflow_status = "changes_requested";
  campaignState.ready_to_publish = false;
  campaignState.updated_at = new Date().toISOString();

  console.log("DRAFT_STATUS_CHANGED:", JSON.stringify({
    from: previousStatus,
    to: campaignState.draft_status,
    campaignId: campaignState.campaign_id
  }));
}

function markDraftApproved(campaignState) {
  const previousStatus = campaignState.draft_status || "";

  campaignState.draft_status = "draft_approved";
  campaignState.workflow_status = "approved_waiting_publish_confirmation";
  campaignState.approval_status = "approved";
  campaignState.ready_to_publish = false;
  campaignState.updated_at = new Date().toISOString();

  console.log("DRAFT_STATUS_CHANGED:", JSON.stringify({
    from: previousStatus,
    to: campaignState.draft_status,
    campaignId: campaignState.campaign_id
  }));
}

function markDraftReadyToPublish(campaignState) {
  const previousStatus = campaignState.draft_status || "";

  campaignState.draft_status = "ready_to_publish";
  campaignState.workflow_status = "ready_to_publish";
  campaignState.approval_status = "approved";
  campaignState.publish_status = "ready";
  campaignState.ready_to_publish = true;
  campaignState.updated_at = new Date().toISOString();

  console.log("DRAFT_STATUS_CHANGED:", JSON.stringify({
    from: previousStatus,
    to: campaignState.draft_status,
    campaignId: campaignState.campaign_id
  }));
}

function createContentCalendarFromAction(campaignState, action, messages) {
  const state = normalizeCampaignState(campaignState);
  const requestedType = action.campaign_type && action.campaign_type !== "single_post"
    ? action.campaign_type
    : inferCampaignTypeFromText(consolidatedMessagesText(messages), state);
  const count = getRequestedPostCount(action, messages, requestedType, state);
  const assets = normalizeCampaignAssets(state.campaign_assets);
  const providedItems = normalizeContentCalendar(action.calendar_items || []);
  const startDate = nextDateString(1);
  const generatedItems = [];

  for (let index = 0; index < count; index += 1) {
    const provided = providedItems[index] || {};
    const asset = assets[index] || null;
    const postNumber = index + 1;

    generatedItems.push(Object.assign({
      post_id: state.campaign_id + "_post_" + postNumber,
      post_number: postNumber,
      content_type: "feed_post",
      platform: normalizeSheetsPlatform(action.platforms && action.platforms.length ? action.platforms : state.platforms.length ? state.platforms : ["instagram", "facebook"]),
      topic: provided.topic || state.active_topic || state.product || "Contenido de campaña",
      objective: provided.objective || state.objective || "generar interés y conversación",
      content_pillar: provided.content_pillar || provided.contentPillar || defaultContentPillar(postNumber),
      suggested_date: provided.suggested_date || provided.suggestedDate || addDaysString(startDate, index * (requestedType === "monthly_content_plan" ? 4 : 1)),
      suggested_time: provided.suggested_time || provided.suggestedTime || defaultSuggestedTime(postNumber),
      asset_id: provided.asset_id || provided.assetId || asset && asset.asset_id || "",
      needs_image_generation: Object.prototype.hasOwnProperty.call(provided, "needs_image_generation")
        ? Boolean(provided.needs_image_generation)
        : !asset,
      status: "calendar_pending_approval",
      approval_status: "",
      publish_status: ""
    }, provided));
  }

  state.campaign_type = requestedType;
  state.content_calendar = normalizeContentCalendar(generatedItems);
  state.bulk_posts = [];
  state.workflow_status = "calendar_pending_approval";
  state.expected_next_target = "calendar_approval";
  state.draft_status = "calendar_pending_approval";
  state.updated_at = new Date().toISOString();

  console.log("CONTENT_CALENDAR_CREATED:", JSON.stringify({
    campaignId: state.campaign_id,
    campaignType: state.campaign_type,
    postCount: state.content_calendar.length,
    assetCount: assets.length
  }));

  return state;
}

async function generateBulkPostsFromCalendar(env, campaignState, action, messages) {
  const state = normalizeCampaignState(campaignState);
  const calendar = normalizeContentCalendar(state.content_calendar);

  if (!calendar.length) {
    throw new Error("CONTENT_CALENDAR_EMPTY");
  }

  const selectedNumbers = normalizeSelectedPostNumbers(action.post_numbers, calendar);
  const existingPosts = normalizeBulkPosts(state.bulk_posts);
  const results = existingPosts.slice();

  for (const item of calendar) {
    if (!selectedNumbers.includes(item.post_number)) continue;

    const copy = await generateCopyWithOpenAI(env, {
      brief: [
        "Genera un post para calendario de contenido.",
        "Post número: " + item.post_number,
        "Tema: " + item.topic,
        "Objetivo: " + item.objective,
        "Pilar: " + item.content_pillar,
        "Plataforma: " + item.platform,
        "Si hay asset_id, asume que la imagen enviada acompaña el post.",
        "Devuelve copy listo para Instagram/Facebook con CTA y hashtags si aplica.",
        "",
        "Contexto del usuario:",
        consolidatedMessagesText(messages)
      ].join("\n"),
      platforms: String(item.platform || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean),
      messages: messages,
      conversationState: state,
      uploaded_image_analysis: state.uploaded_image_analysis || {},
      current_asset_source: item.asset_id ? "campaign_asset" : "",
      campaign_state: state
    });

    const post = {
      post_id: item.post_id,
      post_number: item.post_number,
      content_type: item.content_type,
      platform: item.platform,
      topic: item.topic,
      objective: item.objective,
      content_pillar: item.content_pillar,
      suggested_date: item.suggested_date,
      suggested_time: item.suggested_time,
      asset_id: item.asset_id,
      instagram_copy: copy,
      facebook_copy: "",
      cta: extractCTA(copy),
      hashtags: extractHashtags(copy),
      image_prompt: item.needs_image_generation ? buildBulkImagePrompt(item, state) : "",
      image_url: findAssetUrlById(state.campaign_assets, item.asset_id),
      status: "draft_pending_review",
      approval_status: "",
      publish_status: ""
    };

    const existingIndex = results.findIndex(function (candidate) {
      return candidate.post_id === post.post_id || candidate.post_number === post.post_number;
    });

    if (existingIndex >= 0) {
      results[existingIndex] = post;
    } else {
      results.push(post);
    }
  }

  state.bulk_posts = normalizeBulkPosts(results).sort(function (a, b) {
    return Number(a.post_number || 0) - Number(b.post_number || 0);
  });
  state.workflow_status = "bulk_posts_pending_approval";
  state.expected_next_target = "bulk_approval";
  state.draft_status = "draft_pending_review";
  state.updated_at = new Date().toISOString();

  console.log("BULK_POSTS_GENERATED:", JSON.stringify({
    campaignId: state.campaign_id,
    generatedCount: selectedNumbers.length,
    totalBulkPosts: state.bulk_posts.length
  }));

  return state;
}

function updateBulkPostStatuses(campaignState, postNumbers, patch) {
  const selectedNumbers = normalizeSelectedPostNumbers(postNumbers, campaignState.bulk_posts && campaignState.bulk_posts.length
    ? campaignState.bulk_posts
    : campaignState.content_calendar);
  const selectedLabels = [];

  campaignState.bulk_posts = normalizeBulkPosts(campaignState.bulk_posts).map(function (post) {
    if (!selectedNumbers.includes(Number(post.post_number))) return post;

    selectedLabels.push("#" + post.post_number);
    return Object.assign({}, post, patch, {
      updated_at: new Date().toISOString()
    });
  });

  campaignState.content_calendar = normalizeContentCalendar(campaignState.content_calendar).map(function (item) {
    if (!selectedNumbers.includes(Number(item.post_number))) return item;

    if (!selectedLabels.includes("#" + item.post_number)) selectedLabels.push("#" + item.post_number);
    return Object.assign({}, item, {
      status: patch.status || item.status,
      approval_status: patch.approval_status || item.approval_status,
      publish_status: patch.publish_status || item.publish_status
    });
  });

  campaignState.updated_at = new Date().toISOString();

  return selectedLabels;
}

function formatContentCalendarForWhatsApp(calendar) {
  return normalizeContentCalendar(calendar).map(function (item) {
    return [
      item.post_number + ". " + item.topic,
      "Pilar: " + item.content_pillar,
      "Objetivo: " + item.objective,
      "Fecha sugerida: " + item.suggested_date + " " + item.suggested_time,
      item.asset_id ? "Asset: " + item.asset_id : item.needs_image_generation ? "Imagen: requiere diseño" : ""
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatBulkPostsForWhatsApp(posts) {
  return normalizeBulkPosts(posts).map(function (post) {
    return [
      "*" + post.post_number + ". " + (post.topic || "Post") + "*",
      post.instagram_copy || "",
      post.image_prompt ? "\nImagen sugerida: " + post.image_prompt : ""
    ].filter(Boolean).join("\n");
  }).join("\n\n---\n\n");
}

function inferCampaignTypeFromText(text, state) {
  const normalized = normalizeTextForIntent(text);

  if ((state.campaign_assets || []).length > 1 || normalized.includes("imagenes") || normalized.includes("imágenes")) {
    return "bulk_from_assets";
  }

  if (normalized.includes("mes") || normalized.includes("mensual") || normalized.includes("monthly")) {
    return "monthly_content_plan";
  }

  if (normalized.includes("semana") || normalized.includes("weekly") || normalized.includes("5 posts") || normalized.includes("7 posts")) {
    return "weekly_content_plan";
  }

  return "weekly_content_plan";
}

function getRequestedPostCount(action, messages, campaignType, state) {
  if (Number(action.post_count || 0) > 0) {
    return Math.min(Number(action.post_count), 31);
  }

  const text = consolidatedMessagesText(messages);
  const match = text.match(/\b([1-9]|[12][0-9]|3[01])\b/);

  if (match) return Math.min(Number(match[1]), 31);
  if (campaignType === "monthly_content_plan") return 7;
  if (campaignType === "bulk_from_assets" && state.campaign_assets && state.campaign_assets.length) return Math.min(state.campaign_assets.length, 31);

  return 5;
}

function nextDateString(daysFromNow) {
  return addDaysString(new Date().toISOString().slice(0, 10), daysFromNow || 0);
}

function addDaysString(dateString, days) {
  const date = new Date(String(dateString || new Date().toISOString().slice(0, 10)) + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function defaultContentPillar(postNumber) {
  const pillars = ["educativo", "producto", "beneficio", "confianza", "promoción", "comunidad", "recordatorio"];
  return pillars[(Number(postNumber || 1) - 1) % pillars.length];
}

function defaultSuggestedTime(postNumber) {
  const times = ["09:00", "12:30", "18:00", "20:00"];
  return times[(Number(postNumber || 1) - 1) % times.length];
}

function normalizeSelectedPostNumbers(postNumbers, items) {
  const available = (Array.isArray(items) ? items : []).map(function (item, index) {
    return Number(item.post_number || item.postNumber || index + 1);
  }).filter(function (num) {
    return Number.isFinite(num) && num > 0;
  });

  const selected = Array.isArray(postNumbers)
    ? postNumbers.map(Number).filter(function (num) { return Number.isFinite(num) && num > 0; })
    : [];

  if (!selected.length) return available;

  return selected.filter(function (num) {
    return available.includes(num);
  });
}

function extractCTA(text) {
  const value = String(text || "");
  const match = value.match(/CTA:\s*([\s\S]*?)(?:\n\n|Hashtags:|#|$)/i);
  return match ? match[1].trim() : "";
}

function buildBulkImagePrompt(item, state) {
  return [
    "Diseño profesional para post de redes sociales.",
    "Tema: " + (item.topic || ""),
    "Objetivo: " + (item.objective || ""),
    "Pilar: " + (item.content_pillar || ""),
    "Producto/contexto: " + (state.product || state.campaign_summary || ""),
    "Evita texto pequeño ilegible."
  ].join("\n");
}

function findAssetUrlById(assets, assetId) {
  const match = normalizeCampaignAssets(assets).find(function (asset) {
    return asset.asset_id === assetId;
  });

  return match ? match.url : "";
}

async function saveContentCalendarToSheets(env, data, messages) {
  for (const item of normalizeContentCalendar(data.campaignState.content_calendar)) {
    await saveDraftToGoogleSheets(env, buildCalendarSheetsPayload(data, messages, item));
  }
}

async function saveBulkPostsToSheets(env, data, messages) {
  const posts = data.campaignState.bulk_posts && data.campaignState.bulk_posts.length
    ? normalizeBulkPosts(data.campaignState.bulk_posts)
    : normalizeContentCalendar(data.campaignState.content_calendar);

  for (const post of posts) {
    await saveDraftToGoogleSheets(env, buildBulkPostSheetsPayload(data, messages, post));
  }
}

function buildCalendarSheetsPayload(data, messages, item) {
  return {
    action: "save_or_update_draft",
    status: item.status || "calendar_pending_approval",
    campaign_id: data.campaignState.campaign_id || "",
    channel_id: data.channel || "",
    phone: data.phone || "",
    platforms: String(item.platform || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean),
    copy: "",
    image_url: findAssetUrlById(data.campaignState.campaign_assets, item.asset_id),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_type: "CONTENT_CALENDAR",
    platform: item.platform || "",
    original_caption: consolidatedMessagesText(messages),
    instagram_copy: "Calendario: " + item.topic,
    facebook_copy: "",
    cta: "",
    hashtags: "",
    session_id: data.doName || "",
    message_id: (messages.map(function (msg) { return msg.messageId; }).join(",") || "") + ":" + item.post_id,
    file_id: item.asset_id || "",
    Campaign_ID: data.campaignState.campaign_id || "",
    Post_ID: item.post_id || "",
    Post_Number: item.post_number || "",
    Content_Type: item.content_type || "feed_post",
    Scheduled_Date: item.suggested_date || "",
    Scheduled_Time: item.suggested_time || "",
    Content_Pillar: item.content_pillar || "",
    Asset_ID: item.asset_id || "",
    Image_URL: findAssetUrlById(data.campaignState.campaign_assets, item.asset_id),
    Approval_Status: item.approval_status || "",
    Publish_Status: item.publish_status || ""
  };
}

function buildBulkPostSheetsPayload(data, messages, post) {
  return {
    action: "save_or_update_draft",
    status: post.status || "draft_pending_review",
    campaign_id: data.campaignState.campaign_id || "",
    channel_id: data.channel || "",
    phone: data.phone || "",
    platforms: String(post.platform || "").split(",").map(function (part) { return part.trim(); }).filter(Boolean),
    copy: post.instagram_copy || "",
    image_url: post.image_url || "",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    message_type: "BULK_POST",
    platform: post.platform || "",
    original_caption: consolidatedMessagesText(messages),
    instagram_copy: post.instagram_copy || "",
    facebook_copy: post.facebook_copy || "",
    cta: post.cta || "",
    hashtags: post.hashtags || "",
    session_id: data.doName || "",
    message_id: (messages.map(function (msg) { return msg.messageId; }).join(",") || "") + ":" + post.post_id,
    file_id: post.image_url || post.asset_id || "",
    Campaign_ID: data.campaignState.campaign_id || "",
    Post_ID: post.post_id || "",
    Post_Number: post.post_number || "",
    Content_Type: post.content_type || "feed_post",
    Scheduled_Date: post.suggested_date || "",
    Scheduled_Time: post.suggested_time || "",
    Content_Pillar: post.content_pillar || "",
    Asset_ID: post.asset_id || "",
    Image_URL: post.image_url || "",
    Approval_Status: post.approval_status || "",
    Publish_Status: post.publish_status || ""
  };
}

function buildSheetsDraftPayload(data, messages, actions, copyText) {
  const payload = {
    action: "save_or_update_draft",
    status: data.campaignState.draft_status || "draft_pending_review",
    campaign_id: data.campaignState.campaign_id || "",
    channel_id: data.channel || "",
    phone: data.phone || "",
    platforms: guessPlatformsFromActions(actions),
    copy: copyText || data.campaignState.last_copy || "",
    image_url: data.campaignState.last_image_url || "",
    uploaded_image_url: getLastUploadedImage(data.campaignState).url || "",
    uploaded_image_analysis: data.campaignState.uploaded_image_analysis || {},
    draft_version: Number(data.campaignState.draft_version || 1),
    approval_status: data.campaignState.approval_status || "",
    publish_status: data.campaignState.publish_status || "",
    ready_to_publish: Boolean(data.campaignState.ready_to_publish),
    created_at: data.campaignState.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),

    message_type: "DRAFT",
    platform: guessPlatformsFromActions(actions).join(","),
    original_caption: consolidatedMessagesText(messages),
    instagram_copy: copyText || data.campaignState.last_copy || "",
    facebook_copy: "",
    cta: "",
    hashtags: extractHashtags(copyText || data.campaignState.last_copy || ""),
    session_id: data.doName || "",
    message_id: messages.map(function (msg) { return msg.messageId; }).join(","),
    file_id: data.campaignState.last_image_url || ""
  };

  console.log("SHEETS_DRAFT_PAYLOAD:", JSON.stringify(payload));

  return payload;
}

function buildSheetsStatusPayload(data, messages, patch) {
  const payload = Object.assign({
    campaign_id: data.campaignState.campaign_id || "",
    channel_id: data.channel || "",
    phone: data.phone || "",
    session_id: data.doName || "",
    message_id: messages.map(function (msg) { return msg.messageId; }).join(","),
    updated_at: new Date().toISOString()
  }, patch || {});

  console.log("SHEETS_DRAFT_PAYLOAD:", JSON.stringify(payload));

  return payload;
}

function appendHistory(history, item) {
  const list = Array.isArray(history) ? history.slice() : [];

  list.push({
    role: String(item.role || "user"),
    type: String(item.type || "TEXT"),
    text: String(item.text || "").slice(0, 1800),
    fileId: String(item.fileId || ""),
    at: String(item.at || new Date().toISOString())
  });

  return list.slice(-20);
}

function isNewCampaignRequest(text) {
  const normalized = normalizeTextForIntent(text);

  if (!normalized) return false;

  return [
    "ahora necesito otro post",
    "necesito otro post",
    "nuevo post",
    "otra campana",
    "otra campaña",
    "nuevo producto",
    "otro producto",
    "hazme uno nuevo",
    "hagamos uno nuevo",
    "quiero otro post",
    "es para otra publicacion",
    "es para otra publicación"
  ].some(function (pattern) {
    return normalized.includes(normalizeTextForIntent(pattern));
  });
}

function normalizeTextForIntent(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPlainTurnText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const clean = [];

  for (const line of lines) {
    let value = String(line || "").trim();
    value = value.replace(/^\[\d+\]\s+\w+:\s*/i, "");
    value = value.replace(/^fileId=[^:]+:\s*/i, "");
    value = value.replace(/^\[Audio transcrito\]:\s*/i, "");
    value = value.replace(/^\[Texto adicional\]:\s*/i, "");
    if (!value || /\[IMAGE uploaded/i.test(value)) continue;
    clean.push(value);
  }

  return clean.join("\n").trim();
}

function getLastCopyFromState(state) {
  return String(state && (state.last_copy || state.lastCopy) || "");
}

function getLastImageUrlFromState(state) {
  return String(state && (state.last_image_url || state.lastImageUrl) || "");
}

function getLastUploadedImage(state) {
  return state && (state.last_uploaded_image || state.lastUploadedImage) || {};
}

function extractQuotedMessageReference(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const directRefs = [{
    quotedMessageId: parsed.quotedMessageId || payload.quotedMessageId || data.quotedMessageId,
    replyToMessageId: parsed.replyToMessageId || payload.replyToMessageId || data.replyToMessageId,
    fileId: parsed.quotedFileId || payload.quotedFileId || data.quotedFileId,
    type: parsed.quotedType || payload.quotedType || data.quotedType
  }];
  const containers = directRefs.concat([
    parsed.context,
    payload.context,
    data.context,
    parsed.quotedMessage,
    payload.quotedMessage,
    data.quotedMessage,
    parsed.quoted,
    payload.quoted,
    data.quoted,
    parsed.replyTo,
    payload.replyTo,
    data.replyTo,
    parsed.reply_to,
    payload.reply_to,
    data.reply_to
  ]).filter(function (item) {
    return item && typeof item === "object";
  });

  for (const item of containers) {
    const messageId = String(
      item.quotedMessageId ||
      item.replyToMessageId ||
      item.messageId ||
      item.message_id ||
      item.id ||
      item.mid ||
      item.stanzaId ||
      item.stanza_id ||
      ""
    ).trim();
    const fileId = String(
      item.fileId ||
      item.file_id ||
      item.mediaId ||
      item.media_id ||
      item.attachment && (item.attachment.fileId || item.attachment.file_id) ||
      item.file && (item.file.fileId || item.file.file_id) ||
      ""
    ).trim();
    const type = String(item.type || item.messageType || item.message_type || "").toUpperCase();
    if (messageId || fileId) {
      return { messageId: messageId, fileId: fileId, type: type };
    }
  }

  return { messageId: "", fileId: "", type: "" };
}

function normalizeIncomingMessage(parsedMessage, woztellPayload, options) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const type = String(parsed.type || normalizeEventType(payload.type || payload.data && payload.data.type || "", payload) || "UNSUPPORTED").toUpperCase();
  const fileId = String(parsed.fileId || "");
  const quoted = extractQuotedMessageReference(parsed, payload);
  const media = extractMediaFromPayload(parsed, payload);
  const audio = isAudioMessage(parsed) && fileId ? [{
    type: type,
    fileId: fileId,
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    status: parsed.audioStatus || "pending_transcription"
  }] : [];
  const video = buildVideoMetadata(parsed, payload);
  const files = buildFileMetadata(parsed, payload);

  const fallbackText = type === "UNSUPPORTED" ? ""
    : fileId && !isAudioMessage(parsed)
    ? "[" + type + " uploaded without caption]"
    : isAudioMessage(parsed) ? "[AUDIO pending transcription]" : "";

  return {
    messageId: String(options && options.messageId || parsed.messageId || payload.messageId || randomId(12)),
    traceId: String(options && options.traceId || parsed.traceId || payload.traceId || ""),
    type: type,
    text: String(parsed.text || fallbackText).trim(),
    fileId: fileId,
    media: media,
    audio: audio,
    video: video,
    files: files,
    location: buildLocationMetadata(parsed, payload),
    captions: collectCaptions(parsed, payload),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    originalType: parsed.originalType || (type === "AUDIO" ? "AUDIO" : ""),
    originalFileId: parsed.originalFileId || "",
    quotedMessageId: quoted.messageId,
    replyToMessageId: quoted.messageId,
    quotedFileId: quoted.fileId,
    quotedType: quoted.type,
    audioStatus: parsed.audioStatus || (audio.length ? "pending" : ""),
    audioTranscript: parsed.audioTranscript || "",
    awaitingTranscription: Boolean(audio.length && !parsed.audioTranscript && parsed.audioStatus !== "failed"),
    app: String(payload.app || ""),
    member: String(payload.member || ""),
    channel: String(payload.channel || ""),
    from: String(payload.from || ""),
    to: String(payload.to || ""),
    receivedAt: String(options && options.receivedAt || new Date().toISOString())
  };
}

function extractMediaFromPayload(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const type = String(parsed.type || payload.type || data.type || "TEXT").toUpperCase();
  const candidates = [];
  const rawMedia = []
    .concat(Array.isArray(parsed.media) ? parsed.media : [])
    .concat(Array.isArray(data.media) ? data.media : [])
    .concat(Array.isArray(payload.media) ? payload.media : [])
    .concat(Array.isArray(data.attachments) ? data.attachments : [])
    .concat(Array.isArray(payload.attachments) ? payload.attachments : []);

  if (parsed.fileId) {
    rawMedia.unshift({
      type: type,
      fileId: parsed.fileId,
      mimeType: parsed.mimeType || "",
      fileName: parsed.fileName || "",
      caption: parsed.caption || parsed.text || ""
    });
  }

  for (const item of rawMedia) {
    const fileId = String(item.fileId || item.file_id || item.mediaId || item.id || "");
    if (!fileId) continue;

    const itemType = String(item.type || type || "FILE").toUpperCase();
    const mimeType = String(item.mimeType || item.mime_type || item.contentType || "");
    const normalizedType = mimeType.startsWith("image/") ? "IMAGE"
      : mimeType.startsWith("video/") ? "VIDEO"
      : mimeType.startsWith("audio/") ? "AUDIO"
      : itemType;

    if (["AUDIO", "VOICE", "PTT"].includes(normalizedType)) continue;

    candidates.push({
      type: ["IMAGE", "VIDEO", "FILE"].includes(normalizedType) ? normalizedType : "FILE",
      fileId: fileId,
      mimeType: mimeType,
      fileName: String(item.fileName || item.file_name || item.name || ""),
      caption: String(item.caption || item.text || "")
    });
  }

  const seen = new Set();
  return candidates.filter(function (item) {
    if (seen.has(item.fileId)) return false;
    seen.add(item.fileId);
    return true;
  });
}

function collectCaptions(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const captions = []
    .concat(parsed.caption || [])
    .concat(payload.caption || [])
    .concat(data.caption || [])
    .concat((Array.isArray(parsed.media) ? parsed.media : []).map(function (item) { return item.caption || item.text || ""; }))
    .concat((Array.isArray(data.media) ? data.media : []).map(function (item) { return item.caption || item.text || ""; }))
    .map(function (value) { return String(value || "").trim(); })
    .filter(Boolean);

  if (parsed.text && captions.indexOf(String(parsed.text).trim()) === -1 && parsed.fileId) {
    captions.unshift(String(parsed.text).trim());
  }

  return Array.from(new Set(captions));
}

function buildAudioBatch(messages) {
  const audioItems = [];

  for (const message of messages || []) {
    for (const audio of message.audio || []) {
      audioItems.push(Object.assign({}, audio, {
        messageId: message.messageId,
        transcript: message.audioTranscript || audio.transcript || "",
        status: message.audioStatus || audio.status || "pending"
      }));
    }

    if (!(message.audio || []).length && ((message.originalType || "").toUpperCase() === "AUDIO" || message.audioTranscript)) {
      audioItems.push({
        messageId: message.messageId,
        fileId: message.originalFileId || message.fileId || "",
        transcript: message.audioTranscript || String(message.text || "").replace(/^\[Audio transcrito\]:\s*/i, ""),
        status: message.audioStatus || "transcribed"
      });
    }
  }

  return {
    items: audioItems,
    count: audioItems.length,
    transcribedCount: audioItems.filter(function (item) { return item.status === "transcribed" && item.transcript; }).length,
    failedCount: audioItems.filter(function (item) { return item.status === "failed"; }).length,
    pendingCount: audioItems.filter(function (item) { return item.status === "pending" || item.status === "pending_transcription"; }).length,
    transcripts: audioItems.map(function (item) { return item.transcript || ""; }).filter(Boolean)
  };
}

function buildVideoMetadata(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const type = String(parsed.type || "").toUpperCase();

  if (type !== "VIDEO") return [];

  return [{
    fileId: String(parsed.fileId || ""),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    url: String(parsed.url || ""),
    duration: parsed.duration || woztellPayload && woztellPayload.duration || "",
    receivedAt: new Date().toISOString()
  }].filter(function (item) {
    return item.fileId || item.url;
  });
}

function buildFileMetadata(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const type = String(parsed.type || "").toUpperCase();

  if (type !== "FILE") return [];

  return [{
    fileId: String(parsed.fileId || ""),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    url: String(parsed.url || ""),
    receivedAt: new Date().toISOString()
  }].filter(function (item) {
    return item.fileId || item.url;
  });
}

function buildLocationMetadata(parsedMessage, woztellPayload) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const data = payload.data || {};
  const type = String(parsed.type || payload.type || data.type || "").toUpperCase();

  if (type !== "LOCATION") return null;

  const location = data.location || payload.location || parsed.location || data;
  return {
    latitude: Number(location.latitude || location.lat || 0) || null,
    longitude: Number(location.longitude || location.lng || location.lon || 0) || null,
    name: String(location.name || ""),
    address: String(location.address || "")
  };
}

function shouldStartNewTurn(messages, previousState) {
  const text = normalizeTextForIntent(consolidatedMessagesText(messages || []));

  const hasNewMedia = (messages || []).some(function (message) {
    return (message.media && message.media.length) || (message.video && message.video.length) || (message.files && message.files.length);
  });

  if (hasNewMedia && previousState && previousState.workflow_status && !shouldUsePreviousContext(messages)) return true;
  if (!text) return false;
  if (text === "/reset") return true;
  if (isNewCampaignRequest(text)) return true;

  return Boolean(hasNewMedia && previousState && previousState.workflow_status && !shouldUsePreviousContext(messages));
}

function shouldUsePreviousContext(messages) {
  const text = normalizeTextForIntent(consolidatedMessagesText(messages || []));

  return [
    "anterior",
    "la anterior",
    "el anterior",
    "cambia el anterior",
    "usa la imagen anterior",
    "haz otra version",
    "haz otra versión",
    "segunda imagen",
    "primera imagen",
    "tercera imagen",
    "los precios",
    "te mande 2 imagenes",
    "te envie 2 imagenes",
    "te pase 2 imagenes",
    "mande 2 imagenes",
    "cual conviene",
    "cuál conviene",
    "lo de antes",
    "y este otro",
    "y esta otra"
  ].some(function (pattern) {
    return text.includes(normalizeTextForIntent(pattern));
  }) || isUserClaimingMoreImages(text);
}

function buildUserTurn(messages, campaignState, options) {
  const state = normalizeCampaignState(campaignState || {});
  const turnId = options && options.turnId || "turn_" + Date.now() + "_" + randomId(6);
  const traceId = options && options.traceId || "";
  const wantsPreviousContext = shouldUsePreviousContext(messages);
  const currentTurnBatch = buildMediaBatch(state, messages || [], { turnId: turnId, traceId: traceId, mode: "current_turn" });
  const activeTask = normalizeActiveTask(state.active_task);
  const taskMediaAssets = activeTask && activeTask.taskMediaFileIds.length
    ? normalizeCampaignAssets(state.campaign_assets).filter(function (asset) {
      return activeTask.taskMediaFileIds.includes(asset.file_id);
    })
    : normalizeCampaignAssets(state.task_media_assets || []);
  const previousMediaBatch = wantsPreviousContext
    ? buildMediaBatch(state, messages || [], { turnId: turnId, traceId: traceId, mode: "previous_relevant" })
    : { assets: [], fileIds: [], assetCount: 0, analyzedAssetCount: 0, failedAssetCount: 0 };
  const mediaBatch = currentTurnBatch.assets.length ? currentTurnBatch : previousMediaBatch;
  const audioBatch = buildAudioBatch(messages || []);
  const captions = (messages || []).flatMap(function (message) {
    return message.captions || [];
  }).filter(Boolean);
  const videos = (messages || []).flatMap(function (message) { return message.video || []; });
  const files = (messages || []).flatMap(function (message) { return message.files || []; });
  const textMessages = (messages || []).filter(function (message) {
    return String(message.text || "").trim() && !String(message.text || "").startsWith("[IMAGE uploaded");
  });
  const contextPolicy = wantsPreviousContext
    ? "use_previous_context"
    : shouldStartNewTurn(messages, state) ? "new_request_from_current_turn" : "current_turn_only";
  const staleAssets = normalizeCampaignAssets(state.campaign_assets).filter(function (asset) {
    const selected = new Set([].concat(currentTurnBatch.fileIds || []).concat(previousMediaBatch.fileIds || []));
    return !selected.has(asset.file_id);
  });

  const turn = {
    turn_id: turnId,
    trace_id: traceId,
    request_id: turnId,
    message_ids: (messages || []).map(function (message) { return message.messageId; }),
    input_types: Array.from(new Set((messages || []).map(function (message) { return message.type || "TEXT"; }))),
    messages: messages || [],
    text_count: textMessages.length,
    audio_count: audioBatch.count,
    image_count: mediaBatch.assets.filter(function (asset) { return asset.media_type === "IMAGE"; }).length,
    video_count: videos.length,
    file_count: files.length,
    captions: captions,
    current_turn_text: consolidatedMessagesText(messages || []),
    audio_transcripts: audioBatch.transcripts,
    audio_batch: audioBatch,
    media_batch: mediaBatch,
    media_batch_summary: buildMediaBatchSummary(mediaBatch),
    active_task: activeTask,
    activeTask: activeTask,
    task_media_assets: taskMediaAssets,
    taskMediaAssets: taskMediaAssets,
    expected_media_count: activeTask && activeTask.expectedInputs === "images" ? "unknown" : 0,
    received_media_count: activeTask ? activeTask.receivedMediaCount : mediaBatch.assets.length,
    current_turn_media: summarizeAssetsForContext(currentTurnBatch.assets),
    previous_relevant_media: summarizeAssetsForContext(previousMediaBatch.assets),
    stale_media: summarizeAssetsForContext(staleAssets),
    currentTurnMedia: summarizeAssetsForContext(currentTurnBatch.assets),
    previousRelevantMedia: summarizeAssetsForContext(previousMediaBatch.assets),
    staleMedia: summarizeAssetsForContext(staleAssets),
    video_metadata: videos,
    file_metadata: files,
    context_policy: contextPolicy,
    created_at: new Date().toISOString()
  };
  attachUserTurnContract(turn, messages || [], mediaBatch);
  const userTurnMediaBatch = buildMediaBatchFromUserTurn({
    userTurn: turn,
    activeTaskAssets: taskMediaAssets
  });
  if (userTurnMediaBatch.assets.length) {
    turn.media_batch = userTurnMediaBatch;
    turn.media_batch_summary = buildMediaBatchSummary(userTurnMediaBatch);
    turn.image_count = userTurnMediaBatch.assets.filter(function (asset) { return asset.media_type === "IMAGE"; }).length;
    turn.video_count = Math.max(turn.video_count, userTurnMediaBatch.assets.filter(function (asset) { return asset.media_type === "VIDEO"; }).length);
    turn.file_count = Math.max(turn.file_count, userTurnMediaBatch.assets.filter(function (asset) { return asset.media_type === "FILE"; }).length);
    turn.counts.image = turn.image_count;
    turn.counts.video = turn.video_count;
    turn.counts.file = turn.file_count;
  }
  return turn;
}

function buildTurnSummary(userTurn) {
  const turn = userTurn || {};

  return {
    turn_id: turn.turn_id || "",
    trace_id: turn.trace_id || "",
    input_types: turn.input_types || [],
    text_count: turn.text_count || 0,
    audio_count: turn.audio_count || 0,
    image_count: turn.image_count || 0,
    video_count: turn.video_count || 0,
    file_count: turn.file_count || 0,
    captions: turn.captions || [],
    context_policy: turn.context_policy || "current_turn_only",
    current_turn_media: turn.current_turn_media || turn.currentTurnMedia || emptyMediaContext(),
    previous_relevant_media: turn.previous_relevant_media || turn.previousRelevantMedia || emptyMediaContext(),
    stale_media: turn.stale_media || turn.staleMedia || emptyMediaContext(),
    text_preview: String(turn.current_turn_text || "").slice(0, 1200)
  };
}

function shouldSendAudioOnlyFallback(userTurn) {
  const turn = userTurn || {};
  const audio = turn.audio_batch || {};
  const hasUsefulText = String(turn.current_turn_text || "")
    .split("\n")
    .some(function (line) {
      const clean = line.trim();
      return clean &&
        !clean.includes("[AUDIO pending transcription]") &&
        !clean.includes("[AUDIO no transcrito]") &&
        !clean.includes("[IMAGE uploaded without caption]");
    });

  return Boolean(
    audio.count > 0 &&
    audio.transcribedCount === 0 &&
    audio.pendingCount === 0 &&
    turn.image_count === 0 &&
    turn.video_count === 0 &&
    turn.file_count === 0 &&
    !hasUsefulText
  );
}

function shouldUseLocalGeneralAnswer(text) {
  const clean = normalizeTextForIntent(text);
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ola)$/.test(clean)) return false;
  return Boolean(composeGeneralTextAnswer(text));
}

function compactConversationHistory(history) {
  return (Array.isArray(history) ? history : []).slice(-6).map(function (item) {
    return {
      role: item.role || "",
      type: item.type || "",
      text: String(item.text || "").slice(0, 500),
      at: item.at || ""
    };
  });
}

function buildRelevantPreviousState(campaignState, userTurn) {
  const state = normalizeCampaignState(campaignState || {});
  const useCampaignState = isExplicitMarketingRequest(extractPlainTurnText(userTurn && userTurn.current_turn_text || ""));

  if (!useCampaignState || userTurn && userTurn.context_policy !== "use_previous_context") {
    return {
      workflow_status: useCampaignState ? state.workflow_status : "ignored",
      expected_next_target: useCampaignState ? state.expected_next_target : "ignored",
      note: "Previous campaign content intentionally omitted for current turn."
    };
  }

  return {
    campaign_id: state.campaign_id,
    workflow_status: state.workflow_status,
    expected_next_target: state.expected_next_target,
    last_copy: state.last_copy ? state.last_copy.slice(0, 1200) : "",
    last_image_url: state.last_image_url || "",
    content_calendar_count: state.content_calendar.length,
    bulk_posts_count: state.bulk_posts.length,
    history: compactConversationHistory(state.history)
  };
}

function buildOrchestratorInput(params) {
  const userTurn = params.userTurn || buildUserTurn(params.messages || [], params.campaignState || {});
  const state = normalizeCampaignState(params.campaignState || {});
  const plainText = extractPlainTurnText(userTurn.current_turn_text || "");
  const allowPreviousContext = userTurn.context_policy === "use_previous_context";
  const useCampaignState = isExplicitMarketingRequest(plainText);
  const requestContext = params.requestContext || buildRequestContext({
    userTurn: userTurn,
    recentConversationWindow: params.recentConversationWindow || [],
    activeContext: params.activeContext || params.active_context || {},
    conversationSummary: params.conversationSummary || null,
    customerMemory: params.customerMemory || null,
    utilityMemory: params.utilityMemory || null,
    mediaMemorySummary: state.media_batch_summary || null
  });

  return {
    request_context: requestContext,
    current_turn_summary: buildTurnSummary(userTurn),
    current_turn_text: userTurn.current_turn_text || "",
    media_batch_summary: userTurn.media_batch_summary || null,
    current_turn_media: userTurn.current_turn_media || userTurn.currentTurnMedia || emptyMediaContext(),
    previous_relevant_media: allowPreviousContext ? userTurn.previous_relevant_media || userTurn.previousRelevantMedia || emptyMediaContext() : emptyMediaContext(),
    stale_media: allowPreviousContext ? userTurn.stale_media || userTurn.staleMedia || emptyMediaContext() : emptyMediaContext(),
    audio_transcripts: userTurn.audio_transcripts || [],
    video_metadata: userTurn.video_metadata || [],
    file_metadata: userTurn.file_metadata || [],
    conversation_summary: params.conversationSummary || null,
    user_style_profile: params.userStyleProfile || null,
    customer_memory: params.customerMemory || null,
    utility_memory: params.utilityMemory || null,
    relevant_previous_state: buildRelevantPreviousState(state, userTurn),
    allowed_actions: getAllowedOrchestratorActions(),
    active_context: normalizeConversationContext(params.activeContext || params.active_context || {}),
    campaign_state_brief: useCampaignState ? {
      campaign_id: state.campaign_id,
      campaign_type: state.campaign_type,
      workflow_status: state.workflow_status,
      expected_next_target: state.expected_next_target,
      current_asset_source: state.current_asset_source || ""
    } : {
      ignored: true,
      reason: "non_marketing_current_turn"
    }
  };
}

function getAllowedOrchestratorActions() {
  return [
    "generate_copy",
    "generate_image",
    "edit_image",
    "analyze_uploaded_image",
    "save_draft_to_sheets",
    "create_content_calendar",
    "generate_bulk_posts",
    "approve_draft",
    "mark_ready_to_publish",
    "request_changes",
    "ask_clarification"
  ];
}

function mapOrchestratorActions(plan) {
  const allowed = new Set(getAllowedOrchestratorActions());
  const actions = Array.isArray(plan && plan.actions) ? plan.actions : [];
  return actions.filter(function (action) {
    return allowed.has(action && action.type);
  });
}

function buildMediaBatch(campaignState, messages, options) {
  if (options && options.userTurn) {
    return buildMediaBatchFromUserTurn({
      userTurn: options.userTurn,
      activeTaskAssets: options.activeTaskAssets || []
    });
  }
  const state = normalizeCampaignState(campaignState || {});
  const turnId = options && options.turnId || "";
  const traceId = options && options.traceId || "";
  const mode = options && options.mode || (options && options.allowPreviousMedia ? "previous_relevant" : "current_turn");
  const messageFileIds = new Set((messages || []).flatMap(function (message) {
    const ids = [];
    if (message.fileId) ids.push(String(message.fileId));
    for (const item of message.media || []) {
      if (item.fileId) ids.push(String(item.fileId));
    }
    return ids;
  }));
  const allAssets = normalizeCampaignAssets(state.campaign_assets);
  let assets = [];

  if (messageFileIds.size) {
    assets = allAssets.filter(function (asset) {
      return messageFileIds.has(asset.file_id) ||
        mode === "current_turn" && turnId && (asset.turn_id === turnId || asset.request_id === turnId);
    });
  } else if (mode === "current_turn" && turnId) {
    assets = allAssets.filter(function (asset) {
      return asset.turn_id === turnId || asset.request_id === turnId;
    });
  } else if (mode === "previous_relevant") {
    assets = selectReferencedPreviousMediaAssets(allAssets, messages || []);
  }

  if (mode === "current_turn" && turnId && messageFileIds.size && assets.length > messageFileIds.size) {
    logEvent("LEGACY_IMAGE_SINGLE_ASSET_PATH_BLOCKED", {
      traceId: traceId,
      turnId: turnId,
      messageFileIds: Array.from(messageFileIds),
      selectedFileIds: assets.map(function (asset) { return asset.file_id; }).filter(Boolean),
      reason: "same_turn_assets_preserved"
    });
  }

  if (!assets.length && mode === "previous_relevant" && state.last_uploaded_image) {
    const last = getLastUploadedImage(state);
    assets = normalizeCampaignAssets([{
      asset_id: "asset_1",
      file_id: last.fileId || "",
      url: last.url || "",
      media_type: last.type || "IMAGE",
      mime_type: last.mimeType || "",
      analysis: state.uploaded_image_analysis || null,
      received_at: last.receivedAt || new Date().toISOString(),
      status: state.uploaded_image_analysis ? "analyzed" : "received"
    }]);
  }

  const beforeDedupe = assets.length;
  assets = normalizeCampaignAssets(assets).filter(function (asset, index, list) {
    const id = asset.file_id || asset.message_id || "";
    return id && list.findIndex(function (candidate) {
      return (candidate.file_id || candidate.message_id || "") === id;
    }) === index;
  });
  if (beforeDedupe !== assets.length) {
    logEvent("MEDIA_BATCH_DEDUPED", {
      traceId: traceId,
      turnId: turnId,
      before: beforeDedupe,
      after: assets.length
    });
  }

  const fileIds = assets.map(function (asset) { return asset.file_id; }).filter(Boolean);
  const analyzedAssetCount = assets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; }).length;
  const failedAssetCount = assets.filter(function (asset) { return asset.status === "analysis_failed"; }).length;

  const result = {
    assets: assets,
    fileIds: fileIds,
    assetCount: assets.length,
    analyzedAssetCount: analyzedAssetCount,
    failedAssetCount: failedAssetCount
  };
  logEvent("MEDIA_BATCH_FILE_IDS_FINAL", {
    traceId: traceId,
    turnId: turnId,
    fileIds: fileIds
  });
  logEvent("MEDIA_BATCH_COUNTS_FINAL", {
    traceId: traceId,
    turnId: turnId,
    assetCount: assets.length,
    imageCount: assets.filter(function (asset) { return asset.media_type === "IMAGE"; }).length,
    videoCount: assets.filter(function (asset) { return asset.media_type === "VIDEO"; }).length,
    fileCount: assets.filter(function (asset) { return asset.media_type === "FILE"; }).length
  });
  return result;
}

function selectReferencedPreviousMediaAssets(assets, messages) {
  const list = normalizeCampaignAssets(assets || []);
  const text = normalizeTextForIntent(consolidatedMessagesText(messages || []));

  if (!list.length) return [];

  const index = getReferencedMediaIndex(text);
  if (index !== null) {
    const selected = list.find(function (asset) {
      return Number(asset.asset_index || 0) === index;
    }) || list[index - 1];
    return selected ? [selected] : [];
  }

  if (shouldUsePreviousContext(messages)) {
    return list.slice(-5);
  }

  return [];
}

function getReferencedMediaIndex(text) {
  if (text.includes("primera imagen") || text.includes("primer imagen") || text.includes("imagen 1")) return 1;
  if (text.includes("segunda imagen") || text.includes("imagen 2")) return 2;
  if (text.includes("tercera imagen") || text.includes("imagen 3")) return 3;
  if (text.includes("cuarta imagen") || text.includes("imagen 4")) return 4;
  return null;
}

function getUploadedMediaBatch(campaignState, messages, options) {
  return buildMediaBatch(campaignState, messages, options);
}

async function analyzeMediaBatch(env, params) {
  const mediaBatch = params.mediaBatch || { assets: [] };
  const analyzedAssets = [];

  for (const asset of mediaBatch.assets) {
    const assetForAnalysis = Object.assign({}, asset);

    console.log("MEDIA_ASSET_ANALYSIS_START:", JSON.stringify({
      doName: params.doName || "",
      assetId: asset.asset_id,
      fileId: asset.file_id,
      assetCount: mediaBatch.assets.length
    }));
    logEvent("MEDIA_ASSET_ANALYSIS_START", {
      traceId: params.traceId || "",
      turnId: params.turnId || "",
      doName: params.doName || "",
      assetId: asset.asset_id,
      fileId: asset.file_id,
      assetCount: mediaBatch.assets.length
    });

    try {
      const analysis = await analyzeSingleMediaAsset(env, {
        asset: asset,
        caption: params.caption || "",
        woztellPayload: params.woztellPayload || {}
      });

      assetForAnalysis.analysis = analysis;
      assetForAnalysis.status = "analyzed";

      console.log("MEDIA_ASSET_ANALYSIS_OK:", JSON.stringify({
        doName: params.doName || "",
        assetId: asset.asset_id,
        fileId: asset.file_id,
        confidence: analysis && analysis.confidence || 0
      }));
      logEvent("MEDIA_ASSET_ANALYSIS_OK", {
        traceId: params.traceId || "",
        turnId: params.turnId || "",
        doName: params.doName || "",
        assetId: asset.asset_id,
        fileId: asset.file_id,
        confidence: analysis && analysis.confidence || 0
      });
    } catch (error) {
      assetForAnalysis.status = "analysis_failed";
      assetForAnalysis.analysis_error = String(error.message || error);

      console.log("MEDIA_ASSET_ANALYSIS_FAILED:", JSON.stringify({
        doName: params.doName || "",
        assetId: asset.asset_id,
        fileId: asset.file_id,
        message: String(error.message || error),
        usedFallback: true
      }));
      logEvent("MEDIA_ASSET_ANALYSIS_FAILED", {
        traceId: params.traceId || "",
        turnId: params.turnId || "",
        doName: params.doName || "",
        assetId: asset.asset_id,
        fileId: asset.file_id,
        message: String(error.message || error),
        usedFallback: true
      }, {
        level: "error",
        traceId: params.traceId || ""
      });
    }

    analyzedAssets.push(assetForAnalysis);
  }

  const summary = buildMediaBatchSummary({ assets: analyzedAssets });

  return {
    assets: analyzedAssets,
    summary: summary
  };
}

async function analyzeSingleMediaAsset(env, params) {
  const asset = params.asset || {};

  return await analyzeUploadedImageWithOpenAI(env, {
    uploadedImage: {
      fileId: asset.file_id,
      url: asset.url,
      type: asset.media_type || "IMAGE",
      mimeType: asset.mime_type || "",
      app: params.woztellPayload && params.woztellPayload.app || ""
    },
    caption: params.caption || "",
    woztellPayload: params.woztellPayload || {}
  });
}

function updateCampaignAssetsWithAnalysis(campaignState, analyzedAssets) {
  const state = normalizeCampaignState(campaignState || {});
  const byId = new Map((analyzedAssets || []).map(function (asset) {
    return [asset.asset_id, asset];
  }));
  const byFileId = new Map((analyzedAssets || []).filter(function (asset) {
    return asset.file_id;
  }).map(function (asset) {
    return [asset.file_id, asset];
  }));

  state.campaign_assets = normalizeCampaignAssets(state.campaign_assets).map(function (asset) {
    const patch = byId.get(asset.asset_id) || byFileId.get(asset.file_id);
    return patch ? Object.assign({}, asset, patch) : asset;
  });

  state.media_batch_summary = buildMediaBatchSummary({ assets: state.campaign_assets });

  return state;
}

function buildMediaBatchSummary(mediaBatch) {
  const assets = normalizeCampaignAssets(mediaBatch && mediaBatch.assets || []);
  const analyzed = assets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; });
  const failed = assets.filter(function (asset) { return asset.status === "analysis_failed"; });
  const subjects = analyzed.map(function (asset) {
    return asset.analysis && (asset.analysis.product_type || asset.analysis.main_subject || asset.analysis.marketing_notes || "");
  }).filter(Boolean);

  return {
    asset_count: assets.length,
    analyzed_asset_count: analyzed.length,
    failed_asset_count: failed.length,
    file_ids: assets.map(function (asset) { return asset.file_id; }).filter(Boolean),
    analyzed_asset_ids: analyzed.map(function (asset) { return asset.asset_id; }),
    failed_asset_ids: failed.map(function (asset) { return asset.asset_id; }),
    summary: subjects.length ? subjects.join(" | ").slice(0, 1200) : "",
    assets: assets.map(function (asset) {
      return {
        asset_id: asset.asset_id,
        file_id: asset.file_id,
        status: asset.status,
        url: asset.url,
        analysis: asset.analysis
      };
    })
  };
}

function buildOrchestratorInputSummary(params) {
  const state = normalizeCampaignState(params.campaignState || {});
  const batch = params.mediaBatch || buildMediaBatch(state, params.messages || []);
  const summary = params.mediaBatchSummary || buildMediaBatchSummary(batch);

  return {
    message_count: (params.messages || []).length,
    asset_count: summary.asset_count || batch.assets.length,
    analyzed_asset_count: summary.analyzed_asset_count || 0,
    failed_asset_count: summary.failed_asset_count || 0,
    file_ids: summary.file_ids || batch.fileIds || [],
    workflow_status: state.workflow_status,
    campaign_type: state.campaign_type,
    current_asset_source: state.current_asset_source || "",
    has_uploaded_image_analysis: Boolean(state.uploaded_image_analysis),
    consolidated_messages_preview: consolidatedMessagesText(params.messages || []).slice(0, 1000)
  };
}

function buildMediaLogPayload(data, messages, summary, usedFallback) {
  return {
    doName: data.doName || "",
    messageCount: (messages || []).length,
    assetCount: summary.asset_count || 0,
    fileIds: summary.file_ids || [],
    analyzedAssetCount: summary.analyzed_asset_count || 0,
    failedAssetCount: summary.failed_asset_count || 0,
    workflow_status: data.campaignState && data.campaignState.workflow_status || "",
    campaign_type: data.campaignState && data.campaignState.campaign_type || "",
    usedFallback: Boolean(usedFallback)
  };
}

function extractWoztellMessage(body) {
  const payload = body || {};
  const event = normalizeInboundEvent(payload);
  const data = payload.data || {};
  const type = event.type || normalizeEventType(payload.type || data.type || "", payload) || "UNSUPPORTED";
  const text = event.text || event.caption || "";
  const fileId = data.fileId ||
    payload.fileId ||
    data.mediaId ||
    payload.mediaId ||
    data.file && data.file.fileId ||
    payload.file && payload.file.fileId ||
    data.attachment && data.attachment.fileId ||
    payload.attachment && payload.attachment.fileId ||
    data.audio && data.audio.fileId ||
    payload.audio && payload.audio.fileId ||
    data.voice && data.voice.fileId ||
    payload.voice && payload.voice.fileId ||
    "";

  return {
    type: type,
    text: String(text || "").trim(),
    fileId: String(fileId || ""),
    caption: event.caption || "",
    media: Array.isArray(payload.media) ? payload.media : Array.isArray(data.media) ? data.media : [],
    fileName: data.fileName || payload.fileName || data.file && data.file.fileName || payload.file && payload.file.fileName || "",
    mimeType: data.mimeType || payload.mimeType || data.file && data.file.mimeType || payload.file && payload.file.mimeType || data.audio && data.audio.mimeType || payload.audio && payload.audio.mimeType || "",
    messageId: payload.messageId || data.messageId || ""
  };
}

function buildConversationName(woztellPayload) {
  return [
    woztellPayload.channel || "unknown_channel",
    woztellPayload.from || "unknown_user"
  ].join(":");
}

function buildWoztellPayloadFromData(data, messages) {
  const first = messages[0] || {};

  return {
    to: first.to || "",
    from: data.phone || first.from || "",
    channel: data.channel || first.channel || "",
    app: data.app || first.app || "",
    member: data.member || first.member || "",
    messageId: messages.map(function (msg) { return msg.messageId; }).join(",")
  };
}

function consolidatedMessagesText(messages) {
  return buildCombinedUserText(messages || []);
}

function buildImagePrompt(userPrompt, state) {
  return [
    "Create a professional social media image.",
    "Quality: low generation setting is used by backend.",
    "Use a clean commercial composition.",
    "Do not include tiny unreadable text.",
    "",
    "User/design brief:",
    userPrompt || "",
    "",
    "Uploaded image analysis:",
    state && state.uploaded_image_analysis ? JSON.stringify(state.uploaded_image_analysis, null, 2) : "No uploaded image analysis available.",
    "",
    "Relevant last copy:",
    getLastCopyFromState(state)
  ].join("\n");
}

async function resolveImageSourceUrl(env, job, state, woztellPayload) {
  const uploadedImage = getLastUploadedImage(state);

  if (job.source === "uploaded_image") {
    if (uploadedImage.url) {
      console.log("USING_UPLOADED_IMAGE_FOR_EDIT:", JSON.stringify({
        source: "url",
        url: uploadedImage.url
      }));
      return uploadedImage.url;
    }

    if (uploadedImage.fileId) {
      const fileInfo = await getWoztellFileInfo(env, {
        appId: uploadedImage.app || woztellPayload.app || "",
        fileId: uploadedImage.fileId
      });

      console.log("USING_UPLOADED_IMAGE_FOR_EDIT:", JSON.stringify({
        source: "fileId_resolved",
        fileId: uploadedImage.fileId,
        url: fileInfo.url || ""
      }));

      return fileInfo.url || "";
    }

    return "";
  }

  if (job.source === "last_generated_image") {
    const lastGeneratedUrl = getLastImageUrlFromState(state);

    if (lastGeneratedUrl) {
      console.log("USING_LAST_GENERATED_IMAGE_FOR_EDIT:", JSON.stringify({
        url: lastGeneratedUrl
      }));
    }

    return lastGeneratedUrl;
  }

  if (state && state.current_asset_source === "uploaded_image") {
    return await resolveImageSourceUrl(env, Object.assign({}, job, { source: "uploaded_image" }), state, woztellPayload);
  }

  return getLastImageUrlFromState(state);
}

function guessPlatformsFromActions(actions) {
  const platforms = new Set();

  for (const action of actions || []) {
    for (const platform of action.platforms || []) {
      platforms.add(String(platform));
    }
  }

  if (!platforms.size) platforms.add("instagram");
  return Array.from(platforms);
}

function extractHashtags(text) {
  const hashtags = String(text || "").match(/#[\p{L}\p{N}_]+/gu);
  return hashtags ? hashtags.join(" ") : "";
}

function splitTextForWhatsApp(text, maxLength) {
  const clean = String(text || "").trim();

  if (clean.length <= maxLength) return [clean];

  const parts = [];
  let remaining = clean;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n\n", maxLength);
    if (splitAt < 500) splitAt = remaining.lastIndexOf("\n", maxLength);
    if (splitAt < 500) splitAt = remaining.lastIndexOf(" ", maxLength);
    if (splitAt < 500) splitAt = maxLength;

    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) parts.push(remaining);
  return parts;
}

function normalizeImageMediaType(contentType) {
  const clean = String(contentType || "").split(";")[0].trim().toLowerCase();

  if (clean === "image/jpg") return "image/jpeg";
  if (clean === "image/jpeg") return "image/jpeg";
  if (clean === "image/png") return "image/png";
  if (clean === "image/webp") return "image/webp";

  return "image/jpeg";
}

async function fetchWithTimeout(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = setTimeout(function () {
    console.error(label || "FETCH_TIMEOUT", JSON.stringify({ url: url, timeoutMs: timeoutMs }));
    controller.abort(label || "timeout");
  }, timeoutMs || 10000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return { raw: text };
  }
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data, null, 2), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json"
    }
  });
}

function buildVersionDiagnostic(env) {
  const now = new Date().toISOString();
  const flags = getCoreFeatureFlags(env || {});
  const remindersMode = String(flags.remindersDeliveryMode || "mock");
  const interactiveMode = String(flags.interactiveDeliveryMode || "safe");

  return {
    version: "whatsapp-ai-agent-core-v3",
    build_label: String(env && env.BUILD_LABEL || "local-dev"),
    ORCHESTRATOR_PROVIDER: String(env && env.ORCHESTRATOR_PROVIDER || "openai"),
    ORCHESTRATOR_MODEL: String(env && env.ORCHESTRATOR_MODEL || "gpt-5.4-mini"),
    SUPERVISOR_MODEL: getSupervisorConfig(env || {}).model,
    SUPERVISOR_FALLBACK_MODEL: String(env && env.SUPERVISOR_FALLBACK_MODEL || "gpt-5.4-mini"),
    ROUTER_MODEL: getRouterModel(env || {}),
    SPECIALIST_DEFAULT_MODEL: getSpecialistModel(env || {}, "default"),
    SPECIALIST_CHEAP_MODEL: String(env && env.SPECIALIST_CHEAP_MODEL || "gpt-5.4-nano"),
    FINAL_RESPONSE_MODEL: getFinalResponseModel(env || {}),
    CUSTOMER_REPLY_MODEL: getCustomerReplyModel(env || {}),
    VISION_MODEL: getVisionModel(env || {}),
    DEBUG_LOGS: String(flags.debugLogs),
    ENABLE_LISTS: String(flags.enableLists),
    ENABLE_REMINDERS: String(flags.enableReminders),
    ENABLE_WHATSAPP_INTERACTIVE: String(flags.enableWhatsAppInteractive),
    ENABLE_TEMPLATE_MODULE: String(flags.enableTemplateModule),
    SAVE_CONVERSATION_LOGS: String(flags.saveConversationLogs),
    ENABLE_USER_STYLE_PROFILE: String(flags.enableUserStyleProfile),
    ENABLE_CUSTOMER_MEMORY: String(flags.enableCustomerMemory),
    CORE_UTILITIES_SANDBOX: String(flags.coreUtilitiesSandbox),
    REMINDERS_DELIVERY_MODE: remindersMode,
    REMINDER_TEMPLATE_CONFIGURED: String(Boolean(env && env.REMINDER_TEMPLATE_NAME)),
    INTERACTIVE_DELIVERY_MODE: interactiveMode,
    MEMORY_RETENTION_MODE: String(flags.memoryRetentionMode || "summarized"),
    LOG_CAPTURE_MODE: String(flags.logCaptureMode || "console_and_file"),
    REMINDERS_STATUS: remindersMode === "alarm" ? "production_alarm_requires_worker_alarm" : remindersMode === "cron" ? "production_cron_requires_scheduler" : remindersMode === "disabled" ? "disabled" : "mock_safe_no_real_delivery",
    INTERACTIVE_STATUS: interactiveMode === "safe" ? "safe_with_text_fallback" : interactiveMode,
    MEMORY_STATUS: flags.memoryRetentionMode === "summarized" ? "summarized_no_raw_history" : String(flags.memoryRetentionMode || ""),
    LOGS_STATUS: flags.logCaptureMode === "console_and_file" ? "console_plus_local_wrapper" : String(flags.logCaptureMode || ""),
    timestamp: now
  };
}

function formatVersionDiagnosticForWhatsApp(diagnostic) {
  const data = diagnostic || {};

  return [
    "WhatsApp AI Agent Core",
    "version: " + (data.version || ""),
    "build_label: " + (data.build_label || ""),
    "ORCHESTRATOR_PROVIDER: " + (data.ORCHESTRATOR_PROVIDER || ""),
    "ORCHESTRATOR_MODEL: " + (data.ORCHESTRATOR_MODEL || ""),
    "SUPERVISOR_MODEL: " + (data.SUPERVISOR_MODEL || ""),
    "SUPERVISOR_FALLBACK_MODEL: " + (data.SUPERVISOR_FALLBACK_MODEL || ""),
    "ROUTER_MODEL: " + (data.ROUTER_MODEL || ""),
    "SPECIALIST_DEFAULT_MODEL: " + (data.SPECIALIST_DEFAULT_MODEL || ""),
    "SPECIALIST_CHEAP_MODEL: " + (data.SPECIALIST_CHEAP_MODEL || ""),
    "FINAL_RESPONSE_MODEL: " + (data.FINAL_RESPONSE_MODEL || ""),
    "CUSTOMER_REPLY_MODEL: " + (data.CUSTOMER_REPLY_MODEL || ""),
    "VISION_MODEL: " + (data.VISION_MODEL || ""),
    "DEBUG_LOGS: " + (data.DEBUG_LOGS || ""),
    "ENABLE_LISTS: " + (data.ENABLE_LISTS || ""),
    "ENABLE_REMINDERS: " + (data.ENABLE_REMINDERS || ""),
    "ENABLE_WHATSAPP_INTERACTIVE: " + (data.ENABLE_WHATSAPP_INTERACTIVE || ""),
    "ENABLE_TEMPLATE_MODULE: " + (data.ENABLE_TEMPLATE_MODULE || ""),
    "SAVE_CONVERSATION_LOGS: " + (data.SAVE_CONVERSATION_LOGS || ""),
    "ENABLE_USER_STYLE_PROFILE: " + (data.ENABLE_USER_STYLE_PROFILE || ""),
    "ENABLE_CUSTOMER_MEMORY: " + (data.ENABLE_CUSTOMER_MEMORY || ""),
    "CORE_UTILITIES_SANDBOX: " + (data.CORE_UTILITIES_SANDBOX || ""),
    "REMINDERS_DELIVERY_MODE: " + (data.REMINDERS_DELIVERY_MODE || ""),
    "REMINDER_TEMPLATE_CONFIGURED: " + (data.REMINDER_TEMPLATE_CONFIGURED || ""),
    "REMINDERS_STATUS: " + (data.REMINDERS_STATUS || ""),
    "INTERACTIVE_DELIVERY_MODE: " + (data.INTERACTIVE_DELIVERY_MODE || ""),
    "INTERACTIVE_STATUS: " + (data.INTERACTIVE_STATUS || ""),
    "MEMORY_RETENTION_MODE: " + (data.MEMORY_RETENTION_MODE || ""),
    "MEMORY_STATUS: " + (data.MEMORY_STATUS || ""),
    "LOG_CAPTURE_MODE: " + (data.LOG_CAPTURE_MODE || ""),
    "LOGS_STATUS: " + (data.LOGS_STATUS || ""),
    "timestamp: " + (data.timestamp || "")
  ].join("\n");
}

function normalizeActiveTask(task) {
  if (!task || typeof task !== "object") return null;
  const taskMediaFileIds = Array.isArray(task.taskMediaFileIds || task.task_media_file_ids)
    ? (task.taskMediaFileIds || task.task_media_file_ids).map(String).filter(Boolean)
    : [];
  const relatedMessageIds = Array.isArray(task.relatedMessageIds || task.related_message_ids)
    ? (task.relatedMessageIds || task.related_message_ids).map(String).filter(Boolean)
    : [];
  const relatedText = Array.isArray(task.relatedText || task.related_text)
    ? (task.relatedText || task.related_text).map(String).filter(Boolean).slice(-8)
    : [];

  return {
    type: String(task.type || "pending_media_task"),
    status: String(task.status || "awaiting_media"),
    startedAt: Number(task.startedAt || task.started_at || Date.now()),
    startedAtIso: String(task.startedAtIso || task.started_at_iso || new Date(Number(task.startedAt || Date.now())).toISOString()),
    expectedInputs: String(task.expectedInputs || task.expected_inputs || "images"),
    originalUserRequest: String(task.originalUserRequest || task.original_user_request || "").slice(0, 1000),
    waitSeconds: Number(task.waitSeconds || task.wait_seconds || 30),
    maxWaitSeconds: Number(task.maxWaitSeconds || task.max_wait_seconds || 45),
    silenceSeconds: Number(task.silenceSeconds || task.silence_seconds || 8),
    waitUntil: Number(task.waitUntil || task.wait_until || 0),
    maxWaitUntil: Number(task.maxWaitUntil || task.max_wait_until || 0),
    lastActivityAt: Number(task.lastActivityAt || task.last_activity_at || task.startedAt || Date.now()),
    lastMediaAt: Number(task.lastMediaAt || task.last_media_at || 0),
    taskMediaFileIds: Array.from(new Set(taskMediaFileIds)),
    relatedMessageIds: Array.from(new Set(relatedMessageIds)),
    relatedText: relatedText,
    receivedMediaCount: Number(task.receivedMediaCount || task.received_media_count || taskMediaFileIds.length || 0),
    doneSignalReceived: Boolean(task.doneSignalReceived || task.done_signal_received || false),
    completedReason: String(task.completedReason || task.completed_reason || "")
  };
}

function createTaskIntakeFromText(text, options) {
  const original = String(text || "").trim();
  if (!original || !isPendingMediaTaskRequest(original)) return null;
  const timing = options || {};
  const now = Number(timing.now || Date.now());
  const waitSeconds = Number(timing.waitSeconds || 30);
  const maxWaitSeconds = Number(timing.maxWaitSeconds || 45);
  const silenceSeconds = Number(timing.silenceSeconds || 8);

  return normalizeActiveTask({
    type: inferTaskIntakeType(original),
    status: "awaiting_media",
    startedAt: now,
    startedAtIso: new Date(now).toISOString(),
    expectedInputs: "images",
    originalUserRequest: original,
    waitSeconds: waitSeconds,
    maxWaitSeconds: maxWaitSeconds,
    silenceSeconds: silenceSeconds,
    waitUntil: now + waitSeconds * 1000,
    maxWaitUntil: now + maxWaitSeconds * 1000,
    lastActivityAt: now,
    relatedText: [original],
    taskMediaFileIds: [],
    receivedMediaCount: 0
  });
}

function updateTaskIntakeWithMessage(activeTask, message, options) {
  const task = normalizeActiveTask(activeTask);
  if (!task || task.status !== "awaiting_media") return task;
  const msg = message || {};
  const now = Number(options && options.now || Date.now());
  const fileIds = extractImageFileIdsFromMessage(msg);
  const text = extractPlainTurnText(msg.text || "");
  const relatedMessageIds = task.relatedMessageIds.slice();
  const relatedText = task.relatedText.slice();
  const taskMediaFileIds = task.taskMediaFileIds.slice();

  if (msg.messageId) relatedMessageIds.push(String(msg.messageId));
  if (text) relatedText.push(text);
  for (const fileId of fileIds) taskMediaFileIds.push(fileId);

  return normalizeActiveTask(Object.assign({}, task, {
    lastActivityAt: now,
    lastMediaAt: fileIds.length ? now : task.lastMediaAt,
    taskMediaFileIds: Array.from(new Set(taskMediaFileIds)),
    relatedMessageIds: Array.from(new Set(relatedMessageIds)),
    relatedText: relatedText.slice(-8),
    receivedMediaCount: Array.from(new Set(taskMediaFileIds)).length,
    doneSignalReceived: task.doneSignalReceived || isTaskDoneSignal(text)
  }));
}

function buildTaskIntakeDecision(activeTask, options) {
  const task = normalizeActiveTask(activeTask);
  if (!task || task.status !== "awaiting_media") {
    return { ready: false, shouldWait: false, reason: "no_active_task", nextProcessAt: 0 };
  }
  const now = Number(options && options.now || Date.now());
  const silenceSeconds = Number(options && options.silenceSeconds || task.silenceSeconds || 8);
  const userDone = Boolean(options && options.userDone || task.doneSignalReceived);
  const hasMedia = Boolean(options && Object.prototype.hasOwnProperty.call(options, "hasMedia")
    ? options.hasMedia
    : task.receivedMediaCount > 0);
  const silenceAt = (task.lastMediaAt || task.lastActivityAt || task.startedAt) + silenceSeconds * 1000;
  const maxWaitUntil = task.maxWaitUntil || task.startedAt + task.maxWaitSeconds * 1000;
  const waitUntil = task.waitUntil || task.startedAt + task.waitSeconds * 1000;

  if (hasMedia && userDone) return { ready: true, shouldWait: false, reason: "user_done", nextProcessAt: now };
  if (hasMedia && now >= maxWaitUntil) return { ready: true, shouldWait: false, reason: "max_wait", nextProcessAt: now };
  if (hasMedia && now >= silenceAt) return { ready: true, shouldWait: false, reason: "silence", nextProcessAt: now };
  if (!hasMedia && now >= waitUntil) return { ready: true, shouldWait: false, reason: "expired_no_media", nextProcessAt: now };

  return {
    ready: false,
    shouldWait: true,
    reason: hasMedia ? "awaiting_silence" : "awaiting_media",
    nextProcessAt: hasMedia ? Math.min(silenceAt, maxWaitUntil) : Math.min(waitUntil, maxWaitUntil)
  };
}

function handleUserClaimedMoreImages(text, campaignState, messages) {
  const normalized = normalizeTextForIntent(text);
  if (!isUserClaimingMoreImages(normalized)) {
    return { claimed: false, claimedCount: 0, receivedCount: 0, shouldReanalyze: false, mediaBatch: { assets: [], fileIds: [] }, message: "" };
  }
  const claimedCount = extractClaimedImageCount(normalized) || 2;
  const mediaBatch = buildMediaBatch(campaignState || {}, messages || [], { mode: "previous_relevant" });
  const imageAssets = (mediaBatch.assets || []).filter(function (asset) {
    return String(asset.media_type || "IMAGE").toUpperCase() === "IMAGE";
  });
  const receivedCount = imageAssets.length;
  const shouldReanalyze = receivedCount >= claimedCount;
  const message = shouldReanalyze
    ? ""
    : "Me llego solo una imagen; mandame la otra y la comparo.";

  logEvent("USER_CLAIMED_MORE_IMAGES", {
    claimedCount: claimedCount,
    receivedCount: receivedCount
  });
  logEvent("MEDIA_RECOUNT_DONE", {
    claimedCount: claimedCount,
    receivedCount: receivedCount,
    shouldReanalyze: shouldReanalyze,
    fileIds: imageAssets.map(function (asset) { return asset.file_id; }).filter(Boolean)
  });

  return {
    claimed: true,
    claimedCount: claimedCount,
    receivedCount: receivedCount,
    shouldReanalyze: shouldReanalyze,
    mediaBatch: Object.assign({}, mediaBatch, {
      assets: imageAssets,
      fileIds: imageAssets.map(function (asset) { return asset.file_id; }).filter(Boolean),
      assetCount: imageAssets.length
    }),
    message: message
  };
}

function isPendingMediaTaskRequest(text) {
  const normalized = normalizeTextForIntent(text);
  if (isExplicitMarketingRequest(normalized)) return false;
  return /\b(revisa|mira|analiza|compara|puedes ver|te mando|te paso|voy a mandar|voy a pasar)\b.*\b(precio|precios|valor|valores|caro|cara|captura|capturas|foto|fotos|imagen|imagenes|imagenes|producto|productos)\b/.test(normalized) ||
    /\b(que tal|que tal)\b.*\b(precio|precios|valores)\b/.test(normalized) ||
    /\b(te mando unas imagenes|te paso fotos|compara estas fotos|revisa estas capturas|mira estas imagenes|analiza estos productos)\b/.test(normalized);
}

function inferTaskIntakeType(text) {
  const normalized = normalizeTextForIntent(text);
  if (/\b(precio|precios|valor|valores|caro|cara|barato|barata|conviene)\b/.test(normalized)) return "price_review";
  if (/\b(documento|documentos|archivo|archivos|pdf)\b/.test(normalized)) return "document_review";
  if (/\b(imagen|imagenes|foto|fotos|captura|capturas|producto|productos)\b/.test(normalized)) return "image_review";
  return "pending_media_task";
}

function isTaskDoneSignal(text) {
  const normalized = normalizeTextForIntent(text);
  return /^(listo|ya|esas son|eso es todo|dale|revisa|revise|analiza|compara)\.?$/.test(normalized) ||
    /\b(eso es todo|esas son|ya estan|dale revisa|dale analiza)\b/.test(normalized);
}

function isUserClaimingMoreImages(text) {
  const normalized = normalizeTextForIntent(text);
  return /\b(te mande|te envie|te pase|mande|envie|pase)\s+\d+\s+(imagen|imagenes|foto|fotos|captura|capturas)\b/.test(normalized) ||
    /\b(pero|oye|no)\b.*\b(eran|son)\s+\d+\s+(imagen|imagenes|foto|fotos|captura|capturas)\b/.test(normalized);
}

function extractClaimedImageCount(text) {
  const numeric = String(text || "").match(/\b(\d{1,2})\s+(?:imagen|imagenes|foto|fotos|captura|capturas)\b/);
  if (numeric) return Number(numeric[1]);
  if (/\bdos\s+(?:imagenes|fotos|capturas)\b/.test(text)) return 2;
  if (/\btres\s+(?:imagenes|fotos|capturas)\b/.test(text)) return 3;
  return 0;
}

function extractImageFileIdsFromMessage(message) {
  const msg = message || {};
  const ids = [];
  if (msg.fileId && String(msg.type || "").toUpperCase() === "IMAGE") ids.push(String(msg.fileId));
  for (const item of msg.media || []) {
    if (item && item.fileId && String(item.type || "IMAGE").toUpperCase() === "IMAGE") ids.push(String(item.fileId));
  }
  return Array.from(new Set(ids));
}

function getNumberEnv(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getTaskIntakeTimingConfig(env) {
  const waitSeconds = getNumberEnv(env && env.TASK_INTAKE_WAIT_SECONDS, 30);
  const maxWaitSeconds = Math.max(waitSeconds, getNumberEnv(env && env.TASK_INTAKE_MAX_WAIT_SECONDS, 45));

  return {
    waitSeconds: waitSeconds,
    maxWaitSeconds: maxWaitSeconds,
    silenceSeconds: getNumberEnv(env && env.TASK_INTAKE_SILENCE_SECONDS, 8)
  };
}

function getBufferTimingConfig(env) {
  const timing = getTurnAggregationTiming(env || {});
  return {
    bufferWaitSeconds: Math.max(1, Math.round((Number(env && env.BUFFER_WAIT_SECONDS || 0) || timing.minWaitMs / 1000))),
    imageMessageWaitSeconds: Math.max(1, Math.round((Number(env && env.IMAGE_MESSAGE_WAIT_SECONDS || 0) || timing.silenceMs / 1000))),
    bufferMaxWaitSeconds: Math.max(1, Math.round((Number(env && env.BUFFER_MAX_WAIT_SECONDS || 0) || timing.maxWaitMs / 1000))),
    turnSilenceMs: timing.silenceMs,
    turnMaxWaitMs: timing.maxWaitMs,
    turnMinWaitMs: timing.minWaitMs
  };
}

function shouldHoldMediaTurnForMoreEvents(data, messages, env) {
  const list = Array.isArray(messages) ? messages : [];
  const hasMedia = list.some(function (message) {
    return Boolean(message && (message.fileId || message.media && message.media.length || ["IMAGE", "VIDEO", "FILE"].includes(String(message.type || "").toUpperCase())));
  });

  if (!hasMedia) return { hold: false };

  const hasClearTextOrAudio = list.some(function (message) {
    const type = String(message && message.type || "").toUpperCase();
    const text = cleanUserVisibleText(message && (message.audioTranscript || message.text) || "");
    return Boolean(text && (type === "TEXT" || type === "AUDIO" || message && message.audioTranscript));
  });

  const combinedText = consolidatedMessagesText(list);
  if (hasClearTextOrAudio || isUserDoneSignal(combinedText)) return { hold: false };

  const timing = getTurnAggregationTiming(env || {});
  const firstAt = Number(data && data.firstMessageAt || Date.now());
  const now = Date.now();
  const ageMs = now - firstAt;
  const nextProcessAt = firstAt + timing.maxWaitMs;

  if (ageMs >= timing.maxWaitMs) return { hold: false };

  return {
    hold: true,
    reason: "media_only_waiting_for_turn_max",
    ageMs: ageMs,
    nextProcessAt: nextProcessAt
  };
}

function hasOpenPendingTurn(data, now, env) {
  const state = data || {};
  const pending = Array.isArray(state.pendingMessages) ? state.pendingMessages : [];
  if (!state.currentTurnId || !pending.length) return false;

  const timing = getTurnAggregationTiming(env || {});
  const firstAt = Number(state.firstMessageAt || now || Date.now());
  const ageMs = Number(now || Date.now()) - firstAt;
  return ageMs <= timing.maxWaitMs;
}

function getAudioTurnWaitConfig(env) {
  const timing = getTurnAggregationTiming(env || {});
  return {
    maxAudioTurnWaitMs: Number(env && env.AUDIO_TURN_WAIT_SECONDS || 0) > 0
      ? getNumberEnv(env && env.AUDIO_TURN_WAIT_SECONDS, 75) * 1000
      : timing.audioMaxWaitMs,
    retryWaitMs: getNumberEnv(env && env.AUDIO_TURN_RETRY_SECONDS, 3) * 1000
  };
}

function getFastAckDelayMs(env) {
  return getNumberEnv(env && env.FAST_ACK_DELAY_MS, 1200);
}

function sanitizeKeyPart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

function randomId(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";

  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }

  return out;
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

export {
  extractWoztellMessage,
  normalizeIncomingMessage,
  extractMediaFromPayload,
  addCampaignAsset,
  getUploadedMediaBatch,
  buildMediaBatch,
  buildAudioBatch,
  buildVideoMetadata,
  shouldStartNewTurn,
  shouldUsePreviousContext,
  buildUserTurn,
  buildTurnSummary,
  buildOrchestratorInput,
  buildContextSnapshot,
  clearMediaState,
  forgetAllConversationData,
  createEmptyConversationContext,
  formatContextForWhatsApp,
  formatVisionUtilityResponse,
  formatListsIndexForWhatsApp,
  formatRemindersForWhatsApp,
  updateConversationContext,
  compactConversationHistory,
  mapOrchestratorActions,
  analyzeMediaBatch,
  buildMediaBatchSummary,
  createTaskIntakeFromText,
  updateTaskIntakeWithMessage,
  buildTaskIntakeDecision,
  handleUserClaimedMoreImages,
  buildVersionDiagnostic,
  formatVersionDiagnosticForWhatsApp,
  consolidatedMessagesText,
  parseCustomerReplyModelOutput
};












