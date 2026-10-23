import type { OcxProviderConfig } from "../../types";
import { isCanonicalOpenAiForwardProvider, OPENAI_CODEX_PROVIDER_ID } from "../../providers/openai-tiers-destination";
import { clampAutoCompactTokenLimit } from "../../providers/auto-compact-budget";
import { isCodexControlPlaneModel } from "../control-plane-models";
import { pinnedNativeModelRows } from "./pinned-models";

export interface CodexControlPlaneModelCapabilities {
  contextWindow: number;
  maxInputTokens: number;
  autoCompactTokenLimit: number;
  inputModalities: string[];
  reasoningEfforts: string[];
  defaultReasoningEffort?: string;
  displayName?: string;
  description?: string;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Private capability projection; does not grant native catalog/replacement authority. */
export function codexControlPlaneModelCapabilities(
  providerName: string,
  provider: OcxProviderConfig | undefined,
  modelId: string,
  contextCap?: number,
): CodexControlPlaneModelCapabilities | undefined {
  if (providerName !== OPENAI_CODEX_PROVIDER_ID || !provider || provider.disabled === true
    || !isCodexControlPlaneModel(modelId)
    || !isCanonicalOpenAiForwardProvider({ ...provider, authMode: provider.authMode ?? "forward" })) return undefined;
  const source = pinnedNativeModelRows().find(row => row.slug === modelId);
  const pinnedWindow = positiveInteger(source?.context_window);
  if (!source || pinnedWindow === undefined) return undefined;
  // Operator windows/caps can narrow this private row, never widen the pinned capability.
  const configuredWindow = positiveInteger(provider.modelContextWindows?.[modelId])
    ?? positiveInteger(provider.contextWindow);
  const contextWindow = Math.min(pinnedWindow, configuredWindow ?? pinnedWindow, positiveInteger(contextCap) ?? pinnedWindow);
  const maxInputTokens = Math.min(contextWindow, positiveInteger(source.max_input_tokens) ?? contextWindow);
  const levels = Array.isArray(source.supported_reasoning_levels) ? source.supported_reasoning_levels : [];
  const reasoningEfforts = levels.flatMap(level => level && typeof level === "object"
    && typeof (level as { effort?: unknown }).effort === "string" ? [(level as { effort: string }).effort] : []);
  const defaultEffort = source.default_reasoning_level;
  return {
    contextWindow,
    maxInputTokens,
    autoCompactTokenLimit: clampAutoCompactTokenLimit(contextWindow, maxInputTokens, positiveInteger(provider.modelAutoCompactTokenLimits?.[modelId])),
    inputModalities: Array.isArray(source.input_modalities)
      ? source.input_modalities.filter((value): value is string => typeof value === "string") : ["text"],
    reasoningEfforts,
    ...(typeof defaultEffort === "string" && reasoningEfforts.includes(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}),
    ...(typeof source.display_name === "string" ? { displayName: source.display_name } : {}),
    ...(typeof source.description === "string" ? { description: source.description } : {}),
  };
}
