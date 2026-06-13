import { readFile } from "node:fs/promises";
import {
  extractWoztellMessage,
  normalizeIncomingMessage,
  addCampaignAsset,
  buildMediaBatch,
  buildMediaBatchSummary,
  buildUserTurn,
  buildOrchestratorInput,
  consolidatedMessagesText
} from "../src/index.js";

const fixturePath = process.argv[2];

if (!fixturePath) {
  console.error("Usage: node scripts/simulate-media-intake.js test/fixtures/woztell-text-plus-images.json");
  process.exit(1);
}

const raw = JSON.parse(await readFile(fixturePath, "utf8"));
const payloads = Array.isArray(raw) ? raw : [raw];
const campaignState = {
  campaign_id: "camp_simulation",
  campaign_type: "single_post",
  workflow_status: "idle",
  campaign_assets: []
};
const messages = [];

for (const payload of payloads) {
  const parsed = extractWoztellMessage(payload);
  const normalized = normalizeIncomingMessage(parsed, payload, {
    messageId: parsed.messageId || payload.messageId,
    receivedAt: "2026-06-12T00:00:00.000Z"
  });

  messages.push(normalized);

  for (const media of normalized.media) {
    campaignState.campaign_assets = addCampaignAsset(campaignState.campaign_assets, {
      file_id: media.fileId,
      url: media.fileId.includes("invalid") ? "" : "https://example.test/" + media.fileId + ".jpg",
      media_type: media.type,
      mime_type: media.mimeType,
      received_at: normalized.receivedAt,
      status: media.fileId.includes("invalid") ? "url_pending" : "received"
    });
  }
}

if (campaignState.campaign_assets.length > 1) {
  campaignState.campaign_type = "bulk_from_assets";
  campaignState.workflow_status = "collecting_assets";
}

const batch = buildMediaBatch(campaignState, messages);
const summary = buildMediaBatchSummary(batch);
const userTurn = buildUserTurn(messages, campaignState, { turnId: "turn_simulation" });
const orchestratorInput = buildOrchestratorInput({ messages, campaignState, userTurn });

console.log(JSON.stringify({
  messageCount: messages.length,
  consolidatedMessages: consolidatedMessagesText(messages),
  assetCount: batch.assets.length,
  fileIds: batch.fileIds,
  campaignType: campaignState.campaign_type,
  workflowStatus: campaignState.workflow_status,
  mediaBatchSummary: summary,
  userTurnSummary: userTurn,
  orchestratorInput: orchestratorInput
}, null, 2));
