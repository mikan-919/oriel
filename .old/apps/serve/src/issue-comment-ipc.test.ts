import { expect, test } from "bun:test";

import {
  createIssueCommentOutbox,
  createIssueCommentService,
} from "./issue-comments";
import { serveOwnedHarnessIssueCommentIpc } from "./issue-comment-ipc";
import { openServeLocalState } from "./local-state";

test("serves only the bound harness Job through its stdio NDJSON channel", async () => {
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  const database = openServeLocalState(":memory:");
  const service = createIssueCommentService({
    outbox: createIssueCommentOutbox(database),
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
    publisher: {
      createIssueComment: async () => ({ id: 1234 }),
      getActorLogin: async () => "oriel-bot",
      listIssueComments: async () => [],
      deleteIssueComment: async () => {},
    },
    newOperationId: () => "operation-1",
  });
  const serving = serveOwnedHarnessIssueCommentIpc(
    harnessToServe.readable,
    serveToHarness.writable,
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
    service,
  );
  const input = harnessToServe.writable.getWriter();
  const output = serveToHarness.readable.getReader();

  await input.write(
    new TextEncoder().encode(
      `${JSON.stringify({
        type: "issue_comment.request",
        requestId: "request-1",
        jobId: "issue-conversation-1",
        jobLeaseId: "lease-1",
        repository: { owner: "mikan-919", name: "oriel" },
        issueNumber: 28,
        body: "Agent reply",
      })}\n`,
    ),
  );

  const decoder = new TextDecoder();
  const accepted = JSON.parse(decoder.decode((await output.read()).value));
  const completed = JSON.parse(decoder.decode((await output.read()).value));

  expect(accepted).toEqual({
    type: "issue_comment.accepted",
    requestId: "request-1",
    operationId: "operation-1",
  });
  expect(completed).toEqual({
    type: "issue_comment.completed",
    requestId: "request-1",
    operationId: "operation-1",
    githubCommentId: 1234,
  });

  await input.close();
  await serving;
  output.releaseLock();
  database.close();
});

test("rejects a harness request that does not match its serve-owned Job binding", async () => {
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  const database = openServeLocalState(":memory:");
  let ownershipChecked = false;
  const serving = serveOwnedHarnessIssueCommentIpc(
    harnessToServe.readable,
    serveToHarness.writable,
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
    createIssueCommentService({
      outbox: createIssueCommentOutbox(database),
      ownershipVerifier: {
        hasCurrentJobOwnership: () => {
          ownershipChecked = true;
          return true;
        },
      },
      publisher: {
        createIssueComment: async () => ({ id: 1234 }),
        getActorLogin: async () => "oriel-bot",
        listIssueComments: async () => [],
        deleteIssueComment: async () => {},
      },
    }),
  );
  const input = harnessToServe.writable.getWriter();
  const output = serveToHarness.readable.getReader();

  await input.write(
    new TextEncoder().encode(
      `${JSON.stringify({
        type: "issue_comment.request",
        requestId: "request-1",
        jobId: "other-job",
        jobLeaseId: "lease-1",
        repository: { owner: "mikan-919", name: "oriel" },
        issueNumber: 28,
        body: "Agent reply",
      })}\n`,
    ),
  );

  expect(
    JSON.parse(new TextDecoder().decode((await output.read()).value)),
  ).toEqual({
    type: "issue_comment.rejected",
    requestId: "request-1",
    reason: "target_mismatch",
  });
  expect(ownershipChecked).toBe(false);

  await input.close();
  await serving;
  output.releaseLock();
  database.close();
});

test("stops serving the harness worker when the ownership connection stops", async () => {
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  const database = openServeLocalState(":memory:");
  const stopped = new AbortController();
  let requestsAccepted = 0;
  const serving = serveOwnedHarnessIssueCommentIpc(
    harnessToServe.readable,
    serveToHarness.writable,
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
    createIssueCommentService({
      outbox: createIssueCommentOutbox(database),
      ownershipVerifier: {
        hasCurrentJobOwnership: () => {
          requestsAccepted += 1;
          return true;
        },
      },
      publisher: {
        createIssueComment: async () => ({ id: 1234 }),
        getActorLogin: async () => "oriel-bot",
        listIssueComments: async () => [],
        deleteIssueComment: async () => {},
      },
    }),
    stopped.signal,
  );
  const input = harnessToServe.writable.getWriter();

  stopped.abort();
  await serving;
  await input
    .write(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "issue_comment.request",
          requestId: "request-1",
          jobId: "issue-conversation-1",
          jobLeaseId: "lease-1",
          repository: { owner: "mikan-919", name: "oriel" },
          issueNumber: 28,
          body: "Agent reply",
        })}\n`,
      ),
    )
    .catch(() => {});

  expect(requestsAccepted).toBe(0);
  database.close();
});
