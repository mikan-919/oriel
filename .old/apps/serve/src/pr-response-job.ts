import type {
  GitHubRepository,
  PrResponseTrigger,
} from "@mikan-919/oriel-contracts";

import type { DeviceTokenStore } from "./device-registration";
import {
  loadTargetBaseExecutionConfig,
  type ExecutionConfigPort,
  type ExecutionConfigRefusalReason,
} from "./execution-config";
import type { GitCredential } from "./git";
import type { ApprovalReconciliation } from "./implementation-admission";
import {
  modelSatisfiesCapabilities,
  type ModelCapabilityMetadata,
} from "./model-capabilities";
import type { ModelStreamProvider } from "./model-stream";
import { createRelayOwnershipConnection } from "./ownership-connection";
import {
  prResponseCheckFailureLimit,
  type PrResponseCheckFailureStore,
} from "./pr-response-check-failures";
import {
  startPrResponseWorker,
  type PrResponseWorker,
  type PrResponseWorkerRefusalReason,
  type StartPrResponseWorkerOptions,
  type StartPrResponseWorkerResult,
} from "./pr-response-worker";

/** target baseの現在値と実行設定ファイルを読む境界。 */
export interface PrResponseExecutionConfigPorts extends ExecutionConfigPort {
  readTargetBase(): Promise<{ ref: string; oid: string } | null>;
}

/** checkpoint送信直前の再調停。対象PRが開いたままheadが変わっていないかを見る。 */
export interface PrResponseReconciliationPorts {
  isPullRequestOpenWithHead(input: {
    prNumber: number;
    headRef: string;
  }): Promise<boolean | null>;
}

/** 収束できなかった場合の報告、および進捗ackのcomment投稿。 */
export interface PrResponseReportPorts {
  createComment(input: { prNumber: number; body: string }): Promise<boolean>;
}

export interface StartPrResponseJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  heartbeatStopMs: number;
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  resolveCredential: () => Promise<GitCredential | null>;
  model: { provider: string; id: string };
  modelProvider: ModelStreamProvider;
  /** ADR 0009のcapability gateが照合する、選択済みmodelのメタデータ。 */
  getModelCapabilities: () => Promise<ModelCapabilityMetadata | null>;
  createExecutionConfigPorts: () => Promise<PrResponseExecutionConfigPorts | null>;
  createReconciliationPorts: () => Promise<PrResponseReconciliationPorts | null>;
  createReportPorts: () => Promise<PrResponseReportPorts | null>;
  checkFailures: PrResponseCheckFailureStore;
  prNumber: number;
  headRef: string;
  headOid: string;
  githubIssueNumber: number;
  approvalFingerprint: string;
  trigger: PrResponseTrigger;
  startWorker?: (
    options: StartPrResponseWorkerOptions,
  ) => Promise<StartPrResponseWorkerResult>;
}

export interface StartPrResponseJobRefusal {
  status: "refused";
  reason:
    | ExecutionConfigRefusalReason
    | PrResponseWorkerRefusalReason
    | "device_not_registered"
    | "job_ownership_not_acquired"
    | "branch_not_exclusive"
    | "execution_config_ports_unavailable"
    | "target_base_unavailable"
    | "ownership_not_current"
    | "model_capability_mismatch";
}

export type StartPrResponseJobResult =
  | {
      status: "started";
      jobId: string;
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): Promise<void>;
      requestStop(): void;
    }
  | StartPrResponseJobRefusal;

/**
 * PR対応Jobの製品経路。[ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)
 * のとおり、実装Jobと同じbranch排他キーを取得してから、既に開いているPull Request
 * のcanonicalブランチの現在の先端でworkerを開始する。承認そのものは再判定せず、
 * WHAT/HOWも読まない。
 */
export async function startPrResponseJob({
  relayOrigin,
  tokenStore,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  heartbeatStopMs,
  repositoryRoot,
  worktreesRoot,
  remote,
  resolveCredential,
  model,
  modelProvider,
  getModelCapabilities,
  createExecutionConfigPorts,
  createReconciliationPorts,
  createReportPorts,
  checkFailures,
  prNumber,
  headRef,
  headOid,
  githubIssueNumber,
  approvalFingerprint,
  trigger,
  startWorker = startPrResponseWorker,
}: StartPrResponseJobOptions): Promise<StartPrResponseJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const jobId = `pr-response:${repositoryId}:${githubIssueNumber}:${approvalFingerprint}`;
  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  const refuse = (
    reason: StartPrResponseJobRefusal["reason"],
  ): StartPrResponseJobRefusal => {
    ownership.release();
    return { status: "refused", reason };
  };

  // ADR 0002/0007: 実装Jobと同じキーを共有し、同じcanonicalブランチへの書き込みを直列化する。
  const branchKey = `${repositoryId}/${headRef}`;
  const branchLeaseId = await ownership.acquireBranchExclusivity(branchKey);

  if (branchLeaseId === null) {
    return refuse("branch_not_exclusive");
  }

  const configPorts = await createExecutionConfigPorts();

  if (configPorts === null) {
    return refuse("execution_config_ports_unavailable");
  }

  const targetBase = await configPorts.readTargetBase();

  if (targetBase === null) {
    return refuse("target_base_unavailable");
  }

  const execution = await loadTargetBaseExecutionConfig(
    configPorts,
    targetBase.oid,
  );

  if (execution.status === "refused") {
    return refuse(execution.reason);
  }

  if (execution.config.modelCapabilities !== undefined) {
    const metadata = await getModelCapabilities();

    if (
      metadata === null ||
      !modelSatisfiesCapabilities(execution.config.modelCapabilities, metadata)
    ) {
      return refuse("model_capability_mismatch");
    }
  }

  const current =
    (await ownership.hasCurrentJobOwnership({
      jobId,
      jobLeaseId,
      repository,
      issueNumber: githubIssueNumber,
    })) &&
    (await ownership.hasCurrentBranchExclusivity(branchKey, branchLeaseId));

  if (!current) {
    return refuse("ownership_not_current");
  }

  const reconcileApproval = async (): Promise<ApprovalReconciliation> => {
    const ports = await createReconciliationPorts();

    if (ports === null) {
      return { status: "unknown" };
    }

    const open = await ports
      .isPullRequestOpenWithHead({ prNumber, headRef })
      .catch(() => null);

    if (open === null) {
      return { status: "unknown" };
    }

    return open
      ? { status: "current", approvalFingerprint }
      : { status: "changed" };
  };

  const worker = await startWorker({
    databasePath,
    repositoryRoot,
    worktreesRoot,
    remote,
    harnessEntry,
    ownership,
    binding: {
      jobId,
      jobLeaseId,
      branchLeaseId,
      branchKey,
      approvalFingerprint,
      canonicalBranch: headRef,
      repository,
      issueNumber: githubIssueNumber,
    },
    start: {
      type: "pr_response.start",
      jobId,
      jobLeaseId,
      branchLeaseId,
      approvalFingerprint,
      canonicalBranch: headRef,
      canonicalOid: headOid,
      prNumber,
      model,
      trigger,
      verification: execution.config.execution.verification.map((command) => [
        ...command,
      ]),
    },
    modelProvider,
    reconcileApproval,
    resolveCredential,
    release: () => {
      ownership.release();
    },
  });

  if (worker.status === "refused") {
    return refuse(worker.reason);
  }

  return {
    status: "started",
    jobId,
    finished: worker.finished.then(() =>
      afterCompletion({
        worker,
        trigger,
        prNumber,
        repositoryId,
        canonicalBranch: headRef,
        checkFailures,
        createReportPorts,
      }),
    ),
    jobStatus: worker.jobStatus,
    close: worker.close,
    requestStop: worker.requestStop,
  };
}

/**
 * worker終了後の報告。ADR 0007のとおり、review/comment triggerでは常にackを
 * 投稿して「対応済み」の目印を残す。check_failure triggerでは、この試行で
 * 検証済みの修正を送れなかった場合だけ連続失敗回数を進め、上限に達したら
 * 一度だけ報告する。
 *
 * ponytail: comment投稿はissue-comments.tsのような冪等outboxを持たない
 * fire-and-forgetとする。crash直後の再送でcommentが重複する可能性はあるが、
 * 対象はPRへの人間向け報告commentであり、二重投稿の実害は小さい。問題になれば
 * issue-comments.tsと同じoperation markerパターンへ寄せる。
 */
async function afterCompletion({
  worker,
  trigger,
  prNumber,
  repositoryId,
  canonicalBranch,
  checkFailures,
  createReportPorts,
}: {
  worker: PrResponseWorker;
  trigger: PrResponseTrigger;
  prNumber: number;
  repositoryId: number;
  canonicalBranch: string;
  checkFailures: PrResponseCheckFailureStore;
  createReportPorts: () => Promise<PrResponseReportPorts | null>;
}): Promise<void> {
  const resolved = worker.jobStatus() === "completed";

  if (trigger.kind !== "check_failure") {
    const ports = await createReportPorts().catch(() => null);

    await ports
      ?.createComment({
        prNumber,
        body: resolved
          ? "Pushed an update addressing the feedback above."
          : "Attempted to address the feedback above, but could not push a verified fix. A human needs to look at this.",
      })
      .catch(() => false);

    return;
  }

  if (resolved) {
    return;
  }

  const count = checkFailures.increment(
    repositoryId,
    canonicalBranch,
    trigger.checkName,
  );

  if (count < prResponseCheckFailureLimit) {
    return;
  }

  const ports = await createReportPorts().catch(() => null);

  await ports
    ?.createComment({
      prNumber,
      body: `Stopped automatic fixes for the \`${trigger.checkName}\` check after ${count} failed attempts. A human needs to look at this.`,
    })
    .catch(() => false);
}
