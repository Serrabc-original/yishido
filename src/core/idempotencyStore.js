export const DEFAULT_PROCESSED_MESSAGE_ID_LIMIT = 80;

export function buildSeenMessageIds(data) {
  const state = data || {};
  const seen = new Set();

  for (const id of normalizeMessageIds(state.processedMessageIds || [])) {
    seen.add(id);
  }

  for (const id of normalizeMessageIds(state.pendingMessages || [])) {
    seen.add(id);
  }

  return seen;
}

export function isDuplicateMessage(data, messageId) {
  const id = String(messageId || "").trim();
  return Boolean(id && buildSeenMessageIds(data).has(id));
}

export function appendProcessedMessageIds(existingIds, messagesOrIds, options) {
  const limit = Number(options && options.limit || DEFAULT_PROCESSED_MESSAGE_ID_LIMIT);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_PROCESSED_MESSAGE_ID_LIMIT;
  const output = [];

  for (const id of normalizeMessageIds(existingIds || [])) {
    pushRecentUnique(output, id);
  }

  for (const id of normalizeMessageIds(messagesOrIds || [])) {
    pushRecentUnique(output, id);
  }

  return output.slice(-safeLimit);
}

export function markMessagesProcessed(data, messagesOrIds, options) {
  const state = data || {};
  state.processedMessageIds = appendProcessedMessageIds(
    state.processedMessageIds || [],
    messagesOrIds || [],
    options || {}
  );
  return state;
}

function normalizeMessageIds(value) {
  const items = Array.isArray(value) ? value : [value];
  return items
    .map(function (item) {
      if (typeof item === "string" || typeof item === "number") return String(item);
      return String(item && (item.messageId || item.message_id || item.id) || "");
    })
    .map(function (id) { return id.trim(); })
    .filter(Boolean);
}

function pushRecentUnique(output, id) {
  const existingIndex = output.indexOf(id);
  if (existingIndex >= 0) output.splice(existingIndex, 1);
  output.push(id);
}
