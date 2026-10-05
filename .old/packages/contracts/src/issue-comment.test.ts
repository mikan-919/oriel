import { expect, test } from "bun:test";

import { type IssueCommentRequest, parseIssueCommentRequest } from "./index";

test("accepts the narrow Issue-comment request from a harness", () => {
  const request = {
    type: "issue_comment.request",
    requestId: "request-1",
    jobId: "issue-conversation-1",
    jobLeaseId: "lease-1",
    repository: { owner: "mikan-919", name: "oriel" },
    issueNumber: 28,
    body: "Agent reply",
  } satisfies IssueCommentRequest;

  expect(parseIssueCommentRequest(request)).toEqual(request);
});

test("rejects credentials and unknown fields from a harness request", () => {
  const request = {
    type: "issue_comment.request",
    requestId: "request-1",
    jobId: "issue-conversation-1",
    jobLeaseId: "lease-1",
    repository: { owner: "mikan-919", name: "oriel" },
    issueNumber: 28,
    body: "Agent reply",
    githubToken: "must-not-cross-the-boundary",
  };

  expect(() => parseIssueCommentRequest(request)).toThrow();
});
