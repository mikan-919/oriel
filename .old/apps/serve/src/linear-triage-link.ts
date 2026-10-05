import { randomUUID } from "node:crypto";

import type {
  GitHubRepository,
  LinearTriageLinkEvent,
  LinearTriageLinkRequest,
} from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import type { JobOwnershipVerifier } from "./issue-comments";
import type { LinearDiscoveryReader } from "./linear-approval";
import type { LinearTriageWriter } from "./linear-triage-writer";

export function createLinearTriageLinkOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO linear_triage_link_outbox (
      operation_id,
      request_id,
      job_id,
      job_lease_id,
      repository_owner,
      repository_name,
      issue_number,
      linear_issue_id,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE linear_triage_link_outbox
     SET status = ?, linear_issue_id = COALESCE(?, linear_issue_id)
     WHERE operation_id = ?`,
  );

  return {
    start(operation: {
      operationId: string;
      requestId: string;
      jobId: string;
      jobLeaseId: string;
      repository: GitHubRepository;
      issueNumber: number;
    }) {
      insert.run(
        operation.operationId,
        operation.requestId,
        operation.jobId,
        operation.jobLeaseId,
        operation.repository.owner,
        operation.repository.name,
        operation.issueNumber,
        null,
        "pending",
      );
    },
    settle(
      operationId: string,
      status: "completed" | "rejected",
      linearIssueId: string | null = null,
    ) {
      update.run(status, linearIssueId, operationId);
    },
  };
}

export interface EnsureLinearTriageLinkOptions {
  database: Database;
  ownershipVerifier: JobOwnershipVerifier;
  discovery: LinearDiscoveryReader;
  writer: LinearTriageWriter;
  linearTeamId: string;
  githubIssueUrl: string;
  request: LinearTriageLinkRequest;
  newOperationId?: () => string;
}

/**
 * GitHub IssueをLinear issueへ結び付ける。
 *
 * 対応するLinear issueが既に一件だけあれば、それを冪等な結果として返し何も
 * 書かない。ゼロ件の時だけTriageで新規作成してattachmentで結び付ける。複数件
 * ある場合はADR 0001のとおり選ばず停止する。
 */
export async function ensureLinearTriageLink({
  database,
  ownershipVerifier,
  discovery,
  writer,
  linearTeamId,
  githubIssueUrl,
  request,
  newOperationId = randomUUID,
}: EnsureLinearTriageLinkOptions): Promise<LinearTriageLinkEvent> {
  const owned = await Promise.resolve(
    ownershipVerifier.hasCurrentJobOwnership(request),
  ).catch(() => false);

  if (!owned) {
    return {
      type: "linear_triage_link.rejected",
      requestId: request.requestId,
      reason: "ownership_not_current",
    };
  }

  const existing = await discovery.findIssuesByAttachmentUrl(githubIssueUrl);

  if (existing === null) {
    return {
      type: "linear_triage_link.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  if (existing.length > 1) {
    return {
      type: "linear_triage_link.rejected",
      requestId: request.requestId,
      reason: "ambiguous_existing_link",
    };
  }

  if (existing.length === 1) {
    return {
      type: "linear_triage_link.completed",
      requestId: request.requestId,
      linearIssueId: existing[0]!.issueId,
    };
  }

  const outbox = createLinearTriageLinkOutbox(database);
  const operationId = newOperationId();

  outbox.start({
    operationId,
    requestId: request.requestId,
    jobId: request.jobId,
    jobLeaseId: request.jobLeaseId,
    repository: request.repository,
    issueNumber: request.issueNumber,
  });

  const created = await writer.createTriageIssue({
    teamId: linearTeamId,
    title: request.title,
    description: request.description,
    clientId: operationId,
  });

  if (created === null) {
    outbox.settle(operationId, "rejected");
    return {
      type: "linear_triage_link.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  await writer
    .createAttachment({
      issueId: created.issueId,
      url: githubIssueUrl,
      title: request.title,
    })
    .catch(() => false);

  // attachment作成が失敗した可能性を、盲目的に再送せず読み直して確かめる。
  const confirmed = await discovery.findIssuesByAttachmentUrl(githubIssueUrl);

  if (
    confirmed === null ||
    !confirmed.some((issue) => issue.issueId === created.issueId)
  ) {
    outbox.settle(operationId, "rejected", created.issueId);
    return {
      type: "linear_triage_link.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  outbox.settle(operationId, "completed", created.issueId);
  return {
    type: "linear_triage_link.completed",
    requestId: request.requestId,
    linearIssueId: created.issueId,
  };
}
