import { createHash, randomUUID } from "node:crypto";

import type {
  GitHubRepository,
  IssueCommentAcceptedEvent,
  IssueCommentCompletedEvent,
  IssueCommentEvent,
  IssueCommentReconciliationRequiredEvent,
  IssueCommentRejectedEvent,
  IssueCommentRequest,
} from "@mikan-919/oriel-contracts";
import { operationMarker } from "@mikan-919/oriel-identity";
import { Database } from "bun:sqlite";
import type { Octokit } from "@octokit/rest";

export interface JobOwnershipVerifier {
  /** 所有権を失った時にworkerを止めるための停止合図。 */
  readonly stopSignal?: AbortSignal;
  hasCurrentJobOwnership(input: {
    jobId: string;
    jobLeaseId: string;
    repository: GitHubRepository;
    issueNumber: number;
  }): boolean | Promise<boolean>;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  authorLogin: string;
}

export interface GitHubIssueCommentPublisher {
  createIssueComment(input: {
    repository: GitHubRepository;
    issueNumber: number;
    body: string;
  }): Promise<{ id: number }>;
  getActorLogin(): Promise<string>;
  listIssueComments(input: {
    repository: GitHubRepository;
    issueNumber: number;
  }): Promise<GitHubIssueComment[]>;
  deleteIssueComment(input: {
    repository: GitHubRepository;
    id: number;
  }): Promise<void>;
}

export class GitHubIssueCommentRejectedError extends Error {}

export function createOctokitIssueCommentPublisher(
  octokit: Octokit,
): GitHubIssueCommentPublisher {
  return {
    async createIssueComment({ repository, issueNumber, body }) {
      try {
        const response = await octokit.rest.issues.createComment({
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
          body,
        });
        return { id: response.data.id };
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
          throw new GitHubIssueCommentRejectedError("GitHub rejected comment");
        }

        throw error;
      }
    },
    async listIssueComments({ repository, issueNumber }) {
      const comments = await octokit.paginate(
        octokit.rest.issues.listComments,
        {
          owner: repository.owner,
          repo: repository.name,
          issue_number: issueNumber,
          per_page: 100,
        },
      );

      return comments.map((comment) => ({
        id: comment.id,
        body: comment.body ?? "",
        authorLogin: comment.user?.login ?? "",
      }));
    },
    async getActorLogin() {
      const response = await octokit.rest.users.getAuthenticated();
      return response.data.login;
    },
    async deleteIssueComment({ repository, id }) {
      await octokit.rest.issues.deleteComment({
        owner: repository.owner,
        repo: repository.name,
        comment_id: id,
      });
    },
  };
}

type IssueCommentOperationStatus =
  "pending" | "completed" | "rejected" | "reconciliation_required";

export interface IssueCommentOutboxOperation extends IssueCommentRequest {
  operationId: string;
  githubActorLogin: string | null;
  bodyDigest: string | null;
  status: IssueCommentOperationStatus;
  githubCommentId: number | null;
}

interface IssueCommentOutboxRow {
  operationId: string;
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  repositoryOwner: string;
  repositoryName: string;
  issueNumber: number;
  body: string;
  githubActorLogin: string | null;
  bodyDigest: string | null;
  status: IssueCommentOperationStatus;
  githubCommentId: number | null;
}

export function createIssueCommentOutbox(database: Database) {
  const selectOperationSql = `SELECT
      operation_id AS operationId,
      request_id AS requestId,
      job_id AS jobId,
      job_lease_id AS jobLeaseId,
      repository_owner AS repositoryOwner,
      repository_name AS repositoryName,
      issue_number AS issueNumber,
      body,
      github_actor_login AS githubActorLogin,
      body_digest AS bodyDigest,
      status,
      github_comment_id AS githubCommentId
    FROM issue_comment_outbox`;
  const selectOperation = database.query(selectOperationSql);

  return {
    enqueue(operation: IssueCommentOutboxOperation) {
      database
        .query(
          `INSERT INTO issue_comment_outbox (
            operation_id,
            request_id,
            job_id,
            job_lease_id,
            repository_owner,
            repository_name,
            issue_number,
            body,
            github_actor_login,
            body_digest,
            status,
            github_comment_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          operation.operationId,
          operation.requestId,
          operation.jobId,
          operation.jobLeaseId,
          operation.repository.owner,
          operation.repository.name,
          operation.issueNumber,
          operation.body,
          operation.githubActorLogin,
          operation.bodyDigest,
          operation.status,
          operation.githubCommentId,
        );
    },
    find(operationId: string): IssueCommentOutboxOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE operation_id = ?`)
        .get(operationId) as IssueCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    findByRequest(
      jobId: string,
      requestId: string,
    ): IssueCommentOutboxOperation | null {
      const row = database
        .query(`${selectOperationSql} WHERE job_id = ? AND request_id = ?`)
        .get(jobId, requestId) as IssueCommentOutboxRow | null;

      return row === null ? null : fromRow(row);
    },
    adopt(operationId: string, jobLeaseId: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET job_lease_id = ?
          WHERE operation_id = ?`,
        )
        .run(jobLeaseId, operationId);
    },
    setActorLogin(operationId: string, actorLogin: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET github_actor_login = ?
          WHERE operation_id = ?`,
        )
        .run(actorLogin, operationId);
    },
    complete(operationId: string, githubCommentId: number) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'completed', github_comment_id = ?
          WHERE operation_id = ?`,
        )
        .run(githubCommentId, operationId);
    },
    reject(operationId: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'rejected'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    requireReconciliation(operationId: string) {
      database
        .query(
          `UPDATE issue_comment_outbox
          SET status = 'reconciliation_required'
          WHERE operation_id = ?`,
        )
        .run(operationId);
    },
    pending(): IssueCommentOutboxOperation[] {
      return (selectOperation.all() as IssueCommentOutboxRow[])
        .map(fromRow)
        .filter(
          (operation) =>
            operation.status === "pending" ||
            operation.status === "reconciliation_required",
        );
    },
  };
}

function fromRow(row: IssueCommentOutboxRow): IssueCommentOutboxOperation {
  return {
    type: "issue_comment.request",
    operationId: row.operationId,
    requestId: row.requestId,
    jobId: row.jobId,
    jobLeaseId: row.jobLeaseId,
    repository: {
      owner: row.repositoryOwner,
      name: row.repositoryName,
    },
    issueNumber: row.issueNumber,
    body: row.body,
    githubActorLogin: row.githubActorLogin,
    bodyDigest: row.bodyDigest,
    status: row.status,
    githubCommentId: row.githubCommentId,
  };
}

type IssueCommentOutbox = ReturnType<typeof createIssueCommentOutbox>;

interface IssueCommentServiceDependencies {
  outbox: IssueCommentOutbox;
  ownershipVerifier: JobOwnershipVerifier;
  publisher: GitHubIssueCommentPublisher;
  newOperationId?: () => string;
}

export function createIssueCommentService({
  outbox,
  ownershipVerifier,
  publisher,
  newOperationId = randomUUID,
}: IssueCommentServiceDependencies) {
  const pendingDeliveries = new Map<string, Promise<void>>();
  const outcomeWaiters = new Map<
    string,
    Array<(event: IssueCommentEvent) => void>
  >();

  async function accept(
    request: IssueCommentRequest,
  ): Promise<IssueCommentAcceptedEvent | IssueCommentRejectedEvent> {
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
    const operation: IssueCommentOutboxOperation = {
      ...request,
      operationId,
      githubActorLogin: null,
      bodyDigest: null,
      status: "pending",
      githubCommentId: null,
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
          "Issue-comment outbox operation could not be persisted",
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

    if (deliverableOperation.githubActorLogin === null) {
      const actorLogin = await publisher.getActorLogin();
      outbox.setActorLogin(deliverableOperation.operationId, actorLogin);
      deliverableOperation = outbox.find(operationId) ?? deliverableOperation;
    }

    if (!(await hasCurrentOwnership(deliverableOperation))) {
      finishRejected(deliverableOperation, "ownership_not_current");
      return;
    }

    try {
      const comment = await publisher.createIssueComment({
        repository: deliverableOperation.repository,
        issueNumber: deliverableOperation.issueNumber,
        body: commentBody(deliverableOperation),
      });
      outbox.complete(deliverableOperation.operationId, comment.id);
      notify(completed(outbox.find(deliverableOperation.operationId)!));
    } catch (error) {
      await reconcile(
        deliverableOperation,
        error instanceof GitHubIssueCommentRejectedError,
        true,
      );
    }
  }

  /**
   * 結果不明の操作は盲目的に再送しない。外部状態を読み直し、同じ論理返信があれば
   * 一件へ圧縮して完了とし、無ければ一度だけ再送してからもう一度読み直す。
   */
  async function reconcile(
    operation: IssueCommentOutboxOperation,
    definitelyRejected: boolean,
    allowResend: boolean,
  ): Promise<void> {
    const comments = await publisher.listIssueComments(operation);
    const matches = comments
      .filter(
        (comment) =>
          comment.authorLogin === operation.githubActorLogin &&
          digest(comment.body) === expectedBodyDigest(operation),
      )
      .sort((left, right) => left.id - right.id);

    if (matches.length === 0) {
      if (definitelyRejected) {
        finishRejected(operation, "github_rejected");
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
        await publisher.deleteIssueComment({
          repository: operation.repository,
          id: duplicate.id,
        });
      } catch {
        requireReconciliation(operation);
        return;
      }
    }

    outbox.complete(operation.operationId, canonical.id);
    notify(completed(outbox.find(operation.operationId)!));
  }

  async function resend(operation: IssueCommentOutboxOperation): Promise<void> {
    if (!(await hasCurrentOwnership(operation))) {
      finishRejected(operation, "ownership_not_current");
      return;
    }

    try {
      await publisher.createIssueComment({
        repository: operation.repository,
        issueNumber: operation.issueNumber,
        body: commentBody(operation),
      });
    } catch (error) {
      await reconcile(
        operation,
        error instanceof GitHubIssueCommentRejectedError,
        false,
      );
      return;
    }

    // 遅れて反映された最初の送信と重複しうるため、再送後も読み直して圧縮する。
    await reconcile(operation, false, false);
  }

  function waitForOutcome(operationId: string): Promise<IssueCommentEvent> {
    const operation = outbox.find(operationId);

    if (operation === null) {
      throw new Error("Issue-comment operation was not found");
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

  function notify(event: IssueCommentEvent) {
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
      IssueCommentRequest,
      "jobId" | "jobLeaseId" | "repository" | "issueNumber"
    >,
  ) {
    const resumptions: Array<Promise<void>> = [];

    for (const operation of outbox.pending()) {
      if (binding !== undefined && !sameBinding(operation, binding)) {
        continue;
      }

      // 再接続では新しい取得IDで同じ論理操作を引き継ぎ、現在状態を確認し直す。
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

  async function resume(operation: IssueCommentOutboxOperation): Promise<void> {
    if (!(await hasCurrentOwnership(operation))) {
      return;
    }

    let resumableOperation = operation;

    if (resumableOperation.githubActorLogin === null) {
      const actorLogin = await publisher.getActorLogin();
      outbox.setActorLogin(resumableOperation.operationId, actorLogin);
      resumableOperation =
        outbox.find(resumableOperation.operationId) ?? resumableOperation;
    }

    await reconcile(resumableOperation, false, true);
  }

  return { accept, dispatch, resumePending, waitForOutcome };

  async function hasCurrentOwnership(
    operation: Pick<
      IssueCommentRequest,
      "jobId" | "jobLeaseId" | "repository" | "issueNumber"
    >,
  ) {
    return ownershipVerifier.hasCurrentJobOwnership(operation);
  }

  function finishRejected(
    operation: IssueCommentOutboxOperation,
    reason: IssueCommentRejectedEvent["reason"],
  ) {
    outbox.reject(operation.operationId);
    notify(rejected(operation.requestId, reason, operation.operationId));
  }

  function requireReconciliation(operation: IssueCommentOutboxOperation) {
    outbox.requireReconciliation(operation.operationId);
    notify(reconciliationRequired(operation));
  }
}

function sameRequest(
  operation: IssueCommentOutboxOperation,
  request: IssueCommentRequest,
) {
  return (
    operation.repository.owner === request.repository.owner &&
    operation.repository.name === request.repository.name &&
    operation.issueNumber === request.issueNumber &&
    operation.body === request.body
  );
}

function sameBinding(
  operation: IssueCommentOutboxOperation,
  binding: Pick<
    IssueCommentRequest,
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

function isTerminal(operation: IssueCommentOutboxOperation) {
  return operation.status === "completed" || operation.status === "rejected";
}

function outcomeFor(
  operation: IssueCommentOutboxOperation,
): IssueCommentEvent | null {
  if (operation.status === "completed") {
    return completed(operation);
  }

  if (operation.status === "reconciliation_required") {
    return reconciliationRequired(operation);
  }

  if (operation.status === "rejected") {
    return rejected(
      operation.requestId,
      "github_rejected",
      operation.operationId,
    );
  }

  return null;
}

function accepted(
  requestId: string,
  operationId: string,
): IssueCommentAcceptedEvent {
  return {
    type: "issue_comment.accepted",
    requestId,
    operationId,
  };
}

function completed(
  operation: IssueCommentOutboxOperation,
): IssueCommentCompletedEvent {
  return {
    type: "issue_comment.completed",
    requestId: operation.requestId,
    operationId: operation.operationId,
    githubCommentId: operation.githubCommentId as number,
  };
}

function rejected(
  requestId: string,
  reason: IssueCommentRejectedEvent["reason"],
  operationId?: string,
): IssueCommentRejectedEvent {
  return {
    type: "issue_comment.rejected",
    requestId,
    ...(operationId === undefined ? {} : { operationId }),
    reason,
  };
}

function reconciliationRequired(
  operation: IssueCommentOutboxOperation,
): IssueCommentReconciliationRequiredEvent {
  return {
    type: "issue_comment.reconciliation_required",
    requestId: operation.requestId,
    operationId: operation.operationId,
  };
}

function commentBody(operation: IssueCommentOutboxOperation) {
  return `${operation.body}\n\n${operationMarker(operation.operationId)}`;
}

function expectedBodyDigest(operation: IssueCommentOutboxOperation) {
  return operation.bodyDigest ?? digest(commentBody(operation));
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
