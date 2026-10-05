import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import {
  loadTargetBaseExecutionConfig,
  type ExecutionConfigRefusalReason,
} from "./execution-config";
import type { GitCredential } from "./git";
import {
  approvalChangedByRead,
  readImplementationApproval,
  reconciledStateNames,
  sameApproval,
  sealCanonicalBranch,
  workflowIsFenced,
  type ApprovalReconciliation,
  type ApprovedContent,
  type ImplementationApproval,
  type ImplementationApprovalPorts,
  type ImplementationRefusalReason,
  type ReconcileApproval,
} from "./implementation-admission";
import {
  startImplementationWorker,
  type ImplementationWorker,
  type ImplementationWorkerRefusalReason,
  type StartImplementationWorkerOptions,
  type StartImplementationWorkerResult,
} from "./implementation-worker";
import type { JobOwnershipVerifier } from "./issue-comments";
import {
  moveApprovalToInProgress,
  type LinearInProgressPorts,
  type MoveToInProgressStatus,
} from "./linear-progress";
import { openServeLocalState } from "./local-state";
import {
  modelSatisfiesCapabilities,
  type ModelCapabilityMetadata,
} from "./model-capabilities";
import type { ModelStreamProvider } from "./model-stream";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { ensurePullRequest, type PullRequestPorts } from "./pull-request";
import { createPullRequestWatchStore } from "./pull-request-watch";
import { createTranscriptStore } from "./transcript-store";
import {
  reflectReviewState,
  type LinearReviewStatePorts,
} from "./linear-review-state";
import {
  returnApprovalToTriage,
  type LinearApprovalStatePorts,
  type ReturnToTriageStatus,
} from "./return-to-triage";

export interface StartImplementationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  /** 認証済みOctokitの解決。用意できない場合はnullでfail closedにする。 */
  createOctokit: () => Promise<Octokit | null>;
  /** WHATとHOWの現在値を読む境界。HOWへ届かない場合はnullでfail closedにする。 */
  createPorts: (
    octokit: Octokit,
  ) =>
    | ImplementationApprovalPorts
    | null
    | Promise<ImplementationApprovalPorts | null>;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  /** 承認されたHOWのLinear Issue。WHATはattachmentから逆引きする。 */
  linearIssueId: string;
  heartbeatStopMs: number;
  /** `serve`が持つrepositoryのclone、worktreeを置く領域、送信先remote。 */
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  /** canonicalブランチへの送信に使う、実装用途へ絞ったcredentialの解決。 */
  resolveCredential: () => Promise<GitCredential | null>;
  /**
   * `serve`が選んだ提供元とmodelの論理識別子。接続先、認証情報、互換性設定は
   * `serve`だけが持ち、harnessへは渡さない。
   */
  model: { provider: string; id: string };
  modelProvider: ModelStreamProvider;
  /** ADR 0009のcapability gateが照合する、選択済みmodelのメタデータ。 */
  getModelCapabilities: () => Promise<ModelCapabilityMetadata | null>;
  /**
   * 承認後の状態をLinearへ機械的に反映する境界。
   *
   * 承認対象の不一致ではTodoをTriageへ戻し、worker起動直後にはTodoをIn Progress
   * へ移し、Pull Request作成直後にはレビュー用stateへ反映する。credentialは
   * `serve`の内側だけで解決する。
   */
  linearApprovalState: LinearApprovalStatePorts &
    LinearInProgressPorts &
    LinearReviewStatePorts;
  /** Pull Request作成に用途を絞ったOctokitの解決。取れない場合は作成を諦める。 */
  createPullRequestOctokit: () => Promise<Octokit | null>;
  createPullRequestPorts: (
    octokit: Octokit,
  ) => PullRequestPorts | null | Promise<PullRequestPorts | null>;
  startWorker?: (
    options: StartImplementationWorkerOptions,
  ) => Promise<StartImplementationWorkerResult>;
}

export interface StartImplementationJobRefusal {
  status: "refused";
  reason:
    | ImplementationRefusalReason
    | ExecutionConfigRefusalReason
    | ImplementationWorkerRefusalReason
    | "device_not_registered"
    | "github_credentials_unavailable"
    | "linear_credentials_unavailable"
    | "job_ownership_not_acquired"
    | "branch_not_exclusive"
    | "model_capability_mismatch";
  /**
   * 承認対象の不一致で行った差し戻しの結果。
   *
   * `still_todo`はTodoのまま残ったことを表し、自動再送はしない。人間が明示した
   * 場合だけ、同じ`serve`が新しい試行IDで再試行する。
   */
  returnedToTriage?: ReturnToTriageStatus;
}

export type StartImplementationJobResult =
  | {
      status: "started";
      jobId: string;
      canonicalBranch: string;
      /** 封印した先端、または引き継いだ未検証の作業途中成果の先端。 */
      canonicalOid: string;
      adopted: boolean;
      branchLeaseId: string;
      /** worker起動直後に反映したLinear状態の結果。 */
      linearState: MoveToInProgressStatus;
      /** harnessが編集、build、test、commitを行う封印済みworktree。 */
      worktreePath: string;
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): Promise<void>;
      requestStop(): void;
    }
  | StartImplementationJobRefusal;

/**
 * 実装Jobの製品経路。
 *
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * admission順序をそのまま実行する。現在値の先行read、Job所有権とブランチ排他の
 * 取得、取得後の読み直し、`updateRefs`一回だけのatomicなbranch封印、封印後の
 * 読み直しをすべて通るまでworkerを起動しない。どれか一つでも満たせなければ、
 * ブランチ排他、Job所有権の順に返して何も起動しない。
 */
export async function startImplementationJob({
  relayOrigin,
  tokenStore,
  createOctokit,
  createPorts,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  linearIssueId,
  heartbeatStopMs,
  repositoryRoot,
  worktreesRoot,
  remote,
  resolveCredential,
  model,
  modelProvider,
  getModelCapabilities,
  linearApprovalState,
  createPullRequestOctokit,
  createPullRequestPorts,
  startWorker = startImplementationWorker,
}: StartImplementationJobOptions): Promise<StartImplementationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const octokit = await createOctokit();

  if (octokit === null) {
    return { status: "refused", reason: "github_credentials_unavailable" };
  }

  const ports = await createPorts(octokit);

  if (ports === null) {
    return { status: "refused", reason: "linear_credentials_unavailable" };
  }

  const target = { repositoryId, linearIssueId };
  // 手順2と3: 現在値だけを読み、承認指紋、canonicalブランチ、Job識別子を導く。
  const first = await readImplementationApproval(ports, target);

  if (first.status === "refused") {
    return { status: "refused", reason: first.reason };
  }

  const approval = first.approval;
  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId: approval.jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  const refuse = (
    reason: StartImplementationJobRefusal["reason"],
  ): StartImplementationJobRefusal => {
    ownership.release();
    return { status: "refused", reason };
  };

  /**
   * 承認対象の不一致でのTriage差し戻し。
   *
   * ADR 0003のとおり、差し戻せるのは現在のJob所有権を確認した`serve`だけであり、
   * 差し戻しを終えてからブランチ排他、Job所有権の順に返す。リレー、Agent、
   * harnessはこの経路を持たない。
   */
  const returnToTriage = async (
    jobLeaseId: string,
  ): Promise<ReturnToTriageStatus> => {
    const database = openServeLocalState(databasePath);

    try {
      const status = await returnApprovalToTriage({
        database,
        ownership,
        ports: linearApprovalState,
        target: {
          jobId: approval.jobId,
          jobLeaseId,
          repository,
          issueNumber: approval.githubIssueNumber,
          linearIssueId: approval.linearIssueId,
          approvalFingerprint: approval.approvalFingerprint,
        },
      });

      createTranscriptStore(database).append({
        jobId: approval.jobId,
        repository,
        kind: "external.returned_to_triage",
        content: JSON.stringify({ status }),
      });

      return status;
    } finally {
      database.close();
    }
  };

  const refuseApprovalChanged = async (
    jobLeaseId: string,
  ): Promise<StartImplementationJobRefusal> => {
    const returnedToTriage = await returnToTriage(jobLeaseId);

    ownership.release();

    return { status: "refused", reason: "approval_changed", returnedToTriage };
  };

  /**
   * 所有権を取った後の読み直しの拒否。
   *
   * 現在値から承認の変更と確定できる観測はTriageへの差し戻しへ送り、読めなかった
   * だけの提供元障害はそのまま拒否する。
   */
  const refuseRead = (
    reason: ImplementationRefusalReason,
    jobLeaseId: string,
  ): Promise<StartImplementationJobRefusal> | StartImplementationJobRefusal =>
    approvalChangedByRead(reason)
      ? refuseApprovalChanged(jobLeaseId)
      : refuse(reason);

  // 手順4: ブランチ排他より先に、Workflow全体の置換隔離を事前確認する。
  if (
    !workflowIsFenced(
      await ownership.inspectOwnership(),
      approval,
      repositoryId,
    )
  ) {
    return refuse("workflow_not_fenced");
  }

  const branchKey = `${repositoryId}/${approval.canonicalBranch}`;
  const branchLeaseId = await ownership.acquireBranchExclusivity(branchKey);

  if (branchLeaseId === null) {
    return refuse("branch_not_exclusive");
  }

  // 手順5: 所有権を取ってからもう一度読み、同じ現在値であることを確かめる。
  const second = await readImplementationApproval(ports, target);

  if (second.status === "refused") {
    return refuseRead(second.reason, jobLeaseId);
  }

  const canonicalBefore = await ports.readRef(approval.canonicalRef);
  // 引き継ぎ候補では、取り込み先OIDの前進だけは承認を失効させない。
  const adopting = canonicalBefore.status === "present";

  if (
    !sameApproval(approval, second.approval, {
      allowTargetBaseAdvance: adopting,
    })
  ) {
    return refuseApprovalChanged(jobLeaseId);
  }

  // 手順6と7: 不存在なら比較条件付き作成、既存なら同じ承認指紋の引き継ぎ。
  const sealed = await sealCanonicalBranch(ports, approval, canonicalBefore);

  if (sealed.status === "refused") {
    return sealed.reason === "approval_changed"
      ? refuseApprovalChanged(jobLeaseId)
      : refuse(sealed.reason);
  }

  // 手順8: 封印後にもう一度読み、すべて一致したときだけworkerを開始する。
  const third = await readImplementationApproval(ports, target);

  if (third.status === "refused") {
    return refuseRead(third.reason, jobLeaseId);
  }

  if (
    !sameApproval(approval, third.approval, {
      allowTargetBaseAdvance: adopting,
    })
  ) {
    return refuseApprovalChanged(jobLeaseId);
  }

  const canonical = await ports.readRef(approval.canonicalRef);

  // 封印または引き継ぎで確認した先端のままであることも確かめる。
  if (canonical.status !== "present" || canonical.oid !== sealed.canonicalOid) {
    return refuse(
      adopting ? "branch_adoption_unavailable" : "branch_seal_result_unknown",
    );
  }

  /**
   * 実行設定は、封印後の読み直しで確認した取り込み先の版だけを信頼する。
   *
   * ROADMAPのとおり、`schemaVersion: 1`、`execution.backend: worktree`、
   * `execution.autonomous: true`を明示した場合だけ自立Jobを開始でき、検証command
   * もこの設定だけを正本とする。欠落、未知field、未知version、読取不能はすべて
   * worker開始前にfail closedにする。
   */
  const execution = await loadTargetBaseExecutionConfig(
    ports,
    third.approval.targetBaseOid,
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

  // worker開始直前に、現在のJob・ブランチ取得IDと置換隔離を明示して再確認する。
  const current =
    (await ownership.hasCurrentJobOwnership({
      jobId: approval.jobId,
      jobLeaseId,
      repository,
      issueNumber: approval.githubIssueNumber,
    })) &&
    (await ownership.hasCurrentBranchExclusivity(branchKey, branchLeaseId));

  if (!current) {
    return refuse("ownership_not_current");
  }

  if (
    !workflowIsFenced(
      await ownership.inspectOwnership(),
      approval,
      repositoryId,
    )
  ) {
    return refuse("workflow_not_fenced");
  }

  const worker = await startWorker({
    databasePath,
    repositoryRoot,
    worktreesRoot,
    remote,
    harnessEntry,
    ownership,
    binding: {
      jobId: approval.jobId,
      jobLeaseId,
      branchLeaseId,
      branchKey,
      approvalFingerprint: approval.approvalFingerprint,
      canonicalBranch: approval.canonicalBranch,
      repository,
      issueNumber: approval.githubIssueNumber,
    },
    start: {
      type: "implementation.start",
      jobId: approval.jobId,
      jobLeaseId,
      branchLeaseId,
      approvalFingerprint: approval.approvalFingerprint,
      canonicalBranch: approval.canonicalBranch,
      canonicalOid: canonical.oid,
      adopted: sealed.status === "adopted",
      model,
      // 封印後の読みで一致したWHAT/HOWだけをworkerへ渡す。保存はしない。
      what: { title: third.content.whatTitle, body: third.content.whatBody },
      how: {
        title: third.content.howTitle,
        description: third.content.howDescription,
      },
      verification: execution.config.execution.verification.map((command) => [
        ...command,
      ]),
    },
    // 引き継ぎで統合する取り込み先と、封印後の読みで確認したその現在OID。
    targetBase: {
      ref: third.approval.targetBaseRef,
      oid: third.approval.targetBaseOid,
    },
    modelProvider,
    // 送信の直前に、現在値から承認指紋を導き直す。
    reconcileApproval: () => reconcileApproval(ports, target, approval),
    resolveCredential,
    // 実行中に確定した承認の変更も、同じ差し戻し経路へ送る。
    onApprovalChanged: () => returnToTriage(jobLeaseId),
    release: () => {
      ownership.release();
    },
  });

  // workerが統合または再確認で止まった場合も、同じ規則で所有権を返す。
  if (worker.status === "refused") {
    return worker.reason === "approval_changed"
      ? refuseApprovalChanged(jobLeaseId)
      : refuse(worker.reason);
  }

  /**
   * ADR 0005とROADMAPのとおり、worker起動直後にTodoをIn Progressへ移す。
   *
   * 承認後の機械的な反映であり、実行承認そのものではない。現在のJob所有権、
   * 承認指紋、現在stateを確認した`serve`だけが送り、結果不明は再読で収束させる。
   */
  const database = openServeLocalState(databasePath);
  let linearState: MoveToInProgressStatus;

  try {
    linearState = await moveApprovalToInProgress({
      database,
      ownership,
      ports: linearApprovalState,
      reconcileApproval: () => reconcileApproval(ports, target, approval),
      target: {
        jobId: approval.jobId,
        jobLeaseId,
        repository,
        issueNumber: approval.githubIssueNumber,
        linearIssueId: approval.linearIssueId,
        approvalFingerprint: approval.approvalFingerprint,
      },
    });

    createTranscriptStore(database).append({
      jobId: approval.jobId,
      repository,
      kind: "external.linear_in_progress",
      content: JSON.stringify({ status: linearState }),
    });
  } finally {
    database.close();
  }

  return {
    status: "started",
    jobId: approval.jobId,
    canonicalBranch: approval.canonicalBranch,
    canonicalOid: canonical.oid,
    adopted: sealed.status === "adopted",
    branchLeaseId,
    linearState,
    worktreePath: worker.worktreePath,
    finished: worker.finished.then(() =>
      afterCompletion({
        worker,
        approval,
        jobLeaseId,
        repository,
        databasePath,
        linearApprovalState,
        createPullRequestOctokit,
        createPullRequestPorts,
        reconcileApproval: () => reconcileApproval(ports, target, approval),
        ownership,
        what: third.content,
      }),
    ),
    jobStatus: worker.jobStatus,
    close: worker.close,
    requestStop: worker.requestStop,
  };
}

/**
 * worker終了後、実装が完了していればPull Requestを一意に作る。
 *
 * ADR 0004/0005のとおり、実装中はPull Requestを作らず、Job所有権接続がまだ
 * 生きている間だけ行う。ここで確定しなかった場合の再試行は、PR対応Job(将来の
 * issue)の範囲とする。
 *
 * ponytail: 失敗時の自動リトライは持たない。ownership接続はこのJobの寿命でだけ
 * 有効なため、ここで確定できなければ人間による再実行を待つ。
 */
async function afterCompletion({
  worker,
  approval,
  jobLeaseId,
  repository,
  databasePath,
  linearApprovalState,
  createPullRequestOctokit,
  createPullRequestPorts,
  reconcileApproval,
  ownership,
  what,
}: {
  worker: ImplementationWorker;
  approval: ImplementationApproval;
  jobLeaseId: string;
  repository: GitHubRepository;
  databasePath: string;
  linearApprovalState: LinearApprovalStatePorts &
    LinearInProgressPorts &
    LinearReviewStatePorts;
  createPullRequestOctokit: () => Promise<Octokit | null>;
  createPullRequestPorts: (
    octokit: Octokit,
  ) => PullRequestPorts | null | Promise<PullRequestPorts | null>;
  reconcileApproval: ReconcileApproval;
  ownership: JobOwnershipVerifier;
  what: ApprovedContent;
}): Promise<void> {
  if (worker.jobStatus() !== "completed") {
    return;
  }

  const octokit = await createPullRequestOctokit().catch(() => null);

  if (octokit === null) {
    return;
  }

  const pullRequestPorts = await Promise.resolve(
    createPullRequestPorts(octokit),
  ).catch(() => null);

  if (pullRequestPorts === null) {
    return;
  }

  const ensured = await ensurePullRequest({
    ownership,
    ports: pullRequestPorts,
    reconcileApproval,
    target: {
      jobId: approval.jobId,
      jobLeaseId,
      repository,
      issueNumber: approval.githubIssueNumber,
      approvalFingerprint: approval.approvalFingerprint,
      head: approval.canonicalBranch,
      base: approval.targetBaseRef.replace(/^refs\/heads\//, ""),
      title: what.whatTitle,
      body: `Closes #${approval.githubIssueNumber}`,
    },
  });

  const database = openServeLocalState(databasePath);

  try {
    createTranscriptStore(database).append({
      jobId: approval.jobId,
      repository,
      kind: "external.pull_request",
      content: JSON.stringify({
        status: ensured.status,
        number: ensured.number,
      }),
    });

    if (ensured.number === null) {
      return;
    }

    const reviewState = await reflectReviewState({
      database,
      ownership,
      ports: linearApprovalState,
      reconcileApproval,
      target: {
        jobId: approval.jobId,
        jobLeaseId,
        repository,
        issueNumber: approval.githubIssueNumber,
        linearIssueId: approval.linearIssueId,
        approvalFingerprint: approval.approvalFingerprint,
      },
    });

    createTranscriptStore(database).append({
      jobId: approval.jobId,
      repository,
      kind: "external.review_state",
      content: JSON.stringify({ status: reviewState }),
    });

    createPullRequestWatchStore(database).upsert({
      jobId: approval.jobId,
      repositoryOwner: repository.owner,
      repositoryName: repository.name,
      prNumber: ensured.number,
      linearIssueId: approval.linearIssueId,
      status: "watching",
    });
  } finally {
    database.close();
  }
}

/**
 * 外部操作直前の再調停。
 *
 * 承認対象そのものが変わった場合は、指紋だけでなく対象の一致も確かめる。現在値
 * から変更を確定できた場合と、読めずに決められない場合を区別し、後者では差し戻し
 * も送信もしない。
 *
 * admissionと違い、`serve`自身が反映したIn Progressも同じ承認episodeとして受理
 * する。attachment、WHAT、HOW、承認指紋が一致する限り、この機械的な遷移だけを
 * 理由に差し戻さない。
 */
async function reconcileApproval(
  ports: ImplementationApprovalPorts,
  target: { repositoryId: number; linearIssueId: string },
  approval: ImplementationApproval,
): Promise<ApprovalReconciliation> {
  const current = await readImplementationApproval(
    ports,
    target,
    reconciledStateNames,
  );

  if (current.status === "refused") {
    return approvalChangedByRead(current.reason)
      ? { status: "changed" }
      : { status: "unknown" };
  }

  return sameApproval(approval, current.approval, {
    allowTargetBaseAdvance: true,
  })
    ? {
        status: "current",
        approvalFingerprint: current.approval.approvalFingerprint,
      }
    : { status: "changed" };
}
