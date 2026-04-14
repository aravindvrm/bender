import type { EvalScore, EvalUsage } from "./types.js";

interface PricePoint {
  inputPer1M: number;
  outputPer1M: number;
}

const MODEL_PRICING_USD_PER_1M: Record<string, PricePoint> = {
  "openai:gpt-4o": { inputPer1M: 5, outputPer1M: 15 },
  "openai:gpt-4o-mini": { inputPer1M: 0.15, outputPer1M: 0.6 },
  "openai:gpt-4.1": { inputPer1M: 2, outputPer1M: 8 },
  "openai:gpt-4.1-mini": { inputPer1M: 0.4, outputPer1M: 1.6 },
  "anthropic:claude-sonnet-4-6-20250514": { inputPer1M: 3, outputPer1M: 15 },
  "anthropic:claude-haiku-4-5-20251001": { inputPer1M: 0.8, outputPer1M: 4 },
  "google:gemini-2.5-pro": { inputPer1M: 3.5, outputPer1M: 10.5 },
  "google:gemini-2.5-flash": { inputPer1M: 0.35, outputPer1M: 1.05 },
  "groq:llama-3.3-70b-versatile": { inputPer1M: 0.59, outputPer1M: 0.79 },
};

function pricingKey(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}:${model.trim().toLowerCase()}`;
}

function findPricePoint(provider: string, model: string): PricePoint | null {
  const key = pricingKey(provider, model);
  if (MODEL_PRICING_USD_PER_1M[key]) return MODEL_PRICING_USD_PER_1M[key];

  const entries = Object.entries(MODEL_PRICING_USD_PER_1M);
  const best = entries.find(([candidate]) => key.includes(candidate));
  return best?.[1] ?? null;
}

export function estimateCostUsd(
  provider: string,
  model: string,
  usage?: EvalUsage,
): number | null {
  if (!usage) return null;
  const price = findPricePoint(provider, model);
  if (!price) return null;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cost = (input / 1_000_000) * price.inputPer1M + (output / 1_000_000) * price.outputPer1M;
  return Number.isFinite(cost) ? Number(cost.toFixed(6)) : null;
}

export function buildEvalScore(params: {
  success: boolean;
  durationMs: number;
  usage?: EvalUsage;
  estimatedCostUsd?: number | null;
}): EvalScore {
  return {
    success: params.success ? 1 : 0,
    latencyMs: Number.isFinite(params.durationMs) ? params.durationMs : null,
    tokenUsage: typeof params.usage?.totalTokens === "number"
      ? params.usage.totalTokens
      : (typeof params.usage?.inputTokens === "number" || typeof params.usage?.outputTokens === "number")
        ? (params.usage?.inputTokens ?? 0) + (params.usage?.outputTokens ?? 0)
        : null,
    estimatedCostUsd: typeof params.estimatedCostUsd === "number" ? params.estimatedCostUsd : null,
  };
}

