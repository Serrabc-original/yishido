import { getSpecialistModel } from "../ai/modelRegistry.js";

const AGENTS = [
  {
    name: "general_explainer",
    purpose: "Responder preguntas generales y tecnicas en lenguaje claro.",
    allowedIntents: ["general"],
    systemPrompt: "Responde preguntas claras de forma directa, util y conversacional. No uses menus genericos, no arrastres media vieja y pide solo un dato si falta contexto.",
    sanityRules: ["must_answer_clear_question", "no_stale_media"]
  },
  {
    name: "product_advisor",
    purpose: "Evaluar productos visibles cuando el usuario pregunta uso, conveniencia o caracteristicas.",
    allowedIntents: ["product_advice", "image_question"],
    systemPrompt: "Usa solo evidencia visible o datos dados por el usuario. Si falta precio, modelo, medida o contexto, dilo sin inventar beneficios.",
    sanityRules: ["requires_product_or_explicit_user_product_question"]
  },
  {
    name: "price_review",
    purpose: "Extraer y comparar precios visibles en una o varias imagenes.",
    allowedIntents: ["price_review", "multi_image_price_review"],
    systemPrompt: "Compara todas las imagenes del batch. Extrae producto, precio, cantidad, marca y etiquetas visibles; si falta precio o modelo, dilo claramente.",
    sanityRules: ["requires_price_context", "use_all_pending_batch"]
  },
  {
    name: "pet_photo",
    purpose: "Describir fotos de mascotas y proponer captions o ediciones relevantes.",
    allowedIntents: ["pet_photo", "unknown_image_request", "image_description"],
    systemPrompt: "Responde sobre la mascota o escena con tono natural. No conviertas la respuesta en compra, precio o marketing salvo que el usuario lo pida.",
    sanityRules: ["no_purchase_advice_for_pet"]
  },
  {
    name: "cooking",
    purpose: "Ayudar con comida, recetas e ingredientes visibles.",
    allowedIntents: ["cooking", "image_question"],
    systemPrompt: "Da pasos practicos y seguros. No inventes ingredientes no visibles y marca incertidumbre si la imagen no permite identificar algo.",
    sanityRules: ["food_safety_uncertainty"]
  },
  {
    name: "mechanic",
    purpose: "Explicar mecanica, motores y sistemas tecnicos.",
    allowedIntents: ["general", "mechanic"],
    systemPrompt: "Explica principios, componentes y advertencias practicas con lenguaje claro. No finjas inspeccion tecnica si solo hay descripcion parcial.",
    sanityRules: ["answer_technical_question"]
  },
  {
    name: "memory",
    purpose: "Guardar o consultar memoria segura del usuario.",
    allowedIntents: ["memory"],
    systemPrompt: "Guardar solo preferencias o datos utiles permitidos. No guardes datos personales sensibles ni instrucciones temporales sin politica/consentimiento.",
    sanityRules: ["no_sensitive_payloads"]
  },
  {
    name: "reminder",
    purpose: "Crear, listar o borrar recordatorios.",
    allowedIntents: ["reminder"],
    systemPrompt: "Crea recordatorios solo con asunto y fecha/hora claros. Si falta hora o fecha, pregunta solo ese dato. No uses titulos genericos como hacer un recordatorio.",
    sanityRules: ["template_required_outside_24h"]
  },
  {
    name: "image_generation",
    purpose: "Generar o editar imagenes cuando el usuario lo pide explicitamente.",
    allowedIntents: ["marketing", "image_generation"],
    systemPrompt: "Genera o edita imagenes solo cuando el usuario lo pidio explicitamente. Usa assets existentes cuando sean relevantes, preserva el sujeto principal, evita texto ilegible y nunca publiques en Meta.",
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
