import test from "node:test";
import assert from "node:assert/strict";
import {
  buildFastAckText,
  composeFinalResponse,
  composeGeneralTextAnswer,
  shouldSendFastAck,
  splitConversationalText,
  validateSpecialistOutputAgainstIntent
} from "../src/ai/finalResponseComposer.js";
import {
  getFinalResponseModel,
  getImageGenerationModel,
  getRouterModel,
  getSupervisorModel,
  getVisionModel
} from "../src/ai/modelRegistry.js";
import { getAgentsForIntent } from "../src/agents/agentRegistry.js";

const catVision = {
  assets: [{
    analysis: {
      main_subject: "gatito gris acostado panza arriba sobre una cama",
      product_type: "",
      visible_text: "",
      brand_or_labels: "",
      objects_detected: ["gato", "cama"],
      confidence: 0.92
    }
  }]
};

test("cat image without commercial context does not receive purchase advice", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "pet_photo" },
    specialistResults: { vision: catVision },
    currentUserMessage: "",
    currentMediaSummary: catVision
  });

  assert.match(response.text, /gatito|gato|mascota/);
  assert.doesNotMatch(response.text, /modelo exacto|garant[ií]a|condiciones antes/i);
});

test("cat image after price context repairs incompatible specialist output", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "price_review" },
    specialistResults: {
      vision: catVision,
      text: "Veo gato. Si es para compra, revisaria modelo exacto, garantia y condiciones antes de decidir."
    },
    currentUserMessage: "",
    currentMediaSummary: catVision
  });

  assert.equal(response.repaired, true);
  assert.match(response.text, /gatito|gato|mascota/);
  assert.doesNotMatch(response.text, /modelo exacto|garantia|garantía|condiciones/i);
});

test("clear technical text question gets direct explanation instead of generic fallback", () => {
  const answer = composeGeneralTextAnswer("Como se hace un motor a inducción??");

  assert.match(answer, /campo magnético|campo magnetico/i);
  assert.match(answer, /estator/i);
  assert.doesNotMatch(answer, /qué necesitas que haga con esto|que necesitas que haga con esto/i);
});

test("simple greeting gets a warm assistant intro", () => {
  const answer = composeGeneralTextAnswer("hola");

  assert.match(answer, /Hola|Yishido/i);
  assert.match(answer, /preguntas|fotos|audios/i);
  assert.doesNotMatch(answer, /que necesitas que haga con esto/i);
});

test("capability question explains useful WhatsApp actions", () => {
  const answer = composeGeneralTextAnswer("que puedes hacer?");

  assert.match(answer, /listas|recordatorios|imagenes|precios/i);
  assert.match(answer, /solo cuando/i);
});

test("generic help request asks for the artifact and goal, not a bot fallback", () => {
  const answer = composeGeneralTextAnswer("ayudame con esto");

  assert.match(answer, /Mandame|foto|audio|texto/i);
  assert.match(answer, /explicarlo|resumirlo|recordatorio/i);
  assert.doesNotMatch(answer, /que necesitas que haga con esto/i);
});

test("clear audio transcript question gets direct explanation", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "general" },
    specialistResults: {
      text: composeGeneralTextAnswer("[Audio transcrito]: Como se hace un motor a inducción?")
    },
    currentUserMessage: "[Audio transcrito]: Como se hace un motor a inducción?"
  });

  assert.match(response.text, /motor de inducción|motor de induccion/i);
  assert.match(response.text, /rotor/i);
});

test("image without instruction asks a specific image question", () => {
  const response = composeFinalResponse({
    supervisorPlan: { intent: "unknown_image_request" },
    specialistResults: { vision: catVision },
    currentUserMessage: "",
    currentMediaSummary: catVision
  });

  assert.match(response.text, /describir|caption|edición|edicion/);
  assert.doesNotMatch(response.text, /qué necesitas que haga con esto|que necesitas que haga con esto/i);
});

test("product photo and tartar question uses product advisor style", () => {
  const dentalVision = {
    assets: [{
      analysis: {
        main_subject: "pasta dental",
        product_type: "pasta dental",
        visible_text: "Fresh mint toothpaste",
        brand_or_labels: "Dental Care",
        objects_detected: ["empaque", "pasta dental"],
        confidence: 0.88
      }
    }]
  };
  const response = composeFinalResponse({
    supervisorPlan: { intent: "product_advice" },
    specialistResults: { vision: dentalVision },
    currentUserMessage: "me sirve para sarro?",
    currentMediaSummary: dentalVision
  });

  assert.match(response.text, /sarro|tartar/i);
  assert.match(response.text, /empaque/i);
  assert.doesNotMatch(response.text, /gato|gatito/i);
});

test("product photo and expensive question keeps price review", () => {
  const priceVision = {
    assets: [{
      analysis: {
        main_subject: "parlante JBL",
        product_type: "parlante",
        visible_text: "$55.99",
        brand_or_labels: "JBL",
        objects_detected: ["parlante", "precio"],
        confidence: 0.9
      }
    }]
  };
  const response = composeFinalResponse({
    supervisorPlan: { intent: "price_review" },
    specialistResults: { vision: priceVision },
    currentUserMessage: "esta caro?",
    currentMediaSummary: priceVision
  });

  assert.match(response.text, /\$55\.99|precio visible/i);
});

test("sanity check blocks generic fallback for clear question", () => {
  const sanity = validateSpecialistOutputAgainstIntent({
    supervisorPlan: { intent: "general" },
    specialistResults: { text: "Entendido. ¿Qué necesitas que haga con esto?" },
    currentUserMessage: "Como se hace un motor a inducción??",
    responseText: "Entendido. ¿Qué necesitas que haga con esto?"
  });

  assert.equal(sanity.ok, false);
  assert.equal(sanity.reasons.includes("generic_fallback_for_clear_question"), true);
});

test("long response splits naturally", () => {
  const parts = splitConversationalText([
    "Sí, te explico simple.",
    "Un motor de inducción funciona creando un campo magnético giratorio en el estator. Ese campo induce corriente en el rotor y por eso gira sin necesitar escobillas.",
    "Para construir uno necesitas bobinas, núcleo laminado, rotor, eje, rodamientos y una carcasa estable."
  ].join("\n\n"), { maxChars: 90 });

  assert.equal(parts.length > 1, true);
  assert.equal(parts.length <= 4, true);
});

test("fast ack sends for multiple images and skips simple text", () => {
  const imageAck = shouldSendFastAck({
    env: { FAST_ACK_ENABLED: "true" },
    supervisorPlan: { intent: "multi_image_price_review" },
    userTurn: { image_count: 3, audio_count: 0 }
  });
  const textAck = shouldSendFastAck({
    env: { FAST_ACK_ENABLED: "true" },
    supervisorPlan: { intent: "general" },
    userTurn: { image_count: 0, audio_count: 0, current_turn_text: "hola" }
  });

  assert.equal(imageAck, true);
  assert.equal(buildFastAckText({ intent: "multi_image_price_review" }, { image_count: 3 }), "Perfecto, estoy revisando los precios.");
  assert.equal(buildFastAckText({ intent: "multi_image_review" }, { image_count: 3 }), "Dame un momento, voy a revisar las imagenes.");
  assert.equal(textAck, false);
});

test("model registry falls back for invalid model ids", () => {
  assert.equal(getSupervisorModel({ SUPERVISOR_MODEL: "gpt-5.5-mini" }), "gpt-5.4-mini");
  assert.equal(getRouterModel({ ROUTER_MODEL: "gpt-5.5-nano" }), "gpt-5.4-nano");
  assert.equal(getFinalResponseModel({ FINAL_RESPONSE_MODEL: "" }), "gpt-5.4-mini");
  assert.equal(getVisionModel({ VISION_MODEL: "gpt-4o-mini" }), "gpt-5.4-mini");
  assert.equal(getImageGenerationModel({ OPENAI_IMAGE_MODEL: "gpt-image-2" }), "gpt-image-2");
});

test("agent registry exposes formal specialists for intents", () => {
  const priceAgents = getAgentsForIntent("price_review", {
    SPECIALIST_DEFAULT_MODEL: "gpt-5.4-mini"
  });

  assert.equal(priceAgents.some((agent) => agent.name === "price_review"), true);
  assert.equal(priceAgents[0].model, "gpt-5.4-mini");
});
