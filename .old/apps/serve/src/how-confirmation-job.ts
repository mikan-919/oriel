import type { GitHubRepository } from "@mikan-919/oriel-contracts";

import type { LinearApprovalReader } from "./github-approval-ports";
import {
  createLinearIssueConversationAdmission,
  type LinearIssueConversationAdmission,
} from "./how-confirmation-admission";
import {
  startHowConfirmationWorker,
  type HowConfirmationWorker,
  type StartHowConfirmationWorkerOptions,
} from "./how-confirmation-worker";
import type { DeviceTokenStore } from "./device-registration";
import type { LinearCommentPublisher } from "./linear-comments";
import type { LinearDescriptionPublisher } from "./linear-description";
import type { ModelStreamProvider } from "./model-stream";
import { createRelayOwnershipConnection } from "./ownership-connection";

export interface HowConfirmationLinearPorts {
  reader: LinearApprovalReader;
  commentPublisher: LinearCommentPublisher;
  descriptionPublisher: LinearDescriptionPublisher;
}

export interface StartHowConfirmationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  createAdmission?: (
    reader: LinearApprovalReader,
  ) => LinearIssueConversationAdmission;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  issueNumber: number;
  linearIssueId: string;
  /**
   * mention/commandを検知した既存のLinear comment、またはlocalhost UIで人間が
   * 書いた返答本文。後者は`serve`がLinear commentとして投稿してから対話を
   * 始める。どちらも、Triage→Todoの実行承認そのものはAgentへ渡さない。
   */
  trigger:
    | { commentId: string; command: boolean }
    | { body: string; command: boolean };
  model: { provider: string; id: string };
  modelProvider: ModelStreamProvider;
  /** Linear tokenをこの一回の起動でだけ解決する。取れなければ何も始めない。 */
  createLinearPorts: () => Promise<HowConfirmationLinearPorts | null>;
  heartbeatStopMs: number;
  createWorker?: (
    options: StartHowConfirmationWorkerOptions,
  ) => HowConfirmationWorker;
}

export type StartHowConfirmationJobResult =
  | {
      status: "started";
      jobId: string;
      finished: Promise<void>;
      jobStatus(): string | null;
      close(): void;
    }
  | {
      status: "refused";
      reason:
        | "device_not_registered"
        | "linear_credentials_unavailable"
        | "linear_issue_not_found"
        | "linear_issue_not_triage"
        | "job_ownership_not_acquired"
        | "approval_changed";
    };

/**
 * mention/commandトリガーからHOW確定Jobを始める製品経路。
 *
 * what-confirmation-job.tsと同じADR 0003受け入れ・所有権取得の骨格を、Linear
 * issueのtitle・description・comment一覧を対象に再現する。GitHub credentialは
 * 使わない(この対話はLinear issueだけを読み書きする)。
 */
export async function startHowConfirmationJob({
  relayOrigin,
  tokenStore,
  createAdmission = createLinearIssueConversationAdmission,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  issueNumber,
  linearIssueId,
  trigger,
  model,
  modelProvider,
  createLinearPorts,
  heartbeatStopMs,
  createWorker = startHowConfirmationWorker,
}: StartHowConfirmationJobOptions): Promise<StartHowConfirmationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const linearPorts = await createLinearPorts();

  if (linearPorts === null) {
    return { status: "refused", reason: "linear_credentials_unavailable" };
  }

  const admission = createAdmission(linearPorts.reader);
  const admitted = await admission.admit({
    repositoryId,
    issueNumber,
    linearIssueId,
  });

  if (admitted.status === "refused") {
    return { status: "refused", reason: admitted.reason };
  }

  const ownership = createRelayOwnershipConnection({
    relayOrigin,
    deviceToken,
    jobId: admitted.jobId,
    heartbeatStopMs,
  });
  const jobLeaseId = await ownership.acquireJobOwnership();

  if (jobLeaseId === null) {
    ownership.release();
    return { status: "refused", reason: "job_ownership_not_acquired" };
  }

  if (
    !(await admission.reconfirm({
      linearIssueId,
      approvalFingerprint: admitted.approvalFingerprint,
    }))
  ) {
    ownership.release();
    return { status: "refused", reason: "approval_changed" };
  }

  const linearIssue = await linearPorts.reader.readIssue(linearIssueId);

  if (linearIssue === null) {
    ownership.release();
    return { status: "refused", reason: "linear_issue_not_found" };
  }

  // localhost UIの入力は、そのままLinear commentとして残してから対話を始める。
  // 既存commentのtriggerと違い、この経路は毎回新しいcommentを作る。
  const resolvedTrigger =
    "commentId" in trigger
      ? trigger
      : {
          commentId: (
            await linearPorts.commentPublisher.createComment({
              linearIssueId,
              body: trigger.body,
            })
          ).id,
          command: trigger.command,
        };

  const viewerId = await linearPorts.commentPublisher.getViewerId();
  const comments = (
    await linearPorts.commentPublisher.listComments({ linearIssueId })
  )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((comment) => ({
      id: comment.id,
      authorIsActor: comment.authorId === viewerId,
      body: comment.body,
    }));

  const worker = createWorker({
    databasePath,
    ownership,
    harnessEntry,
    linearCommentPublisher: linearPorts.commentPublisher,
    linearDescriptionPublisher: linearPorts.descriptionPublisher,
    modelProvider,
    start: {
      type: "how_confirmation.start",
      jobId: admitted.jobId,
      jobLeaseId,
      repository,
      issueNumber,
      linearIssueId,
      model,
      linearIssue: {
        title: linearIssue.title,
        description: linearIssue.description ?? "",
      },
      comments,
      trigger: resolvedTrigger,
    },
  });

  return {
    status: "started",
    jobId: admitted.jobId,
    finished: worker.finished,
    jobStatus: worker.jobStatus,
    close: worker.close,
  };
}
