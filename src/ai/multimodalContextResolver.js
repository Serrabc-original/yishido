export function resolveIntentRouterV2MultimodalContext(input) {
  const clean = input || {};
  const userTurn = Object.assign({}, clean.userTurn || {});
  const conversationState = Object.assign({}, clean.conversationState || {});
  const mediaBatch = userTurn.media_batch && typeof userTurn.media_batch === "object"
    ? userTurn.media_batch
    : { assets: [], fileIds: [] };

  const currentAssets = normalizeAssets(mediaBatch.assets || []);
  const stateAssets = normalizeAssets(conversationState.campaign_assets || []);
  const mergedAssets = mergeAssets(stateAssets, currentAssets);

  userTurn.media_batch = Object.assign({}, mediaBatch, {
    assets: currentAssets,
    fileIds: Array.isArray(mediaBatch.fileIds) ? mediaBatch.fileIds : Array.isArray(mediaBatch.file_ids) ? mediaBatch.file_ids : []
  });
  conversationState.campaign_assets = mergedAssets;

  if (!conversationState.last_uploaded_image) {
    const lastUploaded = findLastAsset(mergedAssets, "IMAGE", "received");
    if (lastUploaded) {
      conversationState.last_uploaded_image = {
        asset_id: lastUploaded.asset_id,
        file_id: lastUploaded.file_id
      };
    }
  }

  if (!conversationState.last_generated_image) {
    const lastGenerated = findLastAsset(mergedAssets, "IMAGE", "generated");
    if (lastGenerated) {
      conversationState.last_generated_image = {
        asset_id: lastGenerated.asset_id,
        file_id: lastGenerated.file_id
      };
    }
  }

  return {
    userTurn: userTurn,
    conversationState: conversationState
  };
}

function normalizeAssets(assets) {
  return (Array.isArray(assets) ? assets : []).map(function (asset, index) {
    const clean = asset || {};
    return {
      asset_id: String(clean.asset_id || clean.assetId || "asset_" + (index + 1)),
      file_id: String(clean.file_id || clean.fileId || ""),
      media_type: String(clean.media_type || clean.mediaType || "IMAGE").toUpperCase(),
      status: String(clean.status || "received"),
      turn_id: String(clean.turn_id || clean.turnId || "")
    };
  });
}

function mergeAssets(previous, current) {
  const byKey = new Map();
  for (const asset of previous.concat(current)) {
    const key = asset.asset_id || asset.file_id;
    if (!key) continue;
    byKey.set(key, asset);
  }
  return Array.from(byKey.values());
}

function findLastAsset(assets, mediaType, status) {
  const cleanStatus = String(status || "").toLowerCase();
  for (let index = assets.length - 1; index >= 0; index -= 1) {
    const asset = assets[index];
    if (asset.media_type !== mediaType) continue;
    if (cleanStatus && String(asset.status || "").toLowerCase() !== cleanStatus) continue;
    return asset;
  }
  return null;
}
