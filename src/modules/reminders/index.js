export const REMINDERS_MODULE = {
  name: "reminders",
  enabledBy: "ENABLE_REMINDERS",
  status: "stub",
  actions: []
};

export function buildReminderCandidate() {
  return {
    enabled: false,
    reason: "Reminder scheduling is intentionally not active yet.",
    nextStep: "Define storage, consent, timezone, and delivery policy before enabling."
  };
}
