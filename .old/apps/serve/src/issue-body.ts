import { randomUUID } from "node:crypto";

import type {
  GitHubRepository,
  IssueBodyUpdateEvent,
  IssueBodyUpdateRequest,
} from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";
import type { Octokit } from "@octokit/rest";

import type { JobOwnershipVerifier } from "./issue-comments";

export interface GitHubIssueBodyPublisher {
  updateIssueBody(input: {
    repository: GitHubRepository;
    issueNumber: number;
    body: string;
  }): Promise<void>;
  /** 送信直後の再読。読めなければnull。 */
  readIssueBody(input: {
    repository: GitHubRepository;
    issueNumber: number;
  }): Promise<string | null>;
}

export class GitHubIssueBodyRejectedError extends Error {}

export function createOctokitIssueBodyPublisher(
  octokit: Octokit,
): GitHubIssueBodyPublisher {
  return {
    async updateIssueBody({ repository, issueNumber, body }) {
      try {
        await octokit.rest.issues.update({
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
          body,
        });
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "status" in error &&
          typeof error.status === "number" &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          throw new GitHubIssueBodyRejectedError(
            "GitHub rejected issue body update",
          );
        }

        throw error;
      }
    },
    async readIssueBody({ repository, issueNumber }) {
      try {
        const response = await octokit.rest.issues.get({
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
        });

        return response.data.body ?? "";
      } catch {
        return null;
      }
    },
  };
}

/**
 * Issue本文更新の操作記録。
 *
 * PATCHはbody全体を冪等に上書きするため、issue-commentのような重複検知や
 * resumePendingは不要で、送信前に一件記録し、送信後の状態だけ確定する。
 */
export function createIssueBodyOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO issue_body_outbox (
      operation_id,
      request_id,
      job_id,
      job_lease_id,
      repository_owner,
      repository_name,
      issue_number,
      body,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE issue_body_outbox SET status = ? WHERE operation_id = ?`,
  );

  return {
    start(operation: {
      operationId: string;
      requestId: string;
      jobId: string;
      jobLeaseId: string;
      repository: GitHubRepository;
      issueNumber: number;
      body: string;
    }) {
      insert.run(
        operation.operationId,
        operation.requestId,
        operation.jobId,
        operation.jobLeaseId,
        operation.repository.owner,
        operation.repository.name,
        operation.issueNumber,
        operation.body,
        "pending",
      );
    },
    settle(operationId: string, status: "completed" | "rejected") {
      update.run(status, operationId);
    },
  };
}

export interface UpdateIssueBodyOptions {
  database: Database;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: GitHubIssueBodyPublisher;
  request: IssueBodyUpdateRequest;
  newOperationId?: () => string;
}

/**
 * Issue本文を、確定したWHATへ書き換える。
 *
 * 直前に現在のJob所有権を確認し、送信後は再読して期待した本文と一致するかで
 * 完了を確定する(応答そのものを正本にしない)。
 */
export async function updateIssueBody({
  database,
  ownershipVerifier,
  publisher,
  request,
  newOperationId = randomUUID,
}: UpdateIssueBodyOptions): Promise<IssueBodyUpdateEvent> {
  const owned = await Promise.resolve(
    ownershipVerifier.hasCurrentJobOwnership(request),
  ).catch(() => false);

  if (!owned) {
    return {
      type: "issue_body.rejected",
      requestId: request.requestId,
      reason: "ownership_not_current",
    };
  }

  const outbox = createIssueBodyOutbox(database);
  const operationId = newOperationId();

  outbox.start({
    operationId,
    requestId: request.requestId,
    jobId: request.jobId,
    jobLeaseId: request.jobLeaseId,
    repository: request.repository,
    issueNumber: request.issueNumber,
    body: request.body,
  });

  try {
    await publisher.updateIssueBody(request);
  } catch {
    outbox.settle(operationId, "rejected");
    return {
      type: "issue_body.rejected",
      requestId: request.requestId,
      reason: "github_rejected",
    };
  }

  const current = await publisher.readIssueBody(request);

  if (current !== request.body) {
    outbox.settle(operationId, "rejected");
    return {
      type: "issue_body.rejected",
      requestId: request.requestId,
      reason: "github_rejected",
    };
  }

  outbox.settle(operationId, "completed");
  return { type: "issue_body.completed", requestId: request.requestId };
}
