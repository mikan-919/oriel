import { expect, test } from "bun:test";

import {
  createLinearCommentOutbox,
  createLinearCommentService,
  LinearCommentRejectedError,
  type LinearCommentPublisher,
} from "./linear-comments";
import { openServeLocalState } from "./local-state";

const request = {
  type: "linear_comment.request" as const,
  requestId: "request-1",
  jobId: "linear-conversation-1",
  jobLeaseId: "lease-1",
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 34,
  linearIssueId: "lin-1",
  body: "Agent reply",
};

function publisher(
  overrides: Partial<LinearCommentPublisher> = {},
): LinearCommentPublisher {
  return {
    createComment: async () => ({ id: "comment-1" }),
    getViewerId: async () => "actor-1",
    listComments: async () => [],
    deleteComment: async () => {},
    ...overrides,
  };
}

test("accepts an owned Linear-comment request and persists the outbox operation before Linear responds", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const result = Promise.withResolvers<{ id: string }>();
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({ createComment: () => result.promise }),
    newOperationId: () => "operation-1",
  });

  const accepted = await service.accept(request);

  expect(accepted).toEqual({
    type: "linear_comment.accepted",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(outbox.find("operation-1")).toMatchObject({
    operationId: "operation-1",
    requestId: "request-1",
    status: "pending",
    linearActorId: "actor-1",
  });

  result.resolve({ id: "comment-1" });
  await service.waitForOutcome("operation-1");
  database.close();
});

test("refuses a Linear-comment request when current Job ownership is absent", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => false },
    publisher: publisher(),
    newOperationId: () => "operation-1",
  });

  expect(await service.accept(request)).toEqual({
    type: "linear_comment.rejected",
    requestId: "request-1",
    reason: "ownership_not_current",
  });
  expect(outbox.find("operation-1")).toBeNull();
  database.close();
});

test("notifies the harness with the completed Linear comment event", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({ createComment: async () => ({ id: "comment-9" }) }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "linear_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    linearCommentId: "comment-9",
  });
  database.close();
});

test("reports a known Linear rejection to the harness", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createComment: async () => {
        throw new LinearCommentRejectedError("issue is locked");
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "linear_comment.rejected",
    requestId: "request-1",
    operationId: "operation-1",
    reason: "linear_rejected",
  });
  expect(outbox.find("operation-1")?.status).toBe("rejected");
  database.close();
});

test("requires reconciliation instead of blindly retrying an unknown Linear result", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createComment: async () => {
        throw new Error("connection lost");
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "linear_comment.reconciliation_required",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(outbox.find("operation-1")?.status).toBe("reconciliation_required");
  database.close();
});

test("reconciliation only selects this actor's exact expected body digest, ordered by createdAt", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  const deletedCommentIds: string[] = [];
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createComment: async () => {
        throw new Error("connection lost");
      },
      listComments: async () => [
        {
          id: "comment-2",
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorId: "actor-1",
          createdAt: "2026-01-01T00:00:02.000Z",
        },
        {
          id: "comment-human",
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorId: "human-1",
          createdAt: "2026-01-01T00:00:01.000Z",
        },
        {
          id: "comment-1",
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorId: "actor-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      deleteComment: async ({ id }) => {
        deletedCommentIds.push(id);
      },
    }),
    newOperationId: () => "operation-1",
  });

  await service.accept(request);

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "linear_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    // 最も古いこのactorの一致がcanonicalになり、後発の重複だけを消す。
    linearCommentId: "comment-1",
  });
  expect(deletedCommentIds).toEqual(["comment-2"]);
  database.close();
});

test("reconciles a persisted pending operation after restart without creating a second comment", async () => {
  const database = openServeLocalState(":memory:");
  const outbox = createLinearCommentOutbox(database);
  outbox.enqueue({
    ...request,
    operationId: "operation-1",
    linearActorId: null,
    bodyDigest: null,
    status: "pending",
    linearCommentId: null,
  });
  let createCalls = 0;
  const service = createLinearCommentService({
    outbox,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: publisher({
      createComment: async () => {
        createCalls += 1;
        return { id: "comment-1" };
      },
      listComments: async () => [
        {
          id: "comment-1",
          body: "Agent reply\n\n<!-- oriel-operation:operation-1 -->",
          authorId: "actor-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  });

  service.resumePending();

  expect(await service.waitForOutcome("operation-1")).toEqual({
    type: "linear_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    linearCommentId: "comment-1",
  });
  expect(createCalls).toBe(0);
  database.close();
});
