import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import { startHarnessWorker } from "./harness-worker";
import {
  createGitHubIssueConversationAdmission,
  type IssueConversationAdmission,
} from "./issue-conversation-admission";
import { createRelayOwnershipConnection } from "./ownership-connection";

export interface StartIssueConversationJobOptions {
  relayOrigin: URL | string;
  tokenStore: DeviceTokenStore;
  /**
   * 認証済みOctokitの解決。用意できない場合はnullを返し、外部書き込み経路を
   * fail closedにする。未認証clientは使わない。
   */
  createOctokit: () => Promise<Octokit | null>;
  createAdmission?: (octokit: Octokit) => IssueConversationAdmission;
  databasePath: string;
  harnessEntry: URL | string;
  repositoryId: number;
  repository: GitHubRepository;
  issueNumber: number;
  /** 人間がlocalhost UIで書いた、この対話の返答本文。 */
  body: string;
  heartbeatStopMs: number;
}

export type StartIssueConversationJobResult =
  | {
      status: "started";
      jobId: string;
      /** harness processが終わるまで待つ。 */
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
        | "approval_changed";
    };

/**
 * 明示的に起動したIssue対話の製品経路。ADR 0003の受け入れ判定を通し、
 * device tokenでrelayのJob所有権を取り、credentialを持たないharness processを
 * 起動してstdioのNDJSONを`serve`の外部操作へつなぐ。
 *
 * この経路はコードを変更しない対話Jobだけを扱い、Job所有権しか取らない。
 * LinearのTriage→Todo、attachmentの逆引き、HOWの取り込み、ブランチ封印を伴う
 * 実装Jobは`implementation-job.ts`が別の境界型と起動経路で扱う。
 */
export async function startIssueConversationJob({
  relayOrigin,
  tokenStore,
  createOctokit,
  createAdmission = createGitHubIssueConversationAdmission,
  databasePath,
  harnessEntry,
  repositoryId,
  repository,
  issueNumber,
  body,
  heartbeatStopMs,
}: StartIssueConversationJobOptions): Promise<StartIssueConversationJobResult> {
  const deviceToken = await tokenStore.get(repositoryId);

  if (deviceToken === null) {
    return { status: "refused", reason: "device_not_registered" };
  }

  const octokit = await createOctokit();

  if (octokit === null) {
    return { status: "refused", reason: "github_credentials_unavailable" };
  }

  const admission = createAdmission(octokit);
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

  // 所有権を取得した後にもう一度読み、同じ現在値であることを確かめる。
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

  const worker = startHarnessWorker({
    databasePath,
    octokit,
    ownership,
    harnessEntry,
    jobId: admitted.jobId,
    jobLeaseId,
    repository,
    issueNumber,
    body,
  });

  return {
    status: "started",
    jobId: admitted.jobId,
    finished: worker.finished,
    jobStatus: worker.jobStatus,
    close: worker.close,
  };
}
