import { logEvent } from "../logger.js";
import { normalizeActionContract } from "../contracts/assistantContracts.js";

export const ACTION_REGISTRY = [
  {
    action: "create_task",
    module: "tasks",
    requiresApproval: false,
    description: "Create a persistent operational task."
  },
  {
    action: "update_task",
    module: "tasks",
    requiresApproval: false,
    description: "Update an existing persistent task."
  },
  {
    action: "pause_task",
    module: "tasks",
    requiresApproval: false,
    description: "Pause an open task."
  },
  {
    action: "cancel_task",
    module: "tasks",
    requiresApproval: false,
    description: "Cancel an open task."
  },
  {
    action: "close_task",
    module: "tasks",
    requiresApproval: false,
    description: "Close an open task."
  },
  {
    action: "list_tasks",
    module: "tasks",
    requiresApproval: false,
    description: "List open and paused tasks."
  },
  {
    action: "save_lead",
    module: "crmLite",
    requiresApproval: false,
    description: "Save a compact lead record."
  },
  {
    action: "update_client_memory",
    module: "crmLite",
    requiresApproval: false,
    description: "Update compact client memory."
  }
];

export function listRegisteredActions() {
  return ACTION_REGISTRY.map(function (item) {
    return Object.assign({}, item);
  });
}

export function getRegisteredAction(actionName) {
  const clean = String(actionName || "");
  return ACTION_REGISTRY.find(function (item) {
    return item.action === clean;
  }) || null;
}

export function authorizeAction(action, context) {
  const contract = normalizeActionContract(action);
  const registered = getRegisteredAction(contract.action);
  const trace = {
    traceId: context && context.traceId || "",
    turnId: context && context.turnId || "",
    doName: context && context.doName || "",
    action: contract.action,
    module: contract.module
  };

  if (!registered) {
    logEvent("TOOL_ACTION_BLOCKED", Object.assign({}, trace, {
      reason: "unregistered_action"
    }));
    return Object.assign({}, contract, {
      status: "blocked",
      userFacingSummary: contract.userFacingSummary || "La accion no esta registrada."
    });
  }

  if (registered.requiresApproval || contract.requiresApproval) {
    logEvent("TOOL_ACTION_BLOCKED", Object.assign({}, trace, {
      reason: "approval_required"
    }));
    return Object.assign({}, contract, {
      requiresApproval: true,
      status: "blocked",
      userFacingSummary: contract.userFacingSummary || "Esta accion necesita aprobacion antes de ejecutarse."
    });
  }

  logEvent("TOOL_ACTION_ALLOWED", Object.assign({}, trace, {
    confidence: contract.confidence
  }));
  return Object.assign({}, contract, {
    module: registered.module,
    requiresApproval: false,
    status: "allowed"
  });
}

export function authorizeActions(actions, context) {
  return (Array.isArray(actions) ? actions : [])
    .map(function (action) { return authorizeAction(action, context); })
    .filter(function (action) { return action.action; });
}
