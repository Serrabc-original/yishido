export function evaluateHandoffPolicy(input) {
  const clean = input || {};
  const text = normalizeText(clean.text || clean.currentTurnText || "");
  const confidence = Number(clean.confidence || 0);
  const action = clean.action || {};
  const reasons = [];

  if (/\b(humano|asesor|persona|agente real|supervisor)\b/.test(text)) reasons.push("user_requested_human");
  if (/\b(molesto|molesta|enojado|enojada|reclamo|queja|demanda)\b/.test(text)) reasons.push("upset_customer");
  if (/\b(cedula|c[eé]dula|tarjeta|clave|password|contrase[nñ]a|salud|medico|m[eé]dico)\b/.test(text)) reasons.push("sensitive_data");
  if (confidence > 0 && confidence < 0.45) reasons.push("low_confidence");
  if (action && action.requiresApproval) reasons.push("approval_required");

  return {
    needsHuman: reasons.length > 0,
    reasons: Array.from(new Set(reasons)),
    defaultBehavior: "flag_only"
  };
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
