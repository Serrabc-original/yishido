export function buildLongTermMemoryKey(identity) {
  const clean = identity || {};
  const platform = sanitizeKeyPart(clean.platform || "whatsapp");
  const userId = sanitizeKeyPart(clean.userId || clean.recipientId || clean.phone || "");
  const conversationId = sanitizeKeyPart(clean.conversationId || clean.doName || "");

  return [platform, userId || "unknown_user", conversationId || "unknown_conversation"].join(":");
}

export function createNoopLongTermMemoryAdapter() {
  return {
    name: "noop_long_term_memory",
    async read() {
      return null;
    },
    async write() {
      return { ok: true, skipped: true, reason: "noop_adapter" };
    },
    async forget() {
      return { ok: true, skipped: true, reason: "noop_adapter" };
    }
  };
}

export function createLongTermMemoryAdapterFromEnv(env, policy) {
  const longTerm = policy && policy.longTerm || {};
  if (!longTerm.enabled || longTerm.mode === "disabled") {
    return createNoopLongTermMemoryAdapter();
  }

  if (longTerm.mode === "kv") {
    const bindingName = String(longTerm.binding || "SESSIONS_KV");
    const kv = env && (env[bindingName] || env.SESSIONS_KV);
    return createKvLongTermMemoryAdapter(kv, {
      namespace: longTerm.namespace || "ltm"
    });
  }

  return createNoopLongTermMemoryAdapter();
}

export function createKvLongTermMemoryAdapter(kv, options) {
  const namespace = String(options && options.namespace || "ltm");

  return {
    name: "kv_long_term_memory",
    async read(identity) {
      if (!kv || typeof kv.get !== "function") return null;
      const raw = await kv.get(namespace + ":" + buildLongTermMemoryKey(identity));
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (_) {
        return null;
      }
    },
    async write(identity, memory) {
      if (!kv || typeof kv.put !== "function") {
        return { ok: false, skipped: true, reason: "kv_missing" };
      }
      await kv.put(namespace + ":" + buildLongTermMemoryKey(identity), JSON.stringify(memory || {}));
      return { ok: true, skipped: false };
    },
    async forget(identity) {
      const key = namespace + ":" + buildLongTermMemoryKey(identity);
      if (kv && typeof kv.delete === "function") {
        await kv.delete(key);
        return { ok: true, skipped: false };
      }
      if (kv && typeof kv.put === "function") {
        await kv.put(key, "");
        return { ok: true, skipped: false, tombstone: true };
      }
      return { ok: false, skipped: true, reason: "kv_missing" };
    }
  };
}

export async function readLongTermMemory(adapter, identity, policy) {
  const longTerm = policy && policy.longTerm || {};
  if (!longTerm.enabled || !longTerm.readAllowed) {
    return {
      ok: true,
      skipped: true,
      reason: longTerm.enabled ? "consent_required" : "long_term_disabled",
      memory: null
    };
  }

  const memory = normalizeLongTermMemory(await adapter.read(identity));
  return {
    ok: true,
    skipped: false,
    memory: memory
  };
}

export async function writeLongTermMemory(adapter, identity, policy, data, userTurn) {
  const longTerm = policy && policy.longTerm || {};
  if (!longTerm.enabled || !longTerm.writeAllowed) {
    return {
      ok: true,
      skipped: true,
      reason: longTerm.enabled ? "consent_required" : "long_term_disabled",
      memory: null
    };
  }

  const existing = normalizeLongTermMemory(data && data.longTermMemory || await adapter.read(identity));
  const candidate = buildLongTermMemoryCandidate(data, userTurn);
  const merged = mergeLongTermMemory(existing, candidate);
  const result = await adapter.write(identity, merged);

  return Object.assign({}, result, {
    memory: merged,
    key: buildLongTermMemoryKey(identity)
  });
}

export function buildLongTermMemoryCandidate(data, userTurn) {
  const clean = data || {};
  const customerMemory = clean.customerMemory && typeof clean.customerMemory === "object" ? clean.customerMemory : {};
  const style = clean.userStyleProfile && typeof clean.userStyleProfile === "object" ? clean.userStyleProfile : {};
  const utility = clean.utilityMemory && typeof clean.utilityMemory === "object" ? clean.utilityMemory : {};
  const turn = userTurn || {};
  const importantFacts = normalizeLongTermFacts(customerMemory.important_facts || customerMemory.importantFacts || []);

  return normalizeLongTermMemory({
    source: "optional_long_term_memory_v1",
    profile: {
      name: customerMemory.name || "",
      language: customerMemory.language || style.language || "",
      responsePreference: customerMemory.response_preference || customerMemory.style_preference || "",
      styleTone: style.tone || "",
      detailLevel: style.detail_level || "",
      knownBusinessTerms: customerMemory.known_business_terms || []
    },
    stableFacts: importantFacts,
    utilityHints: {
      activeList: utility.active_list || utility.activeList || "",
      recentListNames: Array.isArray(utility.list_names) ? utility.list_names.slice(0, 12) : [],
      openTaskCount: Number(utility.open_task_count || 0),
      leadCount: Number(utility.lead_count || 0)
    },
    lastTurn: {
      turnId: turn.turn_id || turn.turnId || "",
      inputTypes: turn.input_types || turn.inputTypes || [],
      at: turn.created_at || turn.createdAt || new Date().toISOString()
    },
    updatedAt: new Date().toISOString()
  });
}

export function mergeLongTermMemory(existing, candidate) {
  const previous = normalizeLongTermMemory(existing) || {};
  const next = normalizeLongTermMemory(candidate) || {};
  const profile = Object.assign({}, previous.profile || {}, removeEmptyProfileFields(next.profile || {}));
  const stableFacts = mergeFacts(previous.stableFacts || [], next.stableFacts || []);
  const utilityHints = Object.assign({}, previous.utilityHints || {}, removeEmptyProfileFields(next.utilityHints || {}));

  return normalizeLongTermMemory({
    source: "optional_long_term_memory_v1",
    profile: profile,
    stableFacts: stableFacts,
    utilityHints: utilityHints,
    lastTurn: next.lastTurn || previous.lastTurn || null,
    updatedAt: next.updatedAt || new Date().toISOString()
  });
}

export function normalizeLongTermMemory(memory) {
  if (!memory || typeof memory !== "object") return null;
  const profile = memory.profile && typeof memory.profile === "object" ? memory.profile : {};
  const utilityHints = memory.utilityHints && typeof memory.utilityHints === "object" ? memory.utilityHints : {};
  const lastTurn = memory.lastTurn && typeof memory.lastTurn === "object" ? memory.lastTurn : null;

  return {
    source: String(memory.source || "optional_long_term_memory_v1"),
    profile: {
      name: sanitizeMemoryText(profile.name || "").slice(0, 80),
      language: sanitizeMemoryText(profile.language || "").slice(0, 20),
      responsePreference: sanitizeMemoryText(profile.responsePreference || profile.response_preference || "").slice(0, 180),
      styleTone: sanitizeMemoryText(profile.styleTone || profile.style_tone || "").slice(0, 40),
      detailLevel: sanitizeMemoryText(profile.detailLevel || profile.detail_level || "").slice(0, 40),
      knownBusinessTerms: normalizeStringArray(profile.knownBusinessTerms || profile.known_business_terms, 12, 80)
    },
    stableFacts: normalizeLongTermFacts(memory.stableFacts || memory.stable_facts || []),
    utilityHints: {
      activeList: sanitizeMemoryText(utilityHints.activeList || utilityHints.active_list || "").slice(0, 80),
      recentListNames: normalizeStringArray(utilityHints.recentListNames || utilityHints.recent_list_names, 12, 80),
      openTaskCount: Number(utilityHints.openTaskCount || utilityHints.open_task_count || 0),
      leadCount: Number(utilityHints.leadCount || utilityHints.lead_count || 0)
    },
    lastTurn: lastTurn ? {
      turnId: sanitizeMemoryText(lastTurn.turnId || lastTurn.turn_id || "").slice(0, 80),
      inputTypes: normalizeStringArray(lastTurn.inputTypes || lastTurn.input_types, 8, 40),
      at: sanitizeMemoryText(lastTurn.at || "").slice(0, 40)
    } : null,
    updatedAt: sanitizeMemoryText(memory.updatedAt || memory.updated_at || new Date().toISOString()).slice(0, 40)
  };
}

function sanitizeKeyPart(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 80);
}

function normalizeLongTermFacts(facts) {
  return (Array.isArray(facts) ? facts : []).map(function (fact) {
    return {
      label: sanitizeMemoryText(fact && (fact.label || fact.type) || "").slice(0, 60),
      value: sanitizeMemoryText(fact && fact.value || "").slice(0, 240),
      source: sanitizeMemoryText(fact && fact.source || "").slice(0, 40),
      updatedAt: sanitizeMemoryText(fact && (fact.updatedAt || fact.updated_at) || new Date().toISOString()).slice(0, 40)
    };
  }).filter(function (fact) {
    return fact.label && fact.value && isSafeLongTermFact(fact);
  }).slice(-20);
}

function isSafeLongTermFact(fact) {
  const label = normalizeMemorySearchText(fact && fact.label || "");
  const value = normalizeMemorySearchText(fact && fact.value || "");
  const joined = label + " " + value;

  if (/\b(ignore|ignora|olvida|override|system prompt|developer message|jailbreak|prompt injection|api key|token|secret|contrasena)\b/.test(joined)) {
    return false;
  }
  if (/\b(hoy|manana|en \d+\s*(min|minuto|minutos|hora|horas)|dentro de|recordatorio|recuerdame|hazme acuerdo|hacer acuerdo)\b/.test(joined)) {
    return false;
  }
  if (label === "nota_contexto" && /\b(lista|recordatorio|audio|imagen|foto|captura|este turno|esta conversacion)\b/.test(value)) {
    return false;
  }
  return true;
}

function normalizeMemorySearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeFacts(previousFacts, newFacts) {
  const merged = [];
  const seen = new Set();
  for (const fact of normalizeLongTermFacts(previousFacts).concat(normalizeLongTermFacts(newFacts))) {
    const key = fact.label.toLowerCase() + ":" + fact.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(fact);
  }
  return merged.slice(-20);
}

function removeEmptyProfileFields(value) {
  const clean = {};
  for (const key of Object.keys(value || {})) {
    if (Array.isArray(value[key])) {
      if (value[key].length) clean[key] = value[key];
      continue;
    }
    if (value[key] !== "" && value[key] !== null && value[key] !== undefined) clean[key] = value[key];
  }
  return clean;
}

function normalizeStringArray(value, limit, maxLength) {
  return (Array.isArray(value) ? value : []).map(function (item) {
    return sanitizeMemoryText(item).slice(0, maxLength || 80);
  }).filter(Boolean).slice(0, limit || 12);
}

function sanitizeMemoryText(value) {
  return String(value || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL_REDACTED]")
    .replace(/\b(?:\+?\d[\s().-]*){8,}\b/g, "[PHONE_REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, "[SECRET_REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000);
}
