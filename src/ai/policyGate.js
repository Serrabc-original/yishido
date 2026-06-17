const NO_TOOL_TURN_TYPES = new Set(["correction", "meta_question", "rejection", "unknown"]);
const SENSITIVE_CONFIRMATION_INTENTS = new Set(["crm.update", "crm.delete"]);

export function evaluatePolicyGate(input) {
  const clean = input || {};
  const router = clean.routerResult || clean.intentRouterResult || {};
  const tasks = Array.isArray(router.tasks) ? router.tasks : [];
  const blockedReasons = [];

  if (router.conversation_mode === "live_chat") {
    return buildDecision({
      decision: "do_nothing",
      shouldExecuteTools: false,
      shouldSendBotReply: false,
      blockedReasons: ["live_chat_mode"],
      replyStrategy: router.reply_strategy || {}
    });
  }

  if (router.should_not_execute_tools || NO_TOOL_TURN_TYPES.has(router.turn_type)) {
    const decision = router.turn_type === "correction"
      ? "repair"
      : router.turn_type === "meta_question"
        ? "answer_only"
        : "answer_only";
    return buildDecision({
      decision: decision,
      shouldExecuteTools: false,
      blockedReasons: ["turn_type_no_tools"],
      replyStrategy: router.reply_strategy || {}
    });
  }

  const missingSlots = collectMissingSlots(tasks);
  if (missingSlots.length) {
    return buildDecision({
      decision: "ask_clarification",
      shouldExecuteTools: false,
      missingSlots: missingSlots,
      oneQuestionToAsk: router.reply_strategy && router.reply_strategy.one_question_to_ask || buildMissingSlotQuestion(missingSlots),
      blockedReasons: ["missing_required_slots"],
      replyStrategy: router.reply_strategy || {}
    });
  }

  const confirmationTask = tasks.find(function (task) {
    return task && (task.status === "needs_confirmation" || SENSITIVE_CONFIRMATION_INTENTS.has(task.intent));
  });
  if (confirmationTask) {
    const reasons = [];
    if (confirmationTask.intent === "crm.delete") reasons.push("destructive_requires_confirmation");
    else reasons.push("write_requires_confirmation");
    return buildDecision({
      decision: "ask_confirmation",
      shouldExecuteTools: false,
      requiresConfirmation: true,
      blockedReasons: reasons,
      replyStrategy: router.reply_strategy || {}
    });
  }

  const executableTasks = tasks.filter(isExecutableTask);
  if (!executableTasks.length) {
    return buildDecision({
      decision: "reply_only",
      shouldExecuteTools: false,
      replyStrategy: router.reply_strategy || {}
    });
  }

  return buildDecision({
    decision: "execute",
    shouldExecuteTools: true,
    toolCalls: executableTasks.map(function (task) {
      return {
        intent: task.intent,
        action_type: task.action_type,
        task_id: task.task_id,
        entities: task.entities || {},
        depends_on_task_ids: task.depends_on_task_ids || []
      };
    }),
    replyStrategy: router.reply_strategy || {}
  });
}

function buildDecision(input) {
  const clean = input || {};
  const replyStrategy = clean.replyStrategy || {};
  return {
    decision: String(clean.decision || "answer_only"),
    shouldExecuteTools: Boolean(clean.shouldExecuteTools),
    shouldSendBotReply: clean.shouldSendBotReply !== false,
    requiresConfirmation: Boolean(clean.requiresConfirmation),
    blockedReasons: Array.isArray(clean.blockedReasons) ? clean.blockedReasons : [],
    missingSlots: Array.isArray(clean.missingSlots) ? clean.missingSlots : [],
    toolCalls: Array.isArray(clean.toolCalls) ? clean.toolCalls : [],
    oneQuestionToAsk: clean.oneQuestionToAsk || replyStrategy.one_question_to_ask || null,
    replyStrategy: {
      kind: replyStrategy.kind || "",
      oneQuestionToAsk: clean.oneQuestionToAsk || replyStrategy.one_question_to_ask || null,
      humanSummary: replyStrategy.human_summary || ""
    }
  };
}

function isExecutableTask(task) {
  if (!task || task.status !== "ready") return false;
  if (task.intent === "reply_only" || task.action_type === "reply_only") return false;
  if (task.intent === "list.format") return false;
  return true;
}

function collectMissingSlots(tasks) {
  const slots = [];
  for (const task of tasks) {
    const missing = Array.isArray(task && task.missing_slots) ? task.missing_slots : [];
    for (const slot of missing) {
      if (!slots.includes(slot)) slots.push(slot);
    }
  }
  return slots;
}

function buildMissingSlotQuestion(missingSlots) {
  if (missingSlots.includes("due_at")) return "Cuando quieres que te lo recuerde?";
  if (missingSlots.includes("items")) return "Que elementos quieres poner en la lista?";
  return "Que dato falta para continuar?";
}
