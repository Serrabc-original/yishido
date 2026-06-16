const PER_MILLION = 1000000;

const TEXT_MODEL_PRICING = {
  "gpt-5.4": { input: 2.50, cachedInput: 0.25, output: 15.00 },
  "gpt-5.4-mini": { input: 0.75, cachedInput: 0.075, output: 4.50 },
  "gpt-5.4-nano": { input: 0.20, cachedInput: 0.02, output: 1.25 },
  "gpt-5.5": { input: 5.00, cachedInput: 0.50, output: 30.00 }
};

const IMAGE_MODEL_PRICING = {
  "gpt-image-2": {
    textInput: 5.00,
    cachedTextInput: 1.25,
    imageInput: 8.00,
    cachedImageInput: 2.00,
    imageOutput: 30.00
  }
};

const AUDIO_MODEL_PRICING = {
  "gpt-realtime-whisper": { minute: 0.017, second: 0.00028 }
};

export function estimateOpenAIUsageCost(params) {
  const clean = params || {};
  const model = String(clean.model || "").trim();
  const usage = normalizeUsage(clean.usage || {});
  const kind = String(clean.kind || "text");

  if (kind === "audio") {
    return estimateAudioCost(model, clean);
  }

  if (kind === "image") {
    return estimateImageCost(model, usage);
  }

  return estimateTextCost(model, usage);
}

export function extractOpenAIUsage(responseJson) {
  const usage = responseJson && responseJson.usage || {};
  return normalizeUsage(usage);
}

function estimateTextCost(model, usage) {
  const pricing = TEXT_MODEL_PRICING[model];
  if (!pricing || !hasAnyTokenUsage(usage)) return unknownCost(model, usage);
  const cachedInputTokens = usage.cachedInputTokens;
  const billableInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const inputCost = billableInputTokens / PER_MILLION * pricing.input;
  const cachedInputCost = cachedInputTokens / PER_MILLION * pricing.cachedInput;
  const outputCost = usage.outputTokens / PER_MILLION * pricing.output;

  return buildCostResult(model, usage, inputCost + cachedInputCost + outputCost, {
    inputUsdPerMillion: pricing.input,
    cachedInputUsdPerMillion: pricing.cachedInput,
    outputUsdPerMillion: pricing.output
  });
}

function estimateImageCost(model, usage) {
  const pricing = IMAGE_MODEL_PRICING[model];
  if (!pricing || !hasAnyTokenUsage(usage)) return unknownCost(model, usage);
  const cachedInputTokens = usage.cachedInputTokens;
  const billableInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const inputCost = billableInputTokens / PER_MILLION * pricing.textInput;
  const cachedInputCost = cachedInputTokens / PER_MILLION * pricing.cachedTextInput;
  const outputCost = usage.outputTokens / PER_MILLION * pricing.imageOutput;

  return buildCostResult(model, usage, inputCost + cachedInputCost + outputCost, {
    textInputUsdPerMillion: pricing.textInput,
    cachedTextInputUsdPerMillion: pricing.cachedTextInput,
    imageOutputUsdPerMillion: pricing.imageOutput
  });
}

function estimateAudioCost(model, params) {
  const pricing = AUDIO_MODEL_PRICING[model];
  const seconds = Number(params && (params.audioSeconds || params.seconds) || 0);
  if (!pricing || !Number.isFinite(seconds) || seconds <= 0) {
    return {
      model: model,
      estimatedUsd: null,
      reason: pricing ? "missing_audio_seconds" : "unknown_pricing",
      pricingSource: "openai_api_pricing_2026_06_15"
    };
  }
  return {
    model: model,
    estimatedUsd: Number((seconds * pricing.second).toFixed(8)),
    audioSeconds: seconds,
    pricing: {
      usdPerMinute: pricing.minute,
      usdPerSecond: pricing.second
    },
    pricingSource: "openai_api_pricing_2026_06_15"
  };
}

function normalizeUsage(usage) {
  const inputDetails = usage.input_tokens_details || usage.inputTokenDetails || usage.prompt_tokens_details || {};
  const outputDetails = usage.output_tokens_details || usage.outputTokenDetails || usage.completion_tokens_details || {};
  const inputTokens = Number(usage.input_tokens || usage.inputTokens || usage.prompt_tokens || 0);
  const outputTokens = Number(usage.output_tokens || usage.outputTokens || usage.completion_tokens || 0);
  const cachedInputTokens = Number(usage.cachedInputTokens || usage.cached_input_tokens || inputDetails.cached_tokens || inputDetails.cachedTokens || 0);

  return {
    inputTokens: Number.isFinite(inputTokens) ? inputTokens : 0,
    outputTokens: Number.isFinite(outputTokens) ? outputTokens : 0,
    cachedInputTokens: Number.isFinite(cachedInputTokens) ? cachedInputTokens : 0,
    reasoningTokens: Number(outputDetails.reasoning_tokens || outputDetails.reasoningTokens || 0) || 0,
    totalTokens: Number(usage.total_tokens || usage.totalTokens || inputTokens + outputTokens || 0) || 0
  };
}

function hasAnyTokenUsage(usage) {
  return Boolean(usage.inputTokens || usage.outputTokens || usage.totalTokens);
}

function buildCostResult(model, usage, estimatedUsd, pricing) {
  return {
    model: model,
    estimatedUsd: Number(estimatedUsd.toFixed(8)),
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    pricing: pricing,
    pricingSource: "openai_api_pricing_2026_06_15"
  };
}

function unknownCost(model, usage) {
  return {
    model: model,
    estimatedUsd: null,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    totalTokens: usage.totalTokens,
    reason: hasAnyTokenUsage(usage) ? "unknown_pricing" : "missing_usage",
    pricingSource: "openai_api_pricing_2026_06_15"
  };
}
