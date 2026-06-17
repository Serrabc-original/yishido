const LOCAL_EXECUTABLE_INTENTS = new Set(["list.format", "reminder.create"]);
const LEGACY_DELEGATED_INTENTS = new Set(["image.edit", "image.generate"]);

export function isIntentRouterV2LocalExecutable(intent) {
  return LOCAL_EXECUTABLE_INTENTS.has(String(intent || ""));
}

export function shouldDelegateIntentRouterV2TaskToLegacy(task) {
  return LEGACY_DELEGATED_INTENTS.has(String(task && task.intent || ""));
}

export function hasIntentRouterV2LocalWork(tasks) {
  return (Array.isArray(tasks) ? tasks : []).some(function (task) {
    return task && task.status === "ready" && isIntentRouterV2LocalExecutable(task.intent);
  });
}

export function summarizeToolContract(task) {
  const intent = String(task && task.intent || "");
  if (isIntentRouterV2LocalExecutable(intent)) return { intent: intent, mode: "local" };
  if (shouldDelegateIntentRouterV2TaskToLegacy(task)) return { intent: intent, mode: "legacy" };
  return { intent: intent, mode: "unavailable" };
}
