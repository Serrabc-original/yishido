import { logEvent } from "../logger.js";

export function buildMediaBatchFromUserTurn(params) {
  const clean = params || {};
  const userTurn = clean.userTurn || {};
  const activeTaskAssets = Array.isArray(clean.activeTaskAssets) ? clean.activeTaskAssets : [];
  const currentAssets = []
    .concat((userTurn.images || []).map(toAsset))
    .concat((userTurn.videos || []).map(function (item) { return toAsset(item, "VIDEO"); }))
    .concat((userTurn.files || []).map(function (item) { return toAsset(item, "FILE"); }))
    .filter(function (asset) { return asset.file_id; });

  let selected = currentAssets;
  if (selected.length) {
    logEvent("MEDIA_BATCH_SELECTED_FROM_USER_TURN", {
      traceId: userTurn.trace_id || "",
      turnId: userTurn.turn_id || "",
      fileIds: selected.map(function (asset) { return asset.file_id; })
    });
  }

  if (activeTaskAssets.length) {
    logEvent("MEDIA_BATCH_SELECTED_FROM_ACTIVE_TASK", {
      traceId: userTurn.trace_id || "",
      turnId: userTurn.turn_id || "",
      fileIds: activeTaskAssets.map(function (asset) { return asset.file_id || asset.fileId || ""; }).filter(Boolean)
    });
    selected = selected.concat(activeTaskAssets.map(normalizeAsset));
  }

  const deduped = dedupeAssets(selected);
  if (deduped.length !== selected.length) {
    logEvent("MEDIA_BATCH_DEDUPED", {
      traceId: userTurn.trace_id || "",
      turnId: userTurn.turn_id || "",
      before: selected.length,
      after: deduped.length
    });
  }

  const result = summarizeBatch(deduped);
  logEvent("MEDIA_BATCH_FILE_IDS_FINAL", {
    traceId: userTurn.trace_id || "",
    turnId: userTurn.turn_id || "",
    fileIds: result.fileIds
  });
  logEvent("MEDIA_BATCH_COUNTS_FINAL", {
    traceId: userTurn.trace_id || "",
    turnId: userTurn.turn_id || "",
    assetCount: result.assetCount,
    imageCount: result.assets.filter(function (asset) { return asset.media_type === "IMAGE"; }).length,
    videoCount: result.assets.filter(function (asset) { return asset.media_type === "VIDEO"; }).length,
    fileCount: result.assets.filter(function (asset) { return asset.media_type === "FILE"; }).length
  });

  return result;
}

export function mergeMediaBatchAssets(userTurnBatch, activeTaskAssets) {
  return summarizeBatch(dedupeAssets((userTurnBatch && userTurnBatch.assets || []).concat(activeTaskAssets || [])));
}

function toAsset(item, defaultType) {
  const clean = item || {};
  const asset = clean.asset || {};
  return normalizeAsset(Object.assign({}, asset, {
    file_id: asset.file_id || clean.fileId || "",
    url: asset.url || clean.url || "",
    media_type: asset.media_type || defaultType || "IMAGE",
    mime_type: asset.mime_type || clean.mimeType || "",
    message_id: asset.message_id || clean.messageId || "",
    caption: asset.caption || clean.caption || ""
  }));
}

function normalizeAsset(asset) {
  const clean = asset || {};
  return {
    asset_id: String(clean.asset_id || clean.assetId || clean.file_id || clean.fileId || ""),
    file_id: String(clean.file_id || clean.fileId || ""),
    url: String(clean.url || ""),
    media_type: String(clean.media_type || clean.mediaType || "IMAGE").toUpperCase(),
    mime_type: String(clean.mime_type || clean.mimeType || ""),
    message_id: String(clean.message_id || clean.messageId || ""),
    caption: String(clean.caption || ""),
    analysis: clean.analysis || null,
    status: String(clean.status || "received"),
    received_at: clean.received_at || clean.receivedAt || ""
  };
}

function dedupeAssets(assets) {
  const seen = new Set();
  return (assets || []).filter(function (asset) {
    const id = String(asset.file_id || asset.message_id || "");
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function summarizeBatch(assets) {
  const cleanAssets = (assets || []).map(normalizeAsset);
  const fileIds = cleanAssets.map(function (asset) { return asset.file_id; }).filter(Boolean);
  return {
    assets: cleanAssets,
    fileIds: fileIds,
    assetCount: cleanAssets.length,
    analyzedAssetCount: cleanAssets.filter(function (asset) { return asset.status === "analyzed" && asset.analysis; }).length,
    failedAssetCount: cleanAssets.filter(function (asset) { return asset.status === "analysis_failed"; }).length
  };
}

