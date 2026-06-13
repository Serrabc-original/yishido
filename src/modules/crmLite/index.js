export const CRM_LITE_MODULE = {
  name: "crmLite",
  enabledBy: "future",
  status: "proposal",
  entities: ["contact", "conversation", "tag", "follow_up"]
};

export function buildCrmLiteProposal() {
  return {
    enabled: false,
    reason: "CRM-lite needs clear data retention and consent rules before activation.",
    minimumFields: ["contact_id", "channel", "tags", "last_interaction_at"]
  };
}
