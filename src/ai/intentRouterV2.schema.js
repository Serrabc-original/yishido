export const INTENT_ROUTER_V2_SCHEMA_VERSION = "intent_router_v2";

export const TURN_TYPES_V2 = [
  "new_request",
  "multi_intent_request",
  "clarification_answer",
  "confirmation",
  "rejection",
  "correction",
  "meta_question",
  "smalltalk",
  "image_followup",
  "document_request",
  "location_context",
  "unknown"
];

export const REPLY_STRATEGIES_V2 = [
  "execute_and_confirm",
  "ask_clarification",
  "ask_confirmation",
  "apologize_and_repair",
  "answer_only",
  "handoff_to_human",
  "do_nothing"
];

export function normalizeIntentRouterV2Result(input) {
  const clean = input && typeof input === "object" ? input : {};
  const turnType = TURN_TYPES_V2.includes(clean.turn_type) ? clean.turn_type : "unknown";
  const replyStrategy = clean.reply_strategy && typeof clean.reply_strategy === "object" ? clean.reply_strategy : {};

  return {
    schema_version: INTENT_ROUTER_V2_SCHEMA_VERSION,
    tenant_id: clean.tenant_id || null,
    user_id: clean.user_id || null,
    channel: clean.channel || "whatsapp",
    locale: clean.locale || "es-EC",
    timezone: clean.timezone || "America/Guayaquil",
    conversation_mode: clean.conversation_mode || "bot",
    turn_type: turnType,
    user_goal_summary: String(clean.user_goal_summary || "").slice(0, 400),
    is_example_or_quoted_text: Boolean(clean.is_example_or_quoted_text),
    is_user_complaining_about_agent: Boolean(clean.is_user_complaining_about_agent),
    should_not_execute_tools: Boolean(clean.should_not_execute_tools),
    tasks: normalizeTasks(clean.tasks || []),
    references: normalizeReferences(clean.references || {}),
    state_recommendations: normalizeStateRecommendations(clean.state_recommendations || {}),
    reply_strategy: {
      kind: REPLY_STRATEGIES_V2.includes(replyStrategy.kind) ? replyStrategy.kind : "answer_only",
      one_question_to_ask: replyStrategy.one_question_to_ask || null,
      human_summary: String(replyStrategy.human_summary || "").slice(0, 400)
    },
    safety: {
      requires_human: Boolean(clean.safety && clean.safety.requires_human),
      reason: clean.safety && clean.safety.reason || null
    }
  };
}

export function buildIntentTask(input) {
  const clean = input && typeof input === "object" ? input : {};
  const intent = String(clean.intent || "unknown");

  return {
    task_id: String(clean.task_id || intent),
    intent: intent,
    action_type: String(clean.action_type || inferActionType(intent)),
    status: String(clean.status || "blocked"),
    confidence: clampConfidence(clean.confidence),
    entities: clean.entities && typeof clean.entities === "object" ? clean.entities : {},
    required_slots: normalizeStringArray(clean.required_slots || clean.requiredSlots || []),
    missing_slots: normalizeStringArray(clean.missing_slots || clean.missingSlots || []),
    depends_on_task_ids: normalizeStringArray(clean.depends_on_task_ids || clean.dependsOnTaskIds || []),
    source_evidence: normalizeEvidence(clean.source_evidence || clean.sourceEvidence || []),
    user_visible_summary: String(clean.user_visible_summary || clean.userVisibleSummary || "").slice(0, 400)
  };
}

function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map(buildIntentTask).slice(0, 12);
}

function normalizeReferences(references) {
  const clean = references && typeof references === "object" ? references : {};
  return {
    uses_last_audio: Boolean(clean.uses_last_audio),
    uses_last_uploaded_image: Boolean(clean.uses_last_uploaded_image),
    uses_last_generated_image: Boolean(clean.uses_last_generated_image),
    source_asset_ids: normalizeStringArray(clean.source_asset_ids || clean.sourceAssetIds || []),
    source_document_ids: normalizeStringArray(clean.source_document_ids || clean.sourceDocumentIds || [])
  };
}

function normalizeStateRecommendations(input) {
  const clean = input && typeof input === "object" ? input : {};
  return {
    clear_pending_action: Boolean(clean.clear_pending_action),
    suspend_previous_task: Boolean(clean.suspend_previous_task),
    continue_active_task: Boolean(clean.continue_active_task),
    new_active_task_type: clean.new_active_task_type || null
  };
}

function normalizeEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : []).map(function (item) {
    const clean = item && typeof item === "object" ? item : {};
    return {
      source: String(clean.source || "text"),
      quote_or_summary: String(clean.quote_or_summary || clean.quoteOrSummary || "").slice(0, 300)
    };
  }).slice(0, 12);
}

function inferActionType(intent) {
  if (intent.includes(".search") || intent.includes(".analyze") || intent.includes(".read")) return "read";
  if (intent.includes(".delete")) return "delete";
  if (intent.includes("reminder.create")) return "schedule";
  if (intent.includes(".generate") || intent.includes(".edit")) return "generate";
  if (intent === "reply_only" || intent === "unknown") return "reply_only";
  return "write";
}

function normalizeStringArray(value) {
  return (Array.isArray(value) ? value : []).map(String).filter(Boolean);
}

function clampConfidence(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}
