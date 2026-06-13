export const SUPPORT_MODULE = {
  name: "support",
  enabledBy: "future",
  status: "proposal",
  actions: ["classify_issue", "request_missing_context", "handoff_to_human"]
};

export function buildSupportTicketProposal() {
  return {
    enabled: false,
    requiredBeforeActivation: ["ticket destination", "priority rules", "privacy policy"]
  };
}
