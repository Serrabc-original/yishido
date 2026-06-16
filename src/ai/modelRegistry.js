import { logEvent } from "../logger.js";

const FALLBACKS = {
  supervisor: "gpt-5.4-mini",
  router: "gpt-5.4-nano",
  specialist: "gpt-5.4-mini",
  final_response: "gpt-5.4-mini",
  customer_reply: "gpt-5.4-mini",
  vision: "gpt-5.4-mini",
  image_generation: "gpt-image-2",
  transcription: "whisper-1"
};

const VALID_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-4.1-mini",
  "gpt-image-2",
  "whisper-1",
  "mock"
]);

export function getSupervisorModel(env) {
  return selectModel(env && env.SUPERVISOR_MODEL, FALLBACKS.supervisor, "supervisor");
}

export function getRouterModel(env) {
  return selectModel(env && env.ROUTER_MODEL, FALLBACKS.router, "router");
}

export function getSpecialistModel(env, specialistName) {
  const key = "SPECIALIST_" + String(specialistName || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_MODEL";
  return selectModel(env && (env[key] || env.SPECIALIST_DEFAULT_MODEL), FALLBACKS.specialist, "specialist", {
    specialistName: specialistName || "default"
  });
}

export function getCheapSpecialistModel(env) {
  return selectModel(env && env.SPECIALIST_CHEAP_MODEL, FALLBACKS.router, "specialist_cheap");
}

export function getFinalResponseModel(env) {
  return selectModel(env && env.FINAL_RESPONSE_MODEL, FALLBACKS.final_response, "final_response");
}

export function getCustomerReplyModel(env) {
  const configured = env && env.CUSTOMER_REPLY_MODEL || "gpt-4.1-mini";
  const fallback = env && env.FINAL_RESPONSE_MODEL || FALLBACKS.customer_reply;
  return selectModel(configured, fallback, "customer_reply");
}

export function getVisionModel(env) {
  return selectModel(env && env.VISION_MODEL, FALLBACKS.vision, "vision");
}

export function getImageGenerationModel(env) {
  return selectModel(env && env.OPENAI_IMAGE_MODEL, FALLBACKS.image_generation, "image_generation");
}

export function getTranscriptionModel(env) {
  return selectModel(env && env.AUDIO_TRANSCRIPTION_MODEL, FALLBACKS.transcription, "transcription");
}

export function isValidModelId(modelId) {
  return VALID_MODELS.has(String(modelId || "").trim());
}

export function selectModel(configuredModel, fallbackModel, purpose, extra) {
  const configured = String(configuredModel || "").trim();
  const fallback = String(fallbackModel || "").trim();
  const details = Object.assign({
    purpose: purpose || "unknown",
    configuredModel: configured || "(empty)",
    fallbackModel: fallback
  }, extra || {});

  if (configured && isValidModelId(configured)) {
    logEvent("MODEL_REGISTRY_SELECTED", Object.assign({}, details, {
      model: configured,
      usedFallback: false
    }));
    return configured;
  }

  logEvent("MODEL_CONFIG_INVALID", details, { level: "error" });
  logEvent("MODEL_REGISTRY_FALLBACK_USED", Object.assign({}, details, {
    model: fallback,
    usedFallback: true
  }));
  return fallback;
}

export const MODEL_FALLBACKS = FALLBACKS;
