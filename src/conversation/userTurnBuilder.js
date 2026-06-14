import { logEvent } from "../logger.js";

export function cleanUserVisibleText(text) {
  return String(text || "")
    .replace(/^\s*\[\d+\]\s+[A-Z_]+(?:\s+fileId=[^\s:]+)?:\s*/i, "")
    .replace(/^\s*\[Audio transcrito\]:\s*/i, "")
    .replace(/^\s*\[Texto adicional\]:\s*/i, "")
    .replace(/\[AUDIO pending transcription\]/gi, "")
    .replace(/\[AUDIO no transcrito\]/gi, "")
    .replace(/\[(IMAGE|VIDEO|FILE) uploaded without caption\]/gi, "")
    .trim();
}

export function buildCombinedUserText(messages) {
  const parts = [];

  for (const message of messages || []) {
    const type = String(message && message.type || "").toUpperCase();
    if (type === "UNSUPPORTED") continue;
    if (type === "AUDIO" || message && message.audioTranscript) {
      const transcript = cleanUserVisibleText(message.audioTranscript || extractTranscriptFromText(message.text || ""));
      if (transcript) parts.push(transcript);
      const extraText = cleanUserVisibleText(removeTranscriptFromText(message.text || ""));
      if (extraText && extraText !== transcript) parts.push(extraText);
      continue;
    }
    const text = cleanUserVisibleText(message && message.text || "");
    if (text) parts.push(text);
  }

  return parts.join("\n").trim();
}

export function collectUserTurnParts(messages, mediaBatch) {
  const batch = mediaBatch || { assets: [] };
  const assetsByFileId = new Map((batch.assets || []).map(function (asset) {
    return [String(asset.file_id || ""), asset];
  }));
  const texts = [];
  const audioTranscripts = [];
  const images = [];
  const videos = [];
  const files = [];
  const locations = [];
  const captions = [];

  for (const message of messages || []) {
    const type = String(message.type || "").toUpperCase();
    const cleanText = cleanUserVisibleText(message.text || "");

    if (type === "TEXT" && cleanText) texts.push(cleanText);
    if ((type === "AUDIO" || message.audioTranscript) && (message.audioTranscript || cleanText)) {
      const transcript = cleanUserVisibleText(message.audioTranscript || extractTranscriptFromText(message.text || "") || cleanText);
      if (transcript) audioTranscripts.push(transcript);
    }

    for (const caption of message.captions || []) {
      const cleanCaption = cleanUserVisibleText(caption);
      if (cleanCaption) captions.push({
        messageId: message.messageId || "",
        fileId: message.fileId || "",
        text: cleanCaption
      });
    }

    for (const media of message.media || []) {
      const mediaType = String(media.type || type || "FILE").toUpperCase();
      const asset = assetsByFileId.get(String(media.fileId || "")) || {};
      const item = {
        messageId: message.messageId || "",
        fileId: String(media.fileId || ""),
        caption: cleanUserVisibleText(media.caption || message.text || ""),
        mimeType: media.mimeType || asset.mime_type || "",
        fileName: media.fileName || asset.file_name || "",
        url: asset.url || "",
        asset: asset
      };
      if (item.caption) captions.push({ messageId: item.messageId, fileId: item.fileId, text: item.caption });
      if (mediaType === "IMAGE") images.push(item);
      else if (mediaType === "VIDEO") videos.push(item);
      else files.push(item);
    }

    for (const video of message.video || []) {
      videos.push(Object.assign({ messageId: message.messageId || "" }, video));
    }
    for (const file of message.files || []) {
      files.push(Object.assign({ messageId: message.messageId || "" }, file));
    }
    if (type === "LOCATION") {
      locations.push({
        messageId: message.messageId || "",
        text: cleanText,
        data: message.location || message.data || null
      });
    }
  }

  const seenImageIds = new Set(images.map(function (item) { return item.fileId; }));
  const seenVideoIds = new Set(videos.map(function (item) { return item.fileId; }));
  const seenFileIds = new Set(files.map(function (item) { return item.fileId; }));
  for (const asset of batch.assets || []) {
    const item = {
      messageId: asset.message_id || "",
      fileId: String(asset.file_id || ""),
      caption: cleanUserVisibleText(asset.caption || ""),
      mimeType: asset.mime_type || "",
      fileName: asset.file_name || "",
      url: asset.url || "",
      asset: asset
    };
    if (!item.fileId) continue;
    if (asset.media_type === "IMAGE" && !seenImageIds.has(item.fileId)) images.push(item);
    if (asset.media_type === "VIDEO" && !seenVideoIds.has(item.fileId)) videos.push(item);
    if (asset.media_type === "FILE" && !seenFileIds.has(item.fileId)) files.push(item);
  }

  return {
    texts: dedupeStrings(texts),
    audioTranscripts: dedupeStrings(audioTranscripts),
    images: dedupeByKey(images, "fileId"),
    videos: dedupeByKey(videos, "fileId"),
    files: dedupeByKey(files, "fileId"),
    locations: locations,
    captions: dedupeCaptions(captions)
  };
}

export function attachUserTurnContract(userTurn, messages, mediaBatch) {
  const turn = userTurn || {};
  const parts = collectUserTurnParts(messages || turn.messages || [], mediaBatch || turn.media_batch || {});
  const combinedUserText = buildCombinedUserText(messages || turn.messages || []);
  const counts = {
    text: parts.texts.length,
    audio: turn.audio_batch && Number(turn.audio_batch.count || 0) || parts.audioTranscripts.length,
    image: parts.images.length || Number(turn.image_count || 0),
    video: parts.videos.length || Number(turn.video_count || 0),
    file: parts.files.length || Number(turn.file_count || 0),
    location: parts.locations.length
  };

  turn.texts = parts.texts;
  turn.audioTranscripts = parts.audioTranscripts;
  turn.audio_transcripts = parts.audioTranscripts;
  turn.images = parts.images;
  turn.videos = parts.videos;
  turn.files = parts.files;
  turn.locations = parts.locations;
  turn.captions = parts.captions.map(function (caption) { return caption.text; });
  turn.caption_links = parts.captions;
  turn.combinedUserText = combinedUserText;
  turn.current_turn_text = combinedUserText;
  turn.inputTypes = Array.isArray(turn.input_types) ? turn.input_types : [];
  turn.counts = counts;
  turn.text_count = counts.text + counts.audio;
  turn.audio_count = counts.audio;
  turn.image_count = counts.image;
  turn.video_count = counts.video;
  turn.file_count = counts.file;

  logEvent("USER_TURN_BUILT", {
    traceId: turn.trace_id || "",
    turnId: turn.turn_id || "",
    inputTypes: turn.inputTypes
  });
  logEvent("USER_TURN_COUNTS", {
    traceId: turn.trace_id || "",
    turnId: turn.turn_id || "",
    counts: counts
  });
  logEvent("USER_TURN_TEXT_COMBINED", {
    traceId: turn.trace_id || "",
    turnId: turn.turn_id || "",
    textLength: combinedUserText.length
  });
  logEvent("USER_TURN_MEDIA_CONSOLIDATED", {
    traceId: turn.trace_id || "",
    turnId: turn.turn_id || "",
    imageCount: counts.image,
    videoCount: counts.video,
    fileCount: counts.file
  });
  logEvent("USER_TURN_CAPTIONS_ASSOCIATED", {
    traceId: turn.trace_id || "",
    turnId: turn.turn_id || "",
    captionCount: parts.captions.length
  });

  return turn;
}

function extractTranscriptFromText(text) {
  const match = String(text || "").match(/\[Audio transcrito\]:\s*([^\n]+)/i);
  return match ? match[1].trim() : "";
}

function removeTranscriptFromText(text) {
  return String(text || "")
    .replace(/\[Audio transcrito\]:\s*[^\n]+/i, "")
    .replace(/\[Texto adicional\]:\s*/i, "")
    .trim();
}

function dedupeStrings(values) {
  return Array.from(new Set((values || []).map(function (value) { return String(value || "").trim(); }).filter(Boolean)));
}

function dedupeByKey(items, key) {
  const seen = new Set();
  return (items || []).filter(function (item) {
    const id = String(item && item[key] || "");
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function dedupeCaptions(items) {
  const seen = new Set();
  return (items || []).filter(function (item) {
    const id = [item.messageId || "", item.fileId || "", item.text || ""].join("|");
    if (seen.has(id)) return false;
    seen.add(id);
    return Boolean(item.text);
  });
}
