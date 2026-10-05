import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import type { IssueConversationAdmission } from "./issue-conversation-admission";
import { createOctokitIssueCommentPublisher } from "./issue-comments";
import type { LinearDiscoveryReader } from "./linear-approval";
import type { LinearTriageWriter } from "./linear-triage-writer";
import type { ModelStreamProvider } from "./model-stream";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { createWhatConfirmationAdmission } from "./what-confirmation-admission";
import { startWhatConfirmationWorker } from "./what-confirmation-worker";

export interface StartWhatConfirmationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  createOctokit: () => Promise<Octokit | null>;
  createAdmission?: (
    octokit: Octokit,
    triggerCommentId: number,
  ) => IssueConversationAdmission;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  issueNumber: number;
  /** mention/commandを検知したcomment。 */
  trigger: { commentId: number; command: boolean };
  model: { provider: string; id: string };
  modelProvider: ModelStreamProvider;
  linearTeamId: string;
  /** Linear tokenをこの一回の起動でだけ解決する。取れなければ何も始めない。 */
  createLinearPorts: () => Promise<{
    linearDiscovery: LinearDiscoveryReader;
    linearTriageWriter: LinearTriageWriter;
  } | null>;
  heartbeatStopMs: number;
}

export type StartWhatConfirmationJobResult =
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
        | "github_credentials_unavailable"
        | "issue_not_found"
        | "issue_not_open"
        | "repository_mismatch"
        | "job_ownership_not_acquired"
        | "approval_changed"
        | "linear_credentials_unavailable";
    };

/**
 * mention/commandトリガーからWHAT確定Jobを始める製品経路。
 *
 * issue-conversation-jobと同じADR 0003受け入れ・所有権取得の骨格を再利用し、
 * 現在のIssueタイトル・本文・comment一覧をharnessへ渡す一回分の対話として
 * worker起動まで進める。
 */
export async function startWhatConfirmationJob({
  relayOrigin,
  tokenStore,
  createOctokit,
  createAdmission = createWhatConfirmationAdmission,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  issueNumber,
  trigger,
  model,
  modelProvider,
  linearTeamId,
  createLinearPorts,
  heartbeatStopMs,
}: StartWhatConfirmationJobOptions): Promise<StartWhatConfirmationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const octokit = await createOctokit();

  if (octokit === null) {
    return { status: "refused", reason: "github_credentials_unavailable" };
  }

  const linearPorts = await createLinearPorts();

  if (linearPorts === null) {
    return { status: "refused", reason: "linear_credentials_unavailable" };
  }

  const admission = createAdmission(octokit, trigger.commentId);
  const admitted = await admission.admit({
    repositoryId,
    repository,
    issueNumber,
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
      repository,
      issueNumber,
      approvalFingerprint: admitted.approvalFingerprint,
    }))
  ) {
    ownership.release();
    return { status: "refused", reason: "approval_changed" };
  }

  const issue = await octokit.rest.issues
    .get({
      owner: repository.owner,
      repo: repository.name,
      issue_number: issueNumber,
    })
    .catch(() => null);

  if (issue === null) {
    ownership.release();
    return { status: "refused", reason: "issue_not_found" };
  }

  const comments = await createOctokitIssueCommentPublisher(
    octokit,
  ).listIssueComments({ repository, issueNumber });

  const worker = startWhatConfirmationWorker({
    databasePath,
    octokit,
    ownership,
    harnessEntry,
    githubIssueUrl: issue.data.html_url,
    linearTeamId,
    linearDiscovery: linearPorts.linearDiscovery,
    linearTriageWriter: linearPorts.linearTriageWriter,
    modelProvider,
    start: {
      type: "what_confirmation.start",
      jobId: admitted.jobId,
      jobLeaseId,
      repository,
      issueNumber,
      model,
      issue: { title: issue.data.title, body: issue.data.body ?? "" },
      comments,
      trigger,
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
