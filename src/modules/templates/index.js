export const TEMPLATES_MODULE = {
  name: "templates",
  enabledBy: "ENABLE_TEMPLATE_MODULE",
  status: "stub",
  actions: []
};

export function buildTemplateMessageDraft(params) {
  return {
    enabled: false,
    templateName: params && params.templateName || "",
    reason: "WhatsApp templates are prepared as a module but not sent by default."
  };
}
