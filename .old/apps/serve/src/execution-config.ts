import {
  parseExecutionConfig,
  type ExecutionConfig,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

/** 取り込み先branchの内容を読む境界。読めない場合は不存在と区別する。 */
export interface ExecutionConfigPort {
  readTargetBaseFile(
    oid: string,
    path: string,
  ): Promise<
    | { status: "present"; content: string }
    | { status: "absent" }
    | { status: "unknown" }
  >;
}

export type ExecutionConfigRefusalReason =
  | "execution_config_missing"
  | "execution_config_invalid"
  | "execution_config_unreadable";

export type ExecutionConfigLoad =
  | { status: "loaded"; config: ExecutionConfig }
  | { status: "refused"; reason: ExecutionConfigRefusalReason };

/**
 * 実行設定を取り込み先branchの版から読む。
 *
 * ROADMAPのとおり、実行時に信頼するのはPull Requestのtarget branch上にある設定
 * だけであり、Agentが作業branchで変更した設定はそのJobへ適用しない。欠落、
 * 読取不能、schema違反はいずれもworker開始前にfail closedにする。
 */
export async function loadTargetBaseExecutionConfig(
  port: ExecutionConfigPort,
  targetBaseOid: string,
): Promise<ExecutionConfigLoad> {
  const file = await port
    .readTargetBaseFile(targetBaseOid, identity.executionConfigFileName)
    .catch(() => ({ status: "unknown" }) as const);

  if (file.status === "unknown") {
    return { status: "refused", reason: "execution_config_unreadable" };
  }

  if (file.status === "absent") {
    return { status: "refused", reason: "execution_config_missing" };
  }

  const parsed = parseExecutionConfig(file.content);

  return parsed.status === "parsed"
    ? { status: "loaded", config: parsed.config }
    : { status: "refused", reason: "execution_config_invalid" };
}
