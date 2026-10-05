import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import { runExplicitIssueConversation } from "./issue-comment-command";

test("the explicit production Issue-conversation entry binds one Job before forwarding harness NDJSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-command-"));
  const inputPipe = new TransformStream<Uint8Array, Uint8Array>();
  const outputPipe = new TransformStream<Uint8Array, Uint8Array>();
  const conversation = {
    jobId: "issue-conversation-1",
    jobLeaseId: "lease-1",
    repository: { owner: "mikan-919", name: "oriel" },
    issueNumber: 28,
  };
  const running = runExplicitIssueConversation({
    input: inputPipe.readable,
    output: outputPipe.writable,
    conversation,
    databasePath: join(directory, "serve.sqlite"),
    octokit: testOctokit(),
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
  });
  const input = inputPipe.writable.getWriter();
  const output = outputPipe.readable.getReader();

  try {
    await input.write(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: "issue_comment.request",
          requestId: "request-1",
          ...conversation,
          body: "Agent reply",
        })}\n`,
      ),
    );

    expect(
      JSON.parse(new TextDecoder().decode((await output.read()).value)),
    ).toMatchObject({ type: "issue_comment.accepted" });
    expect(
      JSON.parse(new TextDecoder().decode((await output.read()).value)),
    ).toMatchObject({
      type: "issue_comment.completed",
      requestId: "request-1",
      githubCommentId: 1234,
    });
  } finally {
    await input.close();
    await running;
    output.releaseLock();
    await rm(directory, { force: true, recursive: true });
  }
});

test("the explicit production Issue-conversation entry uses the trusted current-ownership verifier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-command-"));
  const inputPipe = new TransformStream<Uint8Array, Uint8Array>();
  const outputPipe = new TransformStream<Uint8Array, Uint8Array>();
  const input = inputPipe.writable.getWriter();
  const output = outputPipe.readable.getReader();
  let GitHubWriteAttempted = false;
  const running = runExplicitIssueConversation({
    input: inputPipe.readable,
    output: outputPipe.writable,
    conversation: {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
    databasePath: join(directory, "serve.sqlite"),
    octokit: testOctokit({
      createComment: async () => {
        GitHubWriteAttempted = true;
        return { data: { id: 1234 } };
      },
    }),
    ownershipVerifier: { hasCurrentJobOwnership: () => false },
  });

  try {
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

    expect(
      JSON.parse(new TextDecoder().decode((await output.read()).value)),
    ).toEqual({
      type: "issue_comment.rejected",
      requestId: "request-1",
      reason: "ownership_not_current",
    });
    expect(GitHubWriteAttempted).toBe(false);
  } finally {
    await input.close();
    await running;
    output.releaseLock();
    await rm(directory, { force: true, recursive: true });
  }
});

function testOctokit(
  issueOverrides: Partial<{
    createComment: () => Promise<{ data: { id: number } }>;
  }> = {},
): Octokit {
  return {
    rest: {
      issues: {
        createComment: async () => ({ data: { id: 1234 } }),
        ...issueOverrides,
        listComments: "list-comments" as never,
        deleteComment: async () => {},
      },
      users: {
        getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
      },
    },
    paginate: async () => [],
  } as unknown as Octokit;
}
