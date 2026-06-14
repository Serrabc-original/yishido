export const TEMPLATES_MODULE = {
  name: "templates",
  enabledBy: "ENABLE_TEMPLATE_MODULE",
  status: "catalog_safe",
  actions: ["catalog", "draft", "delivery_guard"]
};

const DEFAULT_TEMPLATE_CATALOG = [
  {
    id: "reminder_due",
    purpose: "reminder_due_outside_24h",
    nameEnv: "REMINDER_TEMPLATE_NAME",
    languageEnv: "REMINDER_TEMPLATE_LANGUAGE",
    namespaceEnv: "REMINDER_TEMPLATE_NAMESPACE",
    paramModeEnv: "REMINDER_TEMPLATE_PARAM_MODE",
    paramsSchema: ["message"],
    requiresApproval: true
  },
  {
    id: "reactivation",
    purpose: "safe_reactivation",
    nameEnv: "REACTIVATION_TEMPLATE_NAME",
    languageEnv: "REACTIVATION_TEMPLATE_LANGUAGE",
    namespaceEnv: "REACTIVATION_TEMPLATE_NAMESPACE",
    paramModeEnv: "REACTIVATION_TEMPLATE_PARAM_MODE",
    paramsSchema: ["reason"],
    requiresApproval: true
  },
  {
    id: "operation_confirmation",
    purpose: "operation_confirmation",
    nameEnv: "OPERATION_TEMPLATE_NAME",
    languageEnv: "OPERATION_TEMPLATE_LANGUAGE",
    namespaceEnv: "OPERATION_TEMPLATE_NAMESPACE",
    paramModeEnv: "OPERATION_TEMPLATE_PARAM_MODE",
    paramsSchema: ["summary"],
    requiresApproval: true
  }
];

export function buildTemplateCatalog(env) {
  return DEFAULT_TEMPLATE_CATALOG.map(function (entry) {
    const name = String(env && env[entry.nameEnv] || "");
    const language = String(env && env[entry.languageEnv] || "es");
    const namespace = String(env && env[entry.namespaceEnv] || "");
    const paramMode = String(env && env[entry.paramModeEnv] || "body_text");

    return {
      id: entry.id,
      purpose: entry.purpose,
      name: name,
      language: language,
      namespace: namespace,
      paramMode: paramMode,
      paramsSchema: entry.paramsSchema.slice(),
      approvalStatus: name ? "configured_assumed_approved" : "not_configured",
      requiresApproval: entry.requiresApproval,
      enabled: Boolean(name)
    };
  });
}

export function getTemplateByPurpose(env, purpose) {
  return buildTemplateCatalog(env || {}).find(function (template) {
    return template.purpose === purpose;
  }) || null;
}

export function canSendTemplate(template) {
  return Boolean(
    template &&
    template.enabled &&
    template.name &&
    template.approvalStatus !== "not_configured"
  );
}

export function buildTemplateMessageDraft(params) {
  const clean = params || {};
  const template = clean.template || {};

  return {
    enabled: canSendTemplate(template),
    templateName: template.name || clean.templateName || "",
    language: template.language || clean.language || "es",
    namespace: template.namespace || clean.namespace || "",
    paramMode: template.paramMode || clean.paramMode || "body_text",
    params: Array.isArray(clean.params) ? clean.params.map(String) : [],
    reason: canSendTemplate(template)
      ? "Template configured for channel adapter delivery."
      : "Template is not configured or approved; block safely instead of sending."
  };
}
