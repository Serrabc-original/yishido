import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMemoryIdentity,
  buildMemoryReadModel,
  buildShortTermMemorySnapshot,
  updateShortTermMemory
} from "../src/memory/shortTermMemory.js";
import {
  buildMemoryPolicy,
  grantLongTermMemoryConsent,
  revokeLongTermMemoryConsent,
  shouldWriteLongTermMemory
} from "../src/memory/memoryPolicy.js";
import {
  buildLongTermMemoryCandidate,
  buildLongTermMemoryKey,
  createKvLongTermMemoryAdapter,
  createNoopLongTermMemoryAdapter,
  readLongTermMemory,
  writeLongTermMemory
} from "../src/memory/longTermMemoryAdapter.js";

test("short-term memory snapshot keeps compact conversation-scoped state", () => {
  const data = {
    conversationLog: Array.from({ length: 25 }, (_, index) => ({ turnId: "turn_" + index })),
    conversationSummary: { turn_count: 25 },
    userStyleProfile: { tone: "brief" },
    customerMemory: { name: "Mateo" },
    utilityMemory: { reminder_count: 1 }
  };
  const snapshot = buildShortTermMemorySnapshot(data, { limit: 20, retentionMode: "summarized" });

  assert.equal(snapshot.scope, "conversation");
  assert.equal(snapshot.retentionMode, "summarized");
  assert.equal(snapshot.conversationLog.length, 20);
  assert.equal(snapshot.conversationLog[0].turnId, "turn_5");
  assert.equal(snapshot.customerMemory.name, "Mateo");
});

test("updateShortTermMemory delegates existing compact memory behavior", () => {
  const data = updateShortTermMemory({}, {
    turn_id: "turn_memory",
    created_at: "2026-06-15T05:40:00.000Z",
    input_types: ["TEXT"],
    current_turn_text: "me llamo Mateo",
    text_count: 1,
    media_batch: { fileIds: [], assetCount: 0, failedAssetCount: 0 }
  }, {
    flags: {
      saveConversationLogs: true,
      enableUserStyleProfile: false,
      enableCustomerMemory: true
    }
  });

  assert.equal(data.conversationLog.length, 1);
  assert.equal(data.customerMemory.name, "Mateo");
});

test("memory read model separates identity, short-term and optional long-term memory", () => {
  const data = grantLongTermMemoryConsent({
    doName: "channel:user",
    channel: "channel",
    phone: "593",
    member: "member",
    conversationLog: [{ turnId: "turn_1" }],
    customerMemory: { name: "Mateo" }
  }, { now: "2026-06-16T12:00:00.000Z" });
  const policy = buildMemoryPolicy({ ENABLE_LONG_TERM_MEMORY: "true" }, data);
  const model = buildMemoryReadModel(data, {
    memoryPolicy: policy,
    longTermMemory: { profile: { name: "Mateo largo" } }
  });

  assert.equal(model.identity.userId, "593");
  assert.equal(model.shortTerm.conversationLog.length, 1);
  assert.equal(model.longTerm.profile.name, "Mateo largo");
  assert.equal(model.policy.longTerm.writeAllowed, true);
});

test("long-term memory adapters are optional and key by user plus conversation", async () => {
  const key = buildLongTermMemoryKey({
    platform: "whatsapp",
    userId: "+593 99",
    conversationId: "channel:user"
  });
  const noop = createNoopLongTermMemoryAdapter();
  const storage = new Map();
  const kv = {
    async get(name) { return storage.get(name) || null; },
    async put(name, value) { storage.set(name, value); },
    async delete(name) { storage.delete(name); }
  };
  const adapter = createKvLongTermMemoryAdapter(kv);
  const identity = { platform: "whatsapp", userId: "593", conversationId: "channel:user" };

  assert.equal(key, "whatsapp:_593_99:channel_user");
  assert.equal(await noop.read(identity), null);
  await adapter.write(identity, { name: "Mateo" });
  assert.deepEqual(await adapter.read(identity), { name: "Mateo" });
  await adapter.forget(identity);
  assert.equal(await adapter.read(identity), null);
});

test("long-term memory policy requires explicit consent by default", () => {
  const env = { ENABLE_LONG_TERM_MEMORY: "true", LONG_TERM_MEMORY_MODE: "kv" };
  const initialPolicy = buildMemoryPolicy(env, {});
  const grantedData = grantLongTermMemoryConsent({}, { now: "2026-06-16T12:00:00.000Z" });
  const grantedPolicy = buildMemoryPolicy(env, grantedData);
  const revokedPolicy = buildMemoryPolicy(env, revokeLongTermMemoryConsent(grantedData, {
    now: "2026-06-16T12:05:00.000Z"
  }));

  assert.equal(initialPolicy.shortTerm.maxTurns, 20);
  assert.equal(initialPolicy.shortTerm.rawHistoryAllowed, false);
  assert.equal(initialPolicy.longTerm.enabled, true);
  assert.equal(initialPolicy.longTerm.consentStatus, "not_requested");
  assert.equal(shouldWriteLongTermMemory(initialPolicy), false);
  assert.equal(shouldWriteLongTermMemory(grantedPolicy), true);
  assert.equal(shouldWriteLongTermMemory(revokedPolicy), false);
});

test("long-term memory write is optional and stores compact sanitized state only", async () => {
  const storage = new Map();
  const kv = {
    async get(name) { return storage.get(name) || null; },
    async put(name, value) { storage.set(name, value); },
    async delete(name) { storage.delete(name); }
  };
  const env = { ENABLE_LONG_TERM_MEMORY: "true", LONG_TERM_MEMORY_MODE: "kv" };
  const data = grantLongTermMemoryConsent({
    doName: "channel:user",
    channel: "channel",
    phone: "593",
    conversationLog: [{ textPreview: "raw secret history should stay short-term only" }],
    customerMemory: {
      name: "Mateo",
      language: "es",
      important_facts: [
        { label: "email", value: "mateo@example.com", source: "text" },
        { label: "plan", value: "pro", source: "text" }
      ]
    },
    userStyleProfile: { tone: "direct", detail_level: "brief" },
    utilityMemory: { active_list: "compras", list_names: ["compras"] }
  }, { now: "2026-06-16T12:00:00.000Z" });
  const policy = buildMemoryPolicy(env, data);
  const adapter = createKvLongTermMemoryAdapter(kv);
  const identity = buildMemoryIdentity(data);
  const skipped = await writeLongTermMemory(adapter, identity, buildMemoryPolicy(env, {}), data, {
    turn_id: "turn_1",
    input_types: ["TEXT"],
    media_batch: { fileIds: ["img_secret"] }
  });
  const written = await writeLongTermMemory(adapter, identity, policy, data, {
    turn_id: "turn_1",
    input_types: ["TEXT"],
    media_batch: { fileIds: ["img_secret"] }
  });
  const read = await readLongTermMemory(adapter, identity, policy);
  const serialized = JSON.stringify(read.memory);

  assert.equal(skipped.skipped, true);
  assert.equal(written.skipped, false);
  assert.equal(read.memory.profile.name, "Mateo");
  assert.equal(read.memory.utilityHints.activeList, "compras");
  assert.equal(serialized.includes("raw secret history"), false);
  assert.equal(serialized.includes("img_secret"), false);
  assert.equal(serialized.includes("mateo@example.com"), false);
  assert.equal(serialized.includes("[EMAIL_REDACTED]"), true);
});

test("long-term memory candidate and key use user plus conversation scope", () => {
  const candidate = buildLongTermMemoryCandidate({
    customerMemory: {
      name: "Mateo",
      important_facts: [{ label: "nota", value: "cliente prefiere mensajes cortos" }]
    },
    conversationLog: [{ textPreview: "no debe salir en memoria larga" }]
  }, {
    turn_id: "turn_candidate",
    input_types: ["TEXT", "IMAGE"]
  });

  assert.equal(candidate.profile.name, "Mateo");
  assert.equal(candidate.lastTurn.turnId, "turn_candidate");
  assert.equal(candidate.stableFacts.length, 1);
  assert.equal(JSON.stringify(candidate).includes("no debe salir"), false);
  assert.equal(buildLongTermMemoryKey({
    platform: "whatsapp",
    userId: "593",
    conversationId: "channel:user"
  }), "whatsapp:593:channel_user");
});
