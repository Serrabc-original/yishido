// VERSION: v2.2-durable - Content calendar + bulk campaign planning
// DATE: 2026-06-09
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
// - COPY_MODEL = gpt-5-nano
// - OPENAI_IMAGE_MODEL = gpt-image-2
// - R2_PUBLIC_BASE_URL
// - GOOGLE_SHEETS_WEBHOOK_URL
// - GOOGLE_SHEETS_SECRET
//
// OPTIONAL:
// - BUFFER_WAIT_SECONDS = 5
// - IMAGE_MESSAGE_WAIT_SECONDS = 8
// - BUFFER_MAX_WAIT_SECONDS = 15
const USER_MESSAGES = {
  draftReady: "Te preparé esta propuesta. ¿La apruebas o quieres que haga cambios?",
  approvedAskPublish: "Perfecto, quedó aprobado ✅\n¿Quieres dejarlo listo para publicar ahora o prefieres seguir haciendo cambios?",
  readyToPublish: "Listo, lo dejé marcado como listo para publicar ✅\nAún no se publica automáticamente; ese será el siguiente paso cuando conectemos Meta.",
  imageReady: "Listo, te generé esta imagen.\n\n¿Quieres que haga otra versión o ajustamos el texto?",
  audioFailed: "Tuve un problema procesando tu audio. ¿Me lo puedes reenviar o escribirlo en texto?",
  resetOk: "Contexto reiniciado.",
  requestFailed: "Tuve un problema procesando tu solicitud. Intenta nuevamente en unos minutos.",
  uploadedImageMissing: "No pude encontrar la imagen subida. ¿Puedes reenviarla o describirme brevemente qué aparece en la imagen?",
  imageAnalysisFailed: "No pude leer bien la imagen. ¿Me puedes describir el producto o reenviarla con una breve descripción?",
  uploadedImageClarification: "¿Quieres que use esta imagen solo como base para el copy, o también quieres que la convierta en un diseño para Instagram?",
  changesAck: "Perfecto, hago los ajustes y te envío una nueva versión.",
  imageGenerationAck: "Perfecto. Voy a generar la imagen y te la envío apenas esté lista.",
  imageRevisionAck: "Listo. Voy a preparar una nueva versión de la imagen con ese cambio.",
  imageProcessing: "La imagen queda en proceso. Te la envío por aquí apenas esté lista.",
  genericClarification: "Entendido. ¿Qué quieres que prepare: texto, imagen o ambos?",
  imageFailed: "Tuve un problema al generar o enviar la imagen. ¿Quieres que lo intente nuevamente?",
  imageQueueFallback: "Tuve un problema generando la imagen. Puedes intentar de nuevo con una descripción más específica.",
  assetsCollected: "Ya recibí {count} imágenes. ¿Quieres que las use directamente para posts o que las tome como referencia para nuevos diseños?",
  calendarReady: "Te preparé un calendario de contenido. ¿Lo apruebas completo o quieres cambiar algún post?",
  bulkPostsReady: "Listo, generé los posts del calendario. Puedes aprobar todos, cambiar un número específico o dejarlos listos para publicar.",
  bulkApproved: "Perfecto, aprobé los posts seleccionados ✅\n¿Quieres dejarlos listos para publicar?",
  bulkReadyToPublish: "Listo, los posts seleccionados quedaron como ready_to_publish y scheduled_pending_meta ✅"
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "GET") {
      return jsonResponse({
        status: "ok",
        service: "Yishido Agent Gateway",
        version: "v2.2-durable",
        architecture: "Worker -> Durable Object -> Claude Orchestrator -> Tools"
      });
    }

    if (request.method !== "POST") {
      return jsonResponse({ status: "error", message: "Method not allowed" }, 405);
    }

    let body;

    try {
      body = await request.json();
    } catch (error) {
      console.error("JSON_PARSE_ERROR:", String(error.message || error));
      return jsonResponse({ status: "error", message: "Invalid JSON" }, 400);
    }

    console.log("WOZTELL_WEBHOOK_PAYLOAD:", JSON.stringify(body));

    if (body.eventType && body.eventType !== "INBOUND") {
      return jsonResponse({
        status: "ignored",
        reason: "Not inbound",
        eventType: body.eventType
      });
    }

    if (body.type && !["TEXT", "IMAGE", "VIDEO", "AUDIO", "VOICE", "PTT", "FILE"].includes(body.type)) {
      console.log("WOZTELL_STATUS_EVENT_IGNORED:", body.type);
      return jsonResponse({
        status: "ignored",
        reason: "Unsupported Woztell event",
        type: body.type
      });
    }

    let parsedMessage = extractWoztellMessage(body);

    console.log("WZ_PARSED_MESSAGE:", JSON.stringify({
      type: parsedMessage.type,
      text: parsedMessage.text || "",
      fileId: parsedMessage.fileId || "",
      messageId: body.messageId || parsedMessage.messageId || ""
    }));

    if (!parsedMessage.text && !parsedMessage.fileId) {
      return jsonResponse({
        status: "ignored",
        reason: "No text or file found"
      });
    }

    if (isAudioMessage(parsedMessage)) {
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
          parsedMessage: parsedMessage
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
        parsedMessage: parsedMessage
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
        parsedMessage: parsedMessage
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

        if (job.type === "generate_image" || job.type === "edit_image") {
          await processImageQueueJob(env, job);
        } else if (job.type === "transcribe_audio") {
          await processAudioQueueJob(env, job);
        } else {
          console.log("QUEUE_JOB_IGNORED:", JSON.stringify(job));
        }

        message.ack();
      } catch (error) {
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
        campaignState: data.campaignState
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
        reason: "no_pending",
        pendingCount: 0,
        processing: data.processing,
        processingStartedAt: data.processingStartedAt || null,
        now: now,
        processAfter: data.processAfter || 0,
        firstMessageAt: data.firstMessageAt || 0,
        lastMessageAt: data.lastMessageAt || 0
      }));
      await this.saveData(data);
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

    data.doName = body.doName || data.doName || buildConversationName(woztellPayload);
    data.channel = woztellPayload.channel || data.channel || "";
    data.phone = woztellPayload.from || data.phone || "";

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

    if (data.processedMessageIds.includes(messageId) || data.pendingMessages.some(function (msg) {
      return msg.messageId === messageId;
    })) {
      console.log("DO_DUPLICATE_MESSAGE_IGNORED:", messageId);
      return jsonResponse({ status: "duplicate_ignored", messageId: messageId });
    }

    const normalized = normalizeIncomingMessage(parsedMessage, woztellPayload, {
      messageId: messageId,
      receivedAt: new Date(now).toISOString()
    });

    if (normalizeTextForIntent(normalized.text) === "/reset") {
      data.pendingMessages = [];
      data.hasMedia = false;
      data.processing = false;
      data.processingStartedAt = null;
      data.firstMessageAt = 0;
      data.lastMessageAt = 0;
      data.processAfter = 0;
      data = resetCampaignState(data, "manual_reset");
      data.updatedAt = new Date().toISOString();

      await this.saveData(data);

      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: USER_MESSAGES.resetOk
      });

      return jsonResponse({ status: "reset_done" });
    }

    const startsNewCampaign = isNewCampaignRequest(normalized.text);

    if (startsNewCampaign) {
      console.log("NEW_CAMPAIGN_DETECTED:", JSON.stringify({
        doName: data.doName,
        previousCampaignId: data.campaignState.campaign_id,
        text: normalized.text.slice(0, 300)
      }));

      data = resetCampaignState(data, "new_campaign_request");
      data.pendingMessages = [];
      data.hasMedia = false;
      data.firstMessageAt = now;
      data.currentTurnId = "";
    }

    if (!data.pendingMessages.length) {
      data.firstMessageAt = now;
      data.currentTurnId = "turn_" + now + "_" + randomId(6);
    }

    data.lastMessageAt = now;
    normalized.turnId = data.currentTurnId || "turn_" + now + "_" + randomId(6);
    data.pendingMessages.push(normalized);

    console.log("TURN_CREATED:", JSON.stringify({
      doName: data.doName,
      turnId: normalized.turnId,
      messageCount: data.pendingMessages.length
    }));

    if (normalized.media.length || ["IMAGE", "VIDEO"].includes(normalized.type)) {
      data.hasMedia = true;
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
            url: uploadedImageUrl
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

        data.campaignState.campaign_assets = addCampaignAsset(data.campaignState.campaign_assets, assetPatch);
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

      data.campaignState.last_uploaded_image = latestUploadedImage || data.campaignState.last_uploaded_image;
      data.campaignState.current_asset_source = "uploaded_image";
      data.campaignState.uploaded_image_analysis = null;
      data.campaignState.collecting_assets = true;
      data.campaignState.campaign_type = data.campaignState.campaign_assets.length > 1
        ? "bulk_from_assets"
        : data.campaignState.campaign_type || "single_post";
      data.campaignState.workflow_status = "collecting_assets";
      data.campaignState.media_batch_summary = buildMediaBatchSummary(buildMediaBatch(data.campaignState, data.pendingMessages, { turnId: data.currentTurnId }));

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
    }

    data.campaignState.history = appendHistory(data.campaignState.history, {
      role: "user",
      type: normalized.type,
      text: normalized.text || (normalized.fileId ? "[media enviada]" : ""),
      fileId: normalized.fileId,
      at: normalized.receivedAt
    });

    const timing = getBufferTimingConfig(this.env);
    const waitReason = data.hasMedia ? "media_message" : "text_or_audio_transcript";
    const waitSeconds = data.hasMedia
      ? timing.imageMessageWaitSeconds
      : timing.bufferWaitSeconds;
    const maxWaitSeconds = timing.bufferMaxWaitSeconds;
    const desiredProcessAt = data.lastMessageAt + waitSeconds * 1000;
    const maxProcessAt = data.firstMessageAt + maxWaitSeconds * 1000;

    data.processAfter = Math.min(desiredProcessAt, maxProcessAt);
    data.updatedAt = new Date().toISOString();

    await this.saveData(data);
    await this.state.storage.setAlarm(data.processAfter);

    console.log("BUFFER_TIMING_CONFIG:", JSON.stringify(timing));
    console.log("BUFFER_WAIT_REASON:", JSON.stringify({
      doName: data.doName,
      reason: waitReason,
      pendingCount: data.pendingMessages.length,
      hasMedia: data.hasMedia
    }));
    console.log("BUFFER_PROCESS_AFTER_SET:", JSON.stringify({
      doName: data.doName,
      pendingCount: data.pendingMessages.length,
      desiredProcessAt: desiredProcessAt,
      maxProcessAt: maxProcessAt,
      processAfter: data.processAfter,
      processAfterIso: new Date(data.processAfter).toISOString()
    }));

    if (data.hasMedia) {
      const mediaBatch = buildMediaBatch(data.campaignState, data.pendingMessages, { turnId: data.currentTurnId });
      console.log("BUFFER_MEDIA_BATCH_READY:", JSON.stringify({
        doName: data.doName,
        messageCount: data.pendingMessages.length,
        assetCount: mediaBatch.assets.length,
        fileIds: mediaBatch.fileIds,
        workflow_status: data.campaignState.workflow_status,
        campaign_type: data.campaignState.campaign_type
      }));
    }

    console.log("DO_MESSAGE_BUFFERED:", JSON.stringify({
      doName: data.doName,
      pendingCount: data.pendingMessages.length,
      hasMedia: data.hasMedia,
      processAfter: new Date(data.processAfter).toISOString()
    }));

    return jsonResponse({
      status: "buffered",
      pendingCount: data.pendingMessages.length,
      processAfter: data.processAfter
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
        const transcript = String(body.transcript || "").trim();
        const audioStatus = body.type === "audio_transcribed" && transcript ? "transcribed" : "failed";
        const text = transcript
          ? ["[Audio transcrito]: " + transcript, message.text && !message.text.includes("[AUDIO") ? "[Texto adicional]: " + message.text : ""].filter(Boolean).join("\n")
          : message.text || "[AUDIO no transcrito]";

        return Object.assign({}, message, {
          type: transcript ? "TEXT" : message.type,
          text: text,
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

      const userTurn = buildUserTurn(messages, data.campaignState, { turnId: data.currentTurnId || "" });
      data.campaignState.current_turn = buildTurnSummary(userTurn);
      data.campaignState.active_turn = userTurn;
      const mediaBatch = userTurn.media_batch;
      data.campaignState.media_batch_summary = buildMediaBatchSummary(mediaBatch);

      console.log("TURN_BUFFER_READY:", JSON.stringify({
        doName: data.doName,
        turnId: userTurn.turn_id,
        messageCount: messages.length,
        contextPolicy: userTurn.context_policy
      }));
      console.log("TURN_INPUT_TYPES:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, inputTypes: userTurn.input_types }));
      console.log("TURN_TEXT_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.text_count }));
      console.log("TURN_AUDIO_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.audio_count }));
      console.log("TURN_IMAGE_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.image_count }));
      console.log("TURN_VIDEO_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.video_count }));
      console.log("TURN_FILE_COUNT:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, count: userTurn.file_count }));
      console.log("TURN_CAPTIONS_FOUND:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, captions: userTurn.captions }));
      console.log("TURN_CONTEXT_POLICY:", JSON.stringify({ doName: data.doName, turnId: userTurn.turn_id, policy: userTurn.context_policy }));
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

      if (shouldSendAudioOnlyFallback(userTurn)) {
        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: USER_MESSAGES.audioFailed
        });

        console.log("AUDIO_BATCH_TRANSCRIPTION_DONE:", JSON.stringify({
          doName: data.doName,
          turnId: userTurn.turn_id,
          audioCount: userTurn.audio_batch.count,
          transcribedCount: userTurn.audio_batch.transcribedCount,
          failedCount: userTurn.audio_batch.failedCount
        }));
      } else if (shouldAskHowToUseCollectedAssets(data, messages)) {
        const assetCount = data.campaignState.campaign_assets.length;
        const text = USER_MESSAGES.assetsCollected.replace("{count}", String(assetCount));

        await sendWoztellTextMessage(this.env, {
          channelId: data.channel,
          recipientId: data.phone,
          text: text
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
      const plan = await callOrchestratorPlan(this.env, {
        doName: data.doName,
        channel: data.channel,
        phone: data.phone,
        messages: messages,
        clientProfile: data.clientProfile,
        campaignState: data.campaignState
        ,
        userTurn: userTurn
      });

      console.log("ORCHESTRATOR_PLAN:", JSON.stringify(plan));

      data = await this.executePlan(data, messages, plan, userTurn);
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
      data.firstMessageAt = data.pendingMessages.length ? Date.now() : 0;
      data.lastMessageAt = data.pendingMessages.length ? Date.now() : 0;
      data.processAfter = 0;
      data.updatedAt = new Date().toISOString();
      success = true;
    } catch (error) {
      console.error("DO_PROCESS_BUFFER_ERROR:", String(error.message || error));

      data = await this.getData();
      data.updatedAt = new Date().toISOString();
      shouldSendFallback = true;
    } finally {
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

      data.pendingMessages = data.pendingMessages.filter(function (pending) {
        return !messages.some(function (processed) {
          return processed.messageId === pending.messageId;
        });
      });
      data.hasMedia = data.pendingMessages.some(function (pending) {
        return pending.fileId || ["IMAGE", "VIDEO"].includes(pending.type || "");
      });
      data.processAfter = 0;
      data.updatedAt = new Date().toISOString();
      await this.saveData(data);
    }
  }

  async executePlan(data, messages, plan, userTurn) {
    const woztellPayload = buildWoztellPayloadFromData(data, messages);
    const actions = Array.isArray(plan.actions) ? plan.actions : [];
    const mediaBatch = userTurn && userTurn.media_batch || buildMediaBatch(data.campaignState, messages, { turnId: data.currentTurnId || "" });
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
      const uploadedMediaBatch = userTurn && userTurn.media_batch || getUploadedMediaBatch(data.campaignState, messages, { turnId: data.currentTurnId || "" });
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

      const analysisResult = await analyzeMediaBatch(this.env, {
        doName: data.doName,
        campaignState: data.campaignState,
        mediaBatch: imageAnalysisBatch,
        caption: consolidatedMessagesText(messages),
        woztellPayload: woztellPayload
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
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: plan.user_facing_ack
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
      await sendWoztellTextMessage(this.env, {
        channelId: data.channel,
        recipientId: data.phone,
        text: fallbackText
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
        text: USER_MESSAGES.imageFailed
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
    url: fileInfo.url || "",
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

  const parts = ["[Audio transcrito]: " + transcript.trim()];

  if (parsedMessage.text && parsedMessage.text.trim()) {
    parts.push("[Texto adicional]: " + parsedMessage.text.trim());
  }

  const text = parts.join("\n");

  console.log("AUDIO_AS_TEXT_BUFFERED:", JSON.stringify({
    textPreview: text.slice(0, 500)
  }));

  return Object.assign({}, parsedMessage, {
    type: "TEXT",
    text: text,
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

  const model = env.AUDIO_TRANSCRIPTION_MODEL || "whisper-1";

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

async function callOrchestratorPlan(env, params) {
  const provider = String(env.ORCHESTRATOR_PROVIDER || "claude").toLowerCase();

  console.log("ORCHESTRATOR_PROVIDER_SELECTED:", JSON.stringify({
    provider: provider,
    model: env.ORCHESTRATOR_MODEL || "",
    doName: params.doName || ""
  }));

  if (provider === "openai") {
    return await openaiOrchestratorProvider(env, params);
  }

  return await claudeOrchestratorProvider(env, params);
}

async function claudeOrchestratorProvider(env, params) {
  return await callClaudeOrchestratorPlan(env, params);
}

async function openaiOrchestratorProvider(env, params) {
  console.log("ORCHESTRATOR_PROVIDER_OPENAI_STUB:", JSON.stringify({
    reason: "openai_provider_not_enabled_for_production_flow",
    doName: params.doName || ""
  }));

  return await callClaudeOrchestratorPlan(Object.assign({}, env, {
    ORCHESTRATOR_PROVIDER: "claude"
  }), params);
}

async function callClaudeOrchestratorPlan(env, params) {
  if (!env.ANTHROPIC_API_KEY) {
    throw new Error("Missing ANTHROPIC_API_KEY");
  }

  if (!env.CLAUDE_ORCHESTRATOR_AGENT_ID || !env.CLAUDE_ORCHESTRATOR_ENVIRONMENT_ID) {
    throw new Error("Missing Claude Orchestrator configuration");
  }

  const sessionId = await createClaudeOrchestratorSession(env);
  const userTurn = params.userTurn || buildUserTurn(params.messages || [], params.campaignState || {});
  const mediaBatch = userTurn.media_batch || buildMediaBatch(params.campaignState || {}, params.messages || []);
  const mediaBatchSummary = userTurn.media_batch_summary || buildMediaBatchSummary(mediaBatch);
  const compactInput = buildOrchestratorInput({
    messages: params.messages || [],
    campaignState: params.campaignState || {},
    userTurn: userTurn
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

  const payload = {
    instruction: "Return valid JSON only. Do not answer the user directly.",
    plan_schema: ORCHESTRATOR_PLAN_SCHEMA,
    available_actions: getAllowedOrchestratorActions(),
    orchestrator_input: compactInput,
    current_turn_summary: compactInput.current_turn_summary,
    current_turn_text: compactInput.current_turn_text,
    client_profile: params.clientProfile || {},
    campaign_state: compactInput.campaign_state_brief,
    relevant_previous_state: compactInput.relevant_previous_state,
    campaign_assets: mediaBatch.assets,
    media_batch_summary: mediaBatchSummary,
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
      "Claude is the orchestrator only. Claude must not analyze image pixels directly.",
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
      copy_model: env.COPY_MODEL || "gpt-5-nano",
      image_model: env.OPENAI_IMAGE_MODEL || "gpt-image-2"
    }
  };

  const text = await sendTextToClaudeSession(env, {
    sessionId: sessionId,
    text: JSON.stringify(payload)
  });

  console.log("ORCHESTRATOR_RAW_TEXT:", String(text || "").slice(0, 3000));

  const plan = normalizePlan(parseJsonFromText(text));

  console.log("ORCHESTRATOR_ACTIONS_SELECTED:", JSON.stringify({
    doName: params.doName || "",
    actions: mapOrchestratorActions(plan).map(function (action) { return action.type; })
  }));

  return plan;
}

const ORCHESTRATOR_PLAN_SCHEMA = {
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
    Object.prototype.hasOwnProperty.call(value, "final_response_mode") &&
    Object.prototype.hasOwnProperty.call(value, "state_updates");
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.actions) || !plan.final_response_mode) {
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

  const actions = Array.isArray(plan.actions)
    ? plan.actions.filter(function (action) {
      return action && allowedActions.includes(action.type);
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
    needs_clarification: Boolean(plan.needs_clarification),
    clarification_question: String(plan.clarification_question || ""),
    user_facing_ack: String(plan.user_facing_ack || ""),
    actions: actions,
    final_response_mode: String(plan.final_response_mode || "send_copy_only"),
    state_updates: typeof plan.state_updates === "object" && plan.state_updates ? plan.state_updates : {}
  };
}

async function generateCopyWithOpenAI(env, params) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const model = env.COPY_MODEL || "gpt-5-nano";
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
        effort: "minimal"
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
    imageUrl: imageUrl,
    captionPreview: String(params.caption || "").slice(0, 500)
  }));

  const primaryModel = env.VISION_MODEL || "gpt-4o-mini";
  const fallbackModel = env.VISION_FALLBACK_MODEL || "gpt-5-mini";

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

  console.log("VISION_RAW_OUTPUT:", String(output || "").slice(0, 3000));

  if (!output) {
    throw new Error("VISION_ANALYSIS_EMPTY_OUTPUT: " + responseText);
  }

  const parsed = parseVisionAnalysisJson(output);

  console.log("VISION_PARSED_JSON:", JSON.stringify(parsed));

  console.log("IMAGE_ANALYSIS_RESULT:", JSON.stringify({
    model: params.model,
    confidence: parsed.confidence,
    main_subject: parsed.main_subject,
    product_type: parsed.product_type
  }));

  return parsed;
}

function buildVisionRequestBody(params) {
  const promptText = [
    "Analiza esta imagen para un agente de marketing digital.",
    "Devuelve solo JSON estructurado.",
    "Identifica producto, texto visible, colores, estilo, objetos y recomendaciones comerciales.",
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
    imageUrlPreview: requestBody.input[0].content[1].image_url.slice(0, 300),
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
            image_url: requestBody.input[0].content[1].image_url
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

  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2";
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
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2";

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
      url: fileInfo.url || "",
      fileType: fileInfo.fileType || "",
      size: fileInfo.size || 0
    }));

    const audio = await downloadAudioWithRetries(fileInfo.url, {
      fileType: fileInfo.fileType || parsedMessage.mimeType || "",
      size: fileInfo.size || 0
    }, 3);

    const transcript = await transcribeAudioBytesWithRetries(env, audio.bytes, {
      contentType: audio.contentType,
      fileName: parsedMessage.fileName || "audio.ogg",
      size: fileInfo.size || audio.bytes.byteLength || 0
    }, 2);

    if (!transcript || transcript.trim().length < 2) {
      throw new Error("AUDIO_TRANSCRIPTION_EMPTY");
    }

    const parts = ["[Audio transcrito]: " + transcript.trim()];

    if (parsedMessage.text && parsedMessage.text.trim()) {
      parts.push("[Texto adicional]: " + parsedMessage.text.trim());
    }

    const text = parts.join("\n");

    console.log("AUDIO_AS_TEXT_BUFFERED:", JSON.stringify({
      doName: job.doName || "",
      messageId: job.messageId || "",
      textPreview: text.slice(0, 500)
    }));

    await notifyConversationDO(env, job.doName || buildConversationName(woztellPayload), {
      type: "audio_transcribed",
      messageId: job.messageId || parsedMessage.messageId || woztellPayload.messageId || "",
      transcript: transcript,
      transcribedAt: new Date().toISOString()
    });

    console.log("AUDIO_PIPELINE_DONE:", JSON.stringify({
      doName: job.doName || "",
      messageId: job.messageId || "",
      transcriptLength: transcript.length
    }));
    console.log("AUDIO_BATCH_TRANSCRIPTION_DONE:", JSON.stringify({
      doName: job.doName || "",
      messageId: job.messageId || "",
      audioCount: 1,
      transcribedCount: 1,
      failedCount: 0
    }));
  } catch (error) {
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

      return {
        bytes: bytes,
        contentType: contentType
      };
    } catch (error) {
      lastError = error;

      if (String(error.message || error).includes("AUDIO_DOWNLOAD_TIMEOUT")) {
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
  throw lastError || new Error("AUDIO_TRANSCRIPTION_FAILED");
}

async function transcribeAudioBytesOnce(env, bytes, metadata, attempt) {
  if (!env.OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const contentType = metadata && metadata.contentType || metadata && metadata.fileType || "audio/ogg";
  const model = env.AUDIO_TRANSCRIPTION_MODEL || "whisper-1";

  console.log("AUDIO_TRANSCRIPTION_START:", JSON.stringify({
    attempt: attempt || 1,
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
    attempt: attempt || 1,
    textPreview: transcript.slice(0, 500),
    length: transcript.length
  }));
  console.log("AUDIO_TRANSCRIPTION_OK:", JSON.stringify({
    attempt: attempt || 1,
    length: transcript.length
  }));

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

async function sendWoztellTextMessage(env, params) {
  const cleanText = fixMojibake(params.text);

  console.log("WOZTELL_TEXT_SEND_PREVIEW:", JSON.stringify({
    channelId: params.channelId || "",
    recipientId: params.recipientId || "",
    textPreview: cleanText.slice(0, 1000)
  }));

  return await sendWoztellResponse(env, {
    channelId: params.channelId,
    recipientId: params.recipientId,
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
    .replaceAll("\u00c3\u00a2\u00c5\u201c\u00e2\u20ac\u00a6", "✅")
    .replaceAll("\u00c3\u00a2\u00c5\u201c\u00e2\u20ac\u009d", "✔")
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
  if (!env.WOZTELL_ACCESS_TOKEN) {
    throw new Error("Missing WOZTELL_ACCESS_TOKEN");
  }

  const url = "https://bot.api.woztell.com/sendResponses?accessToken=" + encodeURIComponent(env.WOZTELL_ACCESS_TOKEN);
  const payload = {
    channelId: params.channelId,
    recipientId: params.recipientId,
    response: params.response
  };

  if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
    console.log("WOZTELL_IMAGE_SEND_PAYLOAD:", JSON.stringify(payload));
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
    if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
      console.error("WOZTELL_IMAGE_SEND_ERROR:", JSON.stringify({
        message: String(error.message || error),
        stack: String(error.stack || "")
      }));
    }

    throw error;
  }

  const responseText = await res.text();

  if (!res.ok) {
    if (params.logPrefix === "WOZTELL_IMAGE_SEND") {
      console.error("WOZTELL_IMAGE_SEND_ERROR:", JSON.stringify({
        status: res.status,
        body: responseText.slice(0, 2000)
      }));
    }

    throw new Error("WOZTELL_SEND_ERROR " + res.status + ": " + responseText);
  }

  const parsed = parseMaybeJson(responseText);

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

  return parsed;
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
    pendingMessages: Array.isArray(clean.pendingMessages) ? clean.pendingMessages : [],
    currentTurnId: String(clean.currentTurnId || ""),
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
    archivedCampaigns: Array.isArray(clean.archivedCampaigns) ? clean.archivedCampaigns.slice(-5) : []
  };
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

function getLastCopyFromState(state) {
  return String(state && (state.last_copy || state.lastCopy) || "");
}

function getLastImageUrlFromState(state) {
  return String(state && (state.last_image_url || state.lastImageUrl) || "");
}

function getLastUploadedImage(state) {
  return state && (state.last_uploaded_image || state.lastUploadedImage) || {};
}

function normalizeIncomingMessage(parsedMessage, woztellPayload, options) {
  const parsed = parsedMessage || {};
  const payload = woztellPayload || {};
  const type = String(parsed.type || "TEXT").toUpperCase();
  const fileId = String(parsed.fileId || "");
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

  const fallbackText = fileId && !isAudioMessage(parsed)
    ? "[" + type + " uploaded without caption]"
    : isAudioMessage(parsed) ? "[AUDIO pending transcription]" : "";

  return {
    messageId: String(options && options.messageId || parsed.messageId || payload.messageId || randomId(12)),
    type: type,
    text: String(parsed.text || fallbackText).trim(),
    fileId: fileId,
    media: media,
    audio: audio,
    video: video,
    files: files,
    captions: collectCaptions(parsed, payload),
    mimeType: String(parsed.mimeType || ""),
    fileName: String(parsed.fileName || ""),
    originalType: parsed.originalType || "",
    originalFileId: parsed.originalFileId || "",
    audioStatus: parsed.audioStatus || (audio.length ? "pending" : ""),
    audioTranscript: parsed.audioTranscript || "",
    awaitingTranscription: Boolean(audio.length && !parsed.audioTranscript && parsed.audioStatus !== "failed"),
    app: String(payload.app || ""),
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
      fileName: parsed.fileName || ""
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

function shouldStartNewTurn(messages, previousState) {
  const text = normalizeTextForIntent(consolidatedMessagesText(messages || []));

  if (!text) return false;
  if (text === "/reset") return true;
  if (isNewCampaignRequest(text)) return true;

  const hasNewMedia = (messages || []).some(function (message) {
    return (message.media && message.media.length) || (message.video && message.video.length) || (message.files && message.files.length);
  });

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
    "tercera imagen"
  ].some(function (pattern) {
    return text.includes(normalizeTextForIntent(pattern));
  });
}

function buildUserTurn(messages, campaignState, options) {
  const state = normalizeCampaignState(campaignState || {});
  const turnId = options && options.turnId || "turn_" + Date.now() + "_" + randomId(6);
  const mediaBatch = buildMediaBatch(state, messages || [], { turnId: turnId });
  const audioBatch = buildAudioBatch(messages || []);
  const captions = (messages || []).flatMap(function (message) {
    return message.captions || [];
  }).filter(Boolean);
  const videos = (messages || []).flatMap(function (message) { return message.video || []; });
  const files = (messages || []).flatMap(function (message) { return message.files || []; });
  const textMessages = (messages || []).filter(function (message) {
    return String(message.text || "").trim() && !String(message.text || "").startsWith("[IMAGE uploaded");
  });
  const contextPolicy = shouldUsePreviousContext(messages)
    ? "use_previous_context"
    : shouldStartNewTurn(messages, state) ? "new_request_from_current_turn" : "current_turn_only";

  return {
    turn_id: turnId,
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
    video_metadata: videos,
    file_metadata: files,
    context_policy: contextPolicy,
    created_at: new Date().toISOString()
  };
}

function buildTurnSummary(userTurn) {
  const turn = userTurn || {};

  return {
    turn_id: turn.turn_id || "",
    input_types: turn.input_types || [],
    text_count: turn.text_count || 0,
    audio_count: turn.audio_count || 0,
    image_count: turn.image_count || 0,
    video_count: turn.video_count || 0,
    file_count: turn.file_count || 0,
    captions: turn.captions || [],
    context_policy: turn.context_policy || "current_turn_only",
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

  if (userTurn && userTurn.context_policy !== "use_previous_context") {
    return {
      workflow_status: state.workflow_status,
      expected_next_target: state.expected_next_target,
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

  return {
    current_turn_summary: buildTurnSummary(userTurn),
    current_turn_text: userTurn.current_turn_text || "",
    media_batch_summary: userTurn.media_batch_summary || null,
    audio_transcripts: userTurn.audio_transcripts || [],
    video_metadata: userTurn.video_metadata || [],
    file_metadata: userTurn.file_metadata || [],
    relevant_previous_state: buildRelevantPreviousState(state, userTurn),
    allowed_actions: getAllowedOrchestratorActions(),
    campaign_state_brief: {
      campaign_id: state.campaign_id,
      campaign_type: state.campaign_type,
      workflow_status: state.workflow_status,
      expected_next_target: state.expected_next_target,
      current_asset_source: state.current_asset_source || ""
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
  const state = normalizeCampaignState(campaignState || {});
  const turnId = options && options.turnId || "";
  const messageFileIds = new Set((messages || []).flatMap(function (message) {
    const ids = [];
    if (message.fileId) ids.push(String(message.fileId));
    for (const item of message.media || []) {
      if (item.fileId) ids.push(String(item.fileId));
    }
    return ids;
  }));
  let assets = normalizeCampaignAssets(state.campaign_assets);

  if (messageFileIds.size) {
    assets = assets.filter(function (asset) {
      return messageFileIds.has(asset.file_id);
    });
  }

  if (turnId) {
    const turnAssets = assets.filter(function (asset) {
      return asset.turn_id === turnId || asset.request_id === turnId;
    });
    if (turnAssets.length) assets = turnAssets;
  }

  if (!assets.length && state.last_uploaded_image) {
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

  const fileIds = assets.map(function (asset) { return asset.file_id; }).filter(Boolean);
  const analyzedAssetCount = assets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; }).length;
  const failedAssetCount = assets.filter(function (asset) { return asset.status === "analysis_failed"; }).length;

  return {
    assets: assets,
    fileIds: fileIds,
    assetCount: assets.length,
    analyzedAssetCount: analyzedAssetCount,
    failedAssetCount: failedAssetCount
  };
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
  const data = body.data || {};
  const type = body.type || data.type || "TEXT";
  const text = data.text || body.text || data.caption || body.caption || "";
  const fileId = data.fileId ||
    body.fileId ||
    data.mediaId ||
    body.mediaId ||
    data.file && data.file.fileId ||
    body.file && body.file.fileId ||
    data.attachment && data.attachment.fileId ||
    body.attachment && body.attachment.fileId ||
    data.audio && data.audio.fileId ||
    body.audio && body.audio.fileId ||
    data.voice && data.voice.fileId ||
    body.voice && body.voice.fileId ||
    "";

  return {
    type: type,
    text: String(text || "").trim(),
    fileId: String(fileId || ""),
    fileName: data.fileName || body.fileName || data.file && data.file.fileName || body.file && body.file.fileName || "",
    mimeType: data.mimeType || body.mimeType || data.file && data.file.mimeType || body.file && body.file.mimeType || data.audio && data.audio.mimeType || body.audio && body.audio.mimeType || "",
    messageId: body.messageId || data.messageId || ""
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
    app: first.app || "",
    messageId: messages.map(function (msg) { return msg.messageId; }).join(",")
  };
}

function consolidatedMessagesText(messages) {
  return (messages || []).map(function (msg, index) {
    const label = "[" + (index + 1) + "] " + (msg.type || "TEXT");
    const media = msg.fileId ? " fileId=" + msg.fileId : "";
    return label + media + ": " + (msg.text || "");
  }).join("\n");
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

function getNumberEnv(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function getBufferTimingConfig(env) {
  return {
    bufferWaitSeconds: getNumberEnv(env && env.BUFFER_WAIT_SECONDS, 5),
    imageMessageWaitSeconds: getNumberEnv(env && env.IMAGE_MESSAGE_WAIT_SECONDS, 8),
    bufferMaxWaitSeconds: getNumberEnv(env && env.BUFFER_MAX_WAIT_SECONDS, 15)
  };
}

function getAudioTurnWaitConfig(env) {
  return {
    maxAudioTurnWaitMs: getNumberEnv(env && env.AUDIO_TURN_WAIT_SECONDS, 75) * 1000,
    retryWaitMs: getNumberEnv(env && env.AUDIO_TURN_RETRY_SECONDS, 3) * 1000
  };
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
  compactConversationHistory,
  mapOrchestratorActions,
  analyzeMediaBatch,
  buildMediaBatchSummary,
  consolidatedMessagesText
};












