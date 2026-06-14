export const CUSTOMER_CONVERSATION_PROFILE = {
  id: "whatsapp_reception_v1",
  locale: "es",
  source: {
    type: "anonymized_real_conversation_csv_summary",
    conversationFiles: 9,
    totalRows: 203,
    textRows: 168
  },
  priorities: [
    "answer_the_clear_request_first",
    "use_recent_context_without_reasking",
    "ask_one_missing_detail_at_a_time",
    "keep_whatsapp_replies_short_and_warm",
    "never_send_generic_meta_menus_for_clear_requests"
  ],
  observedPatterns: {
    greeting: "Many users start with short greetings before the actual request.",
    appointment: "Appointment and scheduling language is common and should be handled naturally.",
    acknowledgement: "Users often confirm with listo, ok, gracias, dale or perfecto.",
    fragmentedTurns: "Users split intent across multiple short messages, audio, images and follow-ups.",
    correction: "Users may correct or add details after the first request."
  },
  tone: {
    warmth: "friendly_reception",
    directness: "high",
    verbosity: "short_but_useful",
    style: [
      "natural WhatsApp Spanish",
      "no robotic menu",
      "no formal ticket language unless needed",
      "no marketing framing unless explicitly requested"
    ]
  },
  replyRules: [
    "If the user made a clear request, respond directly before asking anything.",
    "If details are missing, ask only the next necessary detail.",
    "If the user is booking or asking for an appointment, collect date, time, name and service/context.",
    "If the user sends media with text or audio, treat text/audio as the intent and media as evidence.",
    "If OCR contains phrases like no veo la imagen, treat them as visible text, not assistant stance."
  ],
  blockedPhrases: [
    "Quieres que lo explique, lo resuma o revise algun detalle puntual?",
    "Que quieres que haga con esto?",
    "Dime si quieres que lo revise"
  ]
};

export function getCustomerConversationProfile() {
  return CUSTOMER_CONVERSATION_PROFILE;
}

export function getConversationPromptGuidance() {
  return {
    profileId: CUSTOMER_CONVERSATION_PROFILE.id,
    priorities: CUSTOMER_CONVERSATION_PROFILE.priorities,
    tone: CUSTOMER_CONVERSATION_PROFILE.tone,
    replyRules: CUSTOMER_CONVERSATION_PROFILE.replyRules,
    blockedPhrases: CUSTOMER_CONVERSATION_PROFILE.blockedPhrases
  };
}

export function inferConversationScenario(userText, intent) {
  const clean = normalizeProfileText(userText);
  const cleanIntent = normalizeProfileText(intent);

  if (/\b(cita|agendar|agenda|reservar|reserva|turno|disponible|disponibilidad)\b/.test(clean)) return "appointment";
  if (/\b(hola|buenas|buenos dias|buen dia|buenas tardes|buenas noches)\b/.test(clean) && clean.length <= 80) return "greeting";
  if (/\b(gracias|listo|ok|dale|perfecto|de una|esta bien)\b/.test(clean) && clean.length <= 80) return "acknowledgement";
  if (/\b(precio|cuanto|valor|costo|cuesta)\b/.test(clean)) return "price";
  if (cleanIntent.includes("image") || /\b(imagen|foto|captura|texto visible|lee esto|revisa esta)\b/.test(clean)) return "media_review";
  return clean ? "general_request" : "empty";
}

export function buildProfileFallbackReply(input) {
  const clean = input || {};
  const userText = String(clean.userText || "");
  const scenario = clean.scenario || inferConversationScenario(userText, clean.intent || "");

  if (scenario === "appointment") {
    return "Claro, te ayudo con la cita. Me confirmas dia, hora aproximada, nombre y que servicio o motivo necesitas?";
  }

  if (scenario === "greeting") {
    return "Hola, claro. Cuentame que necesitas y te ayudo por aqui.";
  }

  if (scenario === "acknowledgement") {
    return "Perfecto, quedo atento por si quieres agregar algo mas.";
  }

  if (scenario === "price") {
    return "Claro. Para darte una respuesta precisa, dime que producto o servicio quieres cotizar y si tienes alguna referencia o foto.";
  }

  if (scenario === "media_review") {
    return "Ya tomo la imagen como referencia. Te respondo segun lo que se ve y lo que me pediste.";
  }

  return "Claro, te ayudo. Voy con una respuesta directa segun lo que me enviaste.";
}

export function normalizeProfileText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
