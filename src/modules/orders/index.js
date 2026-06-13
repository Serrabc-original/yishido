export const ORDERS_MODULE = {
  name: "orders",
  enabledBy: "future",
  status: "proposal",
  actions: ["collect_order_intent", "confirm_order_details"]
};

export function buildOrderIntakeProposal() {
  return {
    enabled: false,
    requiredBeforeActivation: ["catalog source", "pricing policy", "human handoff policy"]
  };
}
