import test from "node:test";
import assert from "node:assert/strict";

import { estimateOpenAIUsageCost, extractOpenAIUsage } from "../src/ai/usageCost.js";

test("OpenAI usage cost estimates text model interactions from response usage", () => {
  const usage = extractOpenAIUsage({
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      total_tokens: 1200,
      input_tokens_details: { cached_tokens: 100 }
    }
  });
  const cost = estimateOpenAIUsageCost({
    model: "gpt-5.4",
    usage
  });

  assert.equal(cost.inputTokens, 1000);
  assert.equal(cost.cachedInputTokens, 100);
  assert.equal(cost.outputTokens, 200);
  assert.equal(cost.estimatedUsd, 0.005275);
});

test("OpenAI usage cost estimates nano model interactions", () => {
  const cost = estimateOpenAIUsageCost({
    model: "gpt-5.4-nano",
    usage: { inputTokens: 1000, outputTokens: 100 }
  });

  assert.equal(cost.estimatedUsd, 0.000325);
  assert.equal(cost.pricing.inputUsdPerMillion, 0.20);
  assert.equal(cost.pricing.outputUsdPerMillion, 1.25);
});
