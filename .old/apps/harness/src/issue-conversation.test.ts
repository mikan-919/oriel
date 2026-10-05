import { expect, test } from "bun:test";

import {
  createNdjsonIssueCommentOperationClient,
  postIssueConversationReply,
} from "./issue-conversation";

test("an explicitly launched Issue conversation exchanges request and completion events over NDJSON IPC", async () => {
  const written: unknown[] = [];
  const received = [
    {
      type: "issue_comment.accepted",
      requestId: "request-1",
      operationId: "operation-1",
    },
    {
      type: "issue_comment.completed",
      requestId: "request-1",
      operationId: "operation-1",
      githubCommentId: 1234,
    },
  ];
  const operationClient = createNdjsonIssueCommentOperationClient({
    write: (message) => {
      written.push(message);
    },
    read: async () => {
      const event = received.shift();

      if (event === undefined) {
        throw new Error("No event was available from serve");
      }

      return event;
    },
  });
  const events: unknown[] = [];

  await postIssueConversationReply(
    {
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
      body: "Agent reply",
    },
    operationClient,
    (event) => events.push(event),
  );

  expect(written).toEqual([
    {
      type: "issue_comment.request",
      requestId: "request-1",
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
      body: "Agent reply",
    },
  ]);
  expect(events).toEqual([
    {
      type: "issue_comment.accepted",
      requestId: "request-1",
      operationId: "operation-1",
    },
    {
      type: "issue_comment.completed",
      requestId: "request-1",
      operationId: "operation-1",
      githubCommentId: 1234,
    },
  ]);
});
