import { loadTargetBaseExecutionConfig } from "./execution-config";
import type { GitHubTargetBaseReader } from "./github-approval-ports";
import {
  modelSatisfiesCapabilities,
  type ModelCapabilityMetadata,
} from "./model-capabilities";

/**
 * 対話Job(what_confirmation/how_confirmation)向けのcapability gate。
 *
 * ADR 0009のとおり、`.oriel.yaml`が存在しない・読めない・parse不能な場合は
 * これまでどおり制約なしとして進める。実装Job・PR対応Jobと異なり、対話Jobは
 * `.oriel.yaml`の存在そのものをこれまで要求していないため、読めないことを
 * fail closedの理由にしない。`modelCapabilities`を読めて、かつ満たさない場合
 * だけ拒否する。
 */
export async function conversationJobSatisfiesModelCapabilities(
  createPorts: () => Promise<GitHubTargetBaseReader | null>,
  getModelMetadata: () => Promise<ModelCapabilityMetadata | null>,
): Promise<boolean> {
  const ports = await createPorts();

  if (ports === null) {
    return true;
  }

  const targetBase = await ports.readTargetBase();

  if (targetBase === null) {
    return true;
  }

  const execution = await loadTargetBaseExecutionConfig(ports, targetBase.oid);

  if (execution.status === "refused") {
    return true;
  }

  if (execution.config.modelCapabilities === undefined) {
    return true;
  }

  const metadata = await getModelMetadata();

  return (
    metadata !== null &&
    modelSatisfiesCapabilities(execution.config.modelCapabilities, metadata)
  );
}
