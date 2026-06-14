import { getSpecialistModel } from "../ai/modelRegistry.js";

const AGENTS = [
  {
    name: "general_explainer",
    purpose: "Responder preguntas generales y tecnicas en lenguaje claro.",
    allowedIntents: ["general"],
    systemPrompt: "Explica de forma directa, util y conversacional. No uses fallback generico si hay una pregunta clara.",
    sanityRules: ["must_answer_clear_question", "no_stale_media"]
  },
  {
    name: "product_advisor",
    purpose: "Evaluar productos visibles cuando el usuario pregunta uso, conveniencia o caracteristicas.",
    allowedIntents: ["product_advice", "image_question"],
    systemPrompt: "Usa solo lo visible y pide datos faltantes. No inventes beneficios.",
    sanityRules: ["requires_product_or_explicit_user_product_question"]
  },
  {
    name: "price_review",
    purpose: "Extraer y comparar precios visibles en una o varias imagenes.",
    allowedIntents: ["price_review", "multi_image_price_review"],
    systemPrompt: "Compara todas las imagenes del batch. Si falta precio o modelo, dilo.",
    sanityRules: ["requires_price_context", "use_all_pending_batch"]
  },
  {
    name: "pet_photo",
    purpose: "Describir fotos de mascotas y proponer captions o ediciones relevantes.",
    allowedIntents: ["pet_photo", "unknown_image_request", "image_description"],
    systemPrompt: "Responde sobre la mascota o escena. Nunca uses consejos de compra salvo que el usuario lo pida.",
    sanityRules: ["no_purchase_advice_for_pet"]
  },
  {
    name: "cooking",
    purpose: "Ayudar con comida, recetas e ingredientes visibles.",
    allowedIntents: ["cooking", "image_question"],
    systemPrompt: "Da pasos practicos y seguros; no inventes ingredientes no visibles.",
    sanityRules: ["food_safety_uncertainty"]
  },
  {
    name: "mechanic",
    purpose: "Explicar mecanica, motores y sistemas tecnicos.",
    allowedIntents: ["general", "mechanic"],
    systemPrompt: "Explica el principio, componentes y advertencias practicas.",
    sanityRules: ["answer_technical_question"]
  },
  {
    name: "memory",
    purpose: "Guardar o consultar memoria segura del usuario.",
    allowedIntents: ["memory"],
    systemPrompt: "Guardar solo datos utiles y no sensibles.",
    sanityRules: ["no_sensitive_payloads"]
  },
  {
    name: "reminder",
    purpose: "Crear, listar o borrar recordatorios.",
    allowedIntents: ["reminder"],
    systemPrompt: "Pide fecha/hora si falta. Respeta ventana WhatsApp de 24 horas.",
    sanityRules: ["template_required_outside_24h"]
  },
  {
    name: "image_generation",
    purpose: "Generar o editar imagenes cuando el usuario lo pide explicitamente.",
    allowedIntents: ["marketing", "image_generation"],
    systemPrompt: "No publiques en Meta. Genera solo si el usuario pidio imagen o edicion.",
    sanityRules: ["explicit_generation_request"]
  }
];

export function listAgents(env) {
  return AGENTS.map(function (agent) {
    return Object.assign({}, agent, {
      model: getSpecialistModel(env || {}, agent.name)
    });
  });
}

export function getAgentByName(name, env) {
  const found = AGENTS.find(function (agent) {
    return agent.name === name;
  });
  return found ? Object.assign({}, found, { model: getSpecialistModel(env || {}, found.name) }) : null;
}

export function getAgentsForIntent(intent, env) {
  return listAgents(env || {}).filter(function (agent) {
    return agent.allowedIntents.includes(intent);
  });
}
