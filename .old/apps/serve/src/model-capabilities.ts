import type { ModelCapabilities } from "@mikan-919/oriel-contracts";

/** pi-aiの`Model`が持つ、自動検査可能な4 fieldだけを扱う。 */
export interface ModelCapabilityMetadata {
  reasoning: boolean;
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
}

/**
 * ADR 0009の不一致判定。`capabilities`未設定は制約なしとして常に満たす。
 */
export function modelSatisfiesCapabilities(
  capabilities: ModelCapabilities | undefined,
  model: ModelCapabilityMetadata,
): boolean {
  if (capabilities === undefined) {
    return true;
  }

  if (capabilities.reasoning === true && !model.reasoning) {
    return false;
  }

  if (capabilities.image === true && !model.input.includes("image")) {
    return false;
  }

  if (
    capabilities.minContextWindow !== undefined &&
    model.contextWindow < capabilities.minContextWindow
  ) {
    return false;
  }

  if (
    capabilities.minMaxTokens !== undefined &&
    model.maxTokens < capabilities.minMaxTokens
  ) {
    return false;
  }

  return true;
}
