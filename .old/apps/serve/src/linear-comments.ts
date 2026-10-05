import { createHash, randomUUID } from "node:crypto";

import type {
  LinearCommentAcceptedEvent,
  LinearCommentCompletedEvent,
  LinearCommentEvent,
  LinearCommentReconciliationRequiredEvent,
  LinearCommentRejectedEvent,
  LinearCommentRequest,
} from "@mikan-919/oriel-contracts";
import { operationMarker } from "@mikan-919/oriel-identity";
import type { Database } from "bun:sqlite";

import type { JobOwnershipVerifier } from "./issue-comments";
import type { LinearApprovalReaderOptions } from "./linear-approval";

const linearApi = "https://api.linear.app/graphql";
const commentCreateMutation = `mutation($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id } }
}`;
const commentsQuery = `query($id: String!) {
  issue(id: $id) { comments(first: 250) { nodes { id body createdAt user { id } } } }
}`;
const commentDeleteMutation = `mutation($id: String!) {
  commentDelete(id: $id) { success }
}`;
const viewerQuery = `query { viewer { id } }`;

export interface LinearComment {
  id: string;
  body: string;
  authorId: string | null;
  createdAt: string;
}

export interface LinearCommentPublisher {
  createComment(input: { linearIssueId: string; body: string }): Promise<{
    id: string;
  }>;
  getViewerId(): Promise<string>;
  listComments(input: { linearIssueId: string }): Promise<LinearComment[]>;
  deleteComment(input: { id: string }): Promise<void>;
}

export class LinearCommentRejectedError extends Error {}

/**
 * Linear commentのGraphQL境界。
 *
 * `commentCreate`のGraphQL errorは値を検証できた上での明確な拒否として
 * `LinearCommentRejectedError`にする。応答が返らない、HTTPが失敗する場合は
 * 結果不明として通常のErrorを投げ、呼び出し側の再送判断に委ねる。
 */
export function createLinearGraphqlCommentPublisher({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions): LinearCommentPublisher {
  async function post(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<{
    data: Record<string, unknown> | null;
    hasErrors: boolean;
  }> {
    const response = await fetchImpl(
      new Request(linearApi, {
        method: "POST",
        headers: { authorization: token, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      }),
    );

    if (!response.ok) {
      throw new Error("Linear request failed");
    }

    const payload = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown[];
    };

    return {
      data: payload.data ?? null,
      hasErrors: (payload.errors ?? []).length > 0,
    };
  }

  return {
    async createComment({ linearIssueId, body }) {
      const { data, hasErrors } = await post(commentCreateMutation, {
        input: { issueId: linearIssueId, body },
      });

      if (hasErrors) {
        throw new LinearCommentRejectedError("Linear rejected comment");
      }

      const id = (
        data?.commentCreate as { comment?: { id?: string } | null } | null
      )?.comment?.id;

      if (typeof id !== "string") {
        throw new LinearCommentRejectedError("Linear rejected comment");
      }

      return { id };
    },
    async getViewerId() {
      const { data, hasErrors } = await post(viewerQuery, {});
      const id = (data?.viewer as { id?: string } | null)?.id;

      if (hasErrors || typeof id !== "string") {
        throw new Error("Linear viewer could not be read");
      }

      return id;
    },
    async listComments({ linearIssueId }) {
      const { data, hasErrors } = await post(commentsQuery, {
        id: linearIssueId,
      });

      if (hasErrors) {
        throw new Error("Linear comments could not be read");
      }

      const nodes =
        (
          data?.issue as {
            comments?: {
              nodes?: {
                id?: string;
                body?: string;
                createdAt?: string;
                user?: { id?: string } | null;
              }[];
            } | null;
          } | null
        )?.comments?.nodes ?? [];

      const comments: LinearComment[] = [];

      for (const node of nodes) {
        if (
          typeof node.id === "string" &&
          typeof node.body === "string" &&
          typeof node.createdAt === "string"
        ) {
          comments.push({
            id: node.id,
            body: node.body,
            createdAt: node.createdAt,
            authorId: node.user?.id ?? null,
          });
        }
      }

      return comments;
    },
    async deleteComment({ id }) {
      const { hasErrors } = await post(commentDeleteMutation, { id });

      if (hasErrors) {
        throw new Error("Linear comment could not be deleted");
      }
    },
  };
}

type LinearCommentOperationStatus =
  "pending" | "completed" | "rejected" | "reconciliation_required";

export interface LinearCommentOutboxOperation extends LinearCommentRequest {
  operationId: string;
  linearActorId: string | null;
  bodyDigest: string | null;
  status: LinearCommentOperationStatus;
  linearCommentId: string | null;
}

interface LinearCommentOutboxRow {
  operationId: string;
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  linearIssueId: string;
  body: string;
  linearActorId: string | null;
  bodyDigest: string | null;
  status: LinearCommentOperationStatus;
  linearCommentId: string | null;
}

export function createLinearCommentOutbox(database: Database) {
  const selectOperationSql = `SELECT
      operation_id AS operationId,
      request_id AS requestId,
      job_id AS jobId,
      job_lease_id AS jobLeaseId,
      repository_owner AS repositoryOwner,
      repository_name AS repositoryName,
      issue_number AS issueNumber,
      linear_issue_id AS linearIssueId,
      body,
      linear_actor_id AS linearActorId,
      body_digest AS bodyDigest,
      status,
      linear_comment_id AS linearCommentId
    FROM linear_comment_outbox`;
  const selectOperation = database.query(selectOperationSql);

  return {
    enqueue(operation: LinearCommentOutboxOperation) {
      database
        .query(
          `INSERT INTO linear_comment_outbox (
            operation_id,
            request_id,
            job_id,
            job_lease_id,
            repository_owner,
            repository_name,
            issue_number,
            linear_issue_id,
            body,
            linear_actor_id,
            body_digest,
            status,
            linear_comment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.requestId,
          operation.jobId,
          operation.jobLeaseId,
          operation.repository.owner,
          operation.repository.name,
          operation.issueNumber,
          operation.linearIssueId,
          operation.body,
          operation.linearActorId,
          operation.bodyDigest,
          operation.status,
          operation.linearCommentId,
        );
    },
    find(operationId: string): LinearCommentOutboxOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE operation_id = ?`)
        .get(operationId) as LinearCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    findByRequest(
      jobId: string,
      requestId: string,
    ): LinearCommentOutboxOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE job_id = ? AND request_id = ?`)
        .get(jobId, requestId) as LinearCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    adopt(operationId: string, jobLeaseId: string) {
      database
        .query(
          `UPDATE linear_comment_outbox
          SET job_lease_id = ?
          WHERE operation_id = ?`,
        )
        .run(jobLeaseId, operationId);
    },
    setActorId(operationId: string, linearActorId: string) {
      database
        .query(
          `UPDATE linear_comment_outbox
          SET linear_actor_id = ?
          WHERE operation_id = ?`,
        )
        .run(linearActorId, operationId);
    },
    complete(operationId: string, linearCommentId: string) {
      database
        .query(
          `UPDATE linear_comment_outbox
          SET status = 'completed', linear_comment_id = ?
          WHERE operation_id = ?`,
        )
        .run(linearCommentId, operationId);
    },
    reject(operationId: string) {
      database
        .query(
          `UPDATE linear_comment_outbox
          SET status = 'rejected'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    requireReconciliation(operationId: string) {
      database
        .query(
          `UPDATE linear_comment_outbox
          SET status = 'reconciliation_required'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    pending(): LinearCommentOutboxOperation[] {
      return (selectOperation.all() as LinearCommentOutboxRow[])
        .map(fromRow)
        .filter(
          (operation) =>
            operation.status === "pending" ||
            operation.status === "reconciliation_required",
        );
    },
  };
}

function fromRow(row: LinearCommentOutboxRow): LinearCommentOutboxOperation {
  return {
    type: "linear_comment.request",
    operationId: row.operationId,
    requestId: row.requestId,
    jobId: row.jobId,
    jobLeaseId: row.jobLeaseId,
    repository: {
      owner: row.repositoryOwner,
      name: row.repositoryName,
    },
    issueNumber: row.issueNumber,
    linearIssueId: row.linearIssueId,
    body: row.body,
    linearActorId: row.linearActorId,
    bodyDigest: row.bodyDigest,
    status: row.status,
    linearCommentId: row.linearCommentId,
  };
}

type LinearCommentOutbox = ReturnType<typeof createLinearCommentOutbox>;

interface LinearCommentServiceDependencies {
  outbox: LinearCommentOutbox;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: LinearCommentPublisher;
  newOperationId?: () => string;
}

/**
 * Linear commentのoutboxとdelivery。
 *
 * issue-comments.tsと同じ「結果不明の操作は盲目的に再送しない」原則を保ち、
 * 送信できたか分からない場合は現在のcomment一覧を読み直し、同じ論理commentが
 * 既にあれば一件へ圧縮して完了とする。IDの並びが意味を持たないLinearでは、
 * `createdAt`で最新を判定する。
 */
export function createLinearCommentService({
  outbox,
  ownershipVerifier,
  publisher,
  newOperationId = randomUUID,
}: LinearCommentServiceDependencies) {
  const pendingDeliveries = new Map<string, Promise<void>>();
  const outcomeWaiters = new Map<
    string,
    Array<(event: LinearCommentEvent) => void>
  >();

  async function accept(
    request: LinearCommentRequest,
  ): Promise<LinearCommentAcceptedEvent | LinearCommentRejectedEvent> {
    if (!(await hasCurrentOwnership(request))) {
      return rejected(request.requestId, "ownership_not_current");
    }

    const existing = outbox.findByRequest(request.jobId, request.requestId);

    if (existing !== null) {
      if (!sameRequest(existing, request)) {
        return rejected(request.requestId, "request_conflict");
      }

      void dispatch(existing.operationId);
      return accepted(request.requestId, existing.operationId);
    }

    const operationId = newOperationId();
    const operation: LinearCommentOutboxOperation = {
      ...request,
      operationId,
      linearActorId: null,
      bodyDigest: null,
      status: "pending",
      linearCommentId: null,
    };
    operation.bodyDigest = digest(commentBody(operation));

    try {
      outbox.enqueue(operation);
    } catch {
      const racedOperation = outbox.findByRequest(
        request.jobId,
        request.requestId,
      );

      if (racedOperation === null || !sameRequest(racedOperation, request)) {
        throw new Error(
          "Linear-comment outbox operation could not be persisted",
        );
      }

      void dispatch(racedOperation.operationId);
      return accepted(request.requestId, racedOperation.operationId);
    }

    void dispatch(operationId);
    return accepted(request.requestId, operationId);
  }

  async function dispatch(operationId: string): Promise<void> {
    const inFlight = pendingDeliveries.get(operationId);

    if (inFlight !== undefined) {
      return inFlight;
    }

    const delivery = deliver(operationId)
      .catch(() => {
        const operation = outbox.find(operationId);

        if (operation !== null && !isTerminal(operation)) {
          requireReconciliation(operation);
        }
      })
      .finally(() => {
        pendingDeliveries.delete(operationId);
      });
    pendingDeliveries.set(operationId, delivery);
    return delivery;
  }

  async function deliver(operationId: string): Promise<void> {
    const operation = outbox.find(operationId);

    if (operation === null || isTerminal(operation)) {
      return;
    }

    if (operation.status === "reconciliation_required") {
      await reconcile(operation, false, true);
      return;
    }

    let deliverableOperation = operation;

    if (deliverableOperation.linearActorId === null) {
      const actorId = await publisher.getViewerId();
      outbox.setActorId(deliverableOperation.operationId, actorId);
      deliverableOperation = outbox.find(operationId) ?? deliverableOperation;
    }

    if (!(await hasCurrentOwnership(deliverableOperation))) {
      finishRejected(deliverableOperation, "ownership_not_current");
      return;
    }

    try {
      const comment = await publisher.createComment({
        linearIssueId: deliverableOperation.linearIssueId,
        body: commentBody(deliverableOperation),
      });
      outbox.complete(deliverableOperation.operationId, comment.id);
      notify(completed(outbox.find(deliverableOperation.operationId)!));
    } catch (error) {
      await reconcile(
        deliverableOperation,
        error instanceof LinearCommentRejectedError,
        true,
      );
    }
  }

  async function reconcile(
    operation: LinearCommentOutboxOperation,
    definitelyRejected: boolean,
    allowResend: boolean,
  ): Promise<void> {
    const comments = await publisher.listComments(operation);
    const matches = comments
      .filter(
        (comment) =>
          comment.authorId === operation.linearActorId &&
          digest(comment.body) === expectedBodyDigest(operation),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    if (matches.length === 0) {
      if (definitelyRejected) {
        finishRejected(operation, "linear_rejected");
        return;
      }

      if (allowResend) {
        await resend(operation);
        return;
      }

      requireReconciliation(operation);
      return;
    }

    const [canonical, ...duplicates] = matches;

    for (const duplicate of duplicates) {
      if (!(await hasCurrentOwnership(operation))) {
        finishRejected(operation, "ownership_not_current");
        return;
      }

      try {
        await publisher.deleteComment({ id: duplicate.id });
      } catch {
        requireReconciliation(operation);
        return;
      }
    }

    outbox.complete(operation.operationId, canonical!.id);
    notify(completed(outbox.find(operation.operationId)!));
  }

  async function resend(
    operation: LinearCommentOutboxOperation,
  ): Promise<void> {
    if (!(await hasCurrentOwnership(operation))) {
      finishRejected(operation, "ownership_not_current");
      return;
    }

    try {
      await publisher.createComment({
        linearIssueId: operation.linearIssueId,
        body: commentBody(operation),
      });
    } catch (error) {
      await reconcile(
        operation,
        error instanceof LinearCommentRejectedError,
        false,
      );
      return;
    }

    await reconcile(operation, false, false);
  }

  function waitForOutcome(operationId: string): Promise<LinearCommentEvent> {
    const operation = outbox.find(operationId);

    if (operation === null) {
      throw new Error("Linear-comment operation was not found");
    }

    const currentOutcome = outcomeFor(operation);

    if (currentOutcome !== null) {
      return Promise.resolve(currentOutcome);
    }

    return new Promise((resolve) => {
      const waiters = outcomeWaiters.get(operationId) ?? [];
      waiters.push(resolve);
      outcomeWaiters.set(operationId, waiters);
    });
  }

  function notify(event: LinearCommentEvent) {
    if (event.operationId === undefined) {
      return;
    }

    const waiters = outcomeWaiters.get(event.operationId) ?? [];
    outcomeWaiters.delete(event.operationId);

    for (const resolve of waiters) {
      resolve(event);
    }
  }

  function resumePending(
    binding?: Pick<
      LinearCommentRequest,
      "jobId" | "jobLeaseId" | "repository" | "issueNumber"
    >,
  ) {
    const resumptions: Array<Promise<void>> = [];

    for (const operation of outbox.pending()) {
      if (binding !== undefined && !sameBinding(operation, binding)) {
        continue;
      }

      if (binding !== undefined) {
        outbox.adopt(operation.operationId, binding.jobLeaseId);
      }

      const resumableOperation =
        outbox.find(operation.operationId) ?? operation;

      resumptions.push(
        resume(resumableOperation).catch(() => {
          requireReconciliation(resumableOperation);
        }),
      );
    }

    return Promise.all(resumptions).then(() => undefined);
  }

  async function resume(
    operation: LinearCommentOutboxOperation,
  ): Promise<void> {
    if (!(await hasCurrentOwnership(operation))) {
      return;
    }

    let resumableOperation = operation;

    if (resumableOperation.linearActorId === null) {
      const actorId = await publisher.getViewerId();
      outbox.setActorId(resumableOperation.operationId, actorId);
      resumableOperation =
        outbox.find(resumableOperation.operationId) ?? resumableOperation;
    }

    await reconcile(resumableOperation, false, true);
  }

  return { accept, dispatch, resumePending, waitForOutcome };

  async function hasCurrentOwnership(
    operation: Pick<
      LinearCommentRequest,
      "jobId" | "jobLeaseId" | "repository" | "issueNumber"
    >,
  ) {
    return ownershipVerifier.hasCurrentJobOwnership(operation);
  }

  function finishRejected(
    operation: LinearCommentOutboxOperation,
    reason: LinearCommentRejectedEvent["reason"],
  ) {
    outbox.reject(operation.operationId);
    notify(rejected(operation.requestId, reason, operation.operationId));
  }

  function requireReconciliation(operation: LinearCommentOutboxOperation) {
    outbox.requireReconciliation(operation.operationId);
    notify(reconciliationRequired(operation));
  }
}

function sameRequest(
  operation: LinearCommentOutboxOperation,
  request: LinearCommentRequest,
) {
  return (
    operation.repository.owner === request.repository.owner &&
    operation.repository.name === request.repository.name &&
    operation.issueNumber === request.issueNumber &&
    operation.linearIssueId === request.linearIssueId &&
    operation.body === request.body
  );
}

function sameBinding(
  operation: LinearCommentOutboxOperation,
  binding: Pick<
    LinearCommentRequest,
    "jobId" | "jobLeaseId" | "repository" | "issueNumber"
  >,
) {
  return (
    operation.jobId === binding.jobId &&
    operation.repository.owner === binding.repository.owner &&
    operation.repository.name === binding.repository.name &&
    operation.issueNumber === binding.issueNumber
  );
}

function isTerminal(operation: LinearCommentOutboxOperation) {
  return operation.status === "completed" || operation.status === "rejected";
}

function outcomeFor(
  operation: LinearCommentOutboxOperation,
): LinearCommentEvent | null {
  if (operation.status === "completed") {
    return completed(operation);
  }

  if (operation.status === "reconciliation_required") {
    return reconciliationRequired(operation);
  }

  if (operation.status === "rejected") {
    return rejected(
      operation.requestId,
      "linear_rejected",
      operation.operationId,
    );
  }

  return null;
}

function accepted(
  requestId: string,
  operationId: string,
): LinearCommentAcceptedEvent {
  return {
    type: "linear_comment.accepted",
    requestId,
    operationId,
  };
}

function completed(
  operation: LinearCommentOutboxOperation,
): LinearCommentCompletedEvent {
  return {
    type: "linear_comment.completed",
    requestId: operation.requestId,
    operationId: operation.operationId,
    linearCommentId: operation.linearCommentId as string,
  };
}

function rejected(
  requestId: string,
  reason: LinearCommentRejectedEvent["reason"],
  operationId?: string,
): LinearCommentRejectedEvent {
  return {
    type: "linear_comment.rejected",
    requestId,
    ...(operationId === undefined ? {} : { operationId }),
    reason,
  };
}

function reconciliationRequired(
  operation: LinearCommentOutboxOperation,
): LinearCommentReconciliationRequiredEvent {
  return {
    type: "linear_comment.reconciliation_required",
    requestId: operation.requestId,
    operationId: operation.operationId,
  };
}

function commentBody(operation: LinearCommentOutboxOperation) {
  return `${operation.body}\n\n${operationMarker(operation.operationId)}`;
}

function expectedBodyDigest(operation: LinearCommentOutboxOperation) {
  return operation.bodyDigest ?? digest(commentBody(operation));
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
