import { randomUUID } from "node:crypto";

import type {
  LinearDescriptionUpdateEvent,
  LinearDescriptionUpdateRequest,
} from "@mikan-919/oriel-contracts";
import type { Database } from "bun:sqlite";

import type { LinearApprovalReader } from "./github-approval-ports";
import type { JobOwnershipVerifier } from "./issue-comments";
import type { LinearApprovalReaderOptions } from "./linear-approval";

const linearApi = "https://api.linear.app/graphql";
const issueUpdateDescriptionMutation = `mutation($id: String!, $description: String!) {
  issueUpdate(id: $id, input: { description: $description }) { success }
}`;

export interface LinearDescriptionPublisher {
  /** 失敗はすべて呼び出し側で一律`linear_rejected`として扱うため、例外を投げるだけでよい。 */
  updateDescription(input: {
    linearIssueId: string;
    description: string;
  }): Promise<void>;
  /** 現在のdescription。読めなければnull。 */
  readDescription(input: { linearIssueId: string }): Promise<string | null>;
}

/**
 * `linear-approval.ts`の`readIssue`を再利用してdescriptionを読み、更新だけ
 * 独自のGraphQL呼び出しを持つ。全体を置き換える冪等な操作であり、
 * issue-comment.tsのような再送・重複解消の判断は不要とする。
 */
export function createLinearGraphqlDescriptionPublisher({
  token,
  fetchImpl = (request) => fetch(request),
  reader,
}: LinearApprovalReaderOptions & {
  reader: LinearApprovalReader;
}): LinearDescriptionPublisher {
  return {
    async updateDescription({ linearIssueId, description }) {
      const response = await fetchImpl(
        new Request(linearApi, {
          method: "POST",
          headers: {
            authorization: token,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            query: issueUpdateDescriptionMutation,
            variables: { id: linearIssueId, description },
          }),
        }),
      );

      if (!response.ok) {
        throw new Error("Linear description request failed");
      }

      const payload = (await response.json()) as {
        data?: { issueUpdate?: { success?: boolean } | null };
        errors?: unknown[];
      };

      if (
        (payload.errors ?? []).length > 0 ||
        payload.data?.issueUpdate?.success !== true
      ) {
        throw new Error("Linear rejected description update");
      }
    },
    async readDescription({ linearIssueId }) {
      const issue = await reader.readIssue(linearIssueId);

      return issue === null ? null : (issue.description ?? "");
    },
  };
}

export function createLinearDescriptionOutbox(database: Database) {
  const insert = database.query(
    `INSERT INTO linear_description_outbox (
      operation_id,
      request_id,
      job_id,
      job_lease_id,
      repository_owner,
      repository_name,
      issue_number,
      linear_issue_id,
      description,
      status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = database.query(
    `UPDATE linear_description_outbox SET status = ? WHERE operation_id = ?`,
  );

  return {
    start(operation: {
      operationId: string;
      requestId: string;
      jobId: string;
      jobLeaseId: string;
      repository: { owner: string; name: string };
      issueNumber: number;
      linearIssueId: string;
      description: string;
    }) {
      insert.run(
        operation.operationId,
        operation.requestId,
        operation.jobId,
        operation.jobLeaseId,
        operation.repository.owner,
        operation.repository.name,
        operation.issueNumber,
        operation.linearIssueId,
        operation.description,
        "pending",
      );
    },
    settle(operationId: string, status: "completed" | "rejected") {
      update.run(status, operationId);
    },
  };
}

export interface UpdateLinearDescriptionOptions {
  database: Database;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: LinearDescriptionPublisher;
  request: LinearDescriptionUpdateRequest;
  newOperationId?: () => string;
}

/**
 * Linear issue descriptionを、確定したHOWへ書き換える。
 *
 * 送信直前に現在値を読み直し、`baselineDescription`(harnessがturn開始時に
 * 見た値)と一致しない場合は人間の同時変更とみなし、`concurrent_change`で
 * 拒否する。汎用mergeは行わない。送信後は再読して期待した本文と一致するかで
 * 完了を確定する。
 */
export async function updateLinearDescription({
  database,
  ownershipVerifier,
  publisher,
  request,
  newOperationId = randomUUID,
}: UpdateLinearDescriptionOptions): Promise<LinearDescriptionUpdateEvent> {
  const owned = await Promise.resolve(
    ownershipVerifier.hasCurrentJobOwnership(request),
  ).catch(() => false);

  if (!owned) {
    return {
      type: "linear_description.rejected",
      requestId: request.requestId,
      reason: "ownership_not_current",
    };
  }

  const current = await publisher.readDescription(request);

  if (current === null) {
    return {
      type: "linear_description.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  if (current !== request.baselineDescription) {
    return {
      type: "linear_description.rejected",
      requestId: request.requestId,
      reason: "concurrent_change",
    };
  }

  const outbox = createLinearDescriptionOutbox(database);
  const operationId = newOperationId();

  outbox.start({
    operationId,
    requestId: request.requestId,
    jobId: request.jobId,
    jobLeaseId: request.jobLeaseId,
    repository: request.repository,
    issueNumber: request.issueNumber,
    linearIssueId: request.linearIssueId,
    description: request.description,
  });

  try {
    await publisher.updateDescription(request);
  } catch {
    outbox.settle(operationId, "rejected");
    return {
      type: "linear_description.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  const confirmed = await publisher.readDescription(request);

  if (confirmed !== request.description) {
    outbox.settle(operationId, "rejected");
    return {
      type: "linear_description.rejected",
      requestId: request.requestId,
      reason: "linear_rejected",
    };
  }

  outbox.settle(operationId, "completed");
  return { type: "linear_description.completed", requestId: request.requestId };
}
