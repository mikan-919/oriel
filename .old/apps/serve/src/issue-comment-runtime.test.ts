import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";

import { startIssueCommentRuntime } from "./issue-comment-runtime";
import { createRelayOwnershipConnection } from "./ownership-connection";
import { startFakeOwnershipRelay } from "./ownership-relay.fake";

test("runtime startup resumes persisted Issue-comment work and exposes it only through a Job-bound harness channel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-runtime-"));
  const databasePath = join(directory, "serve.sqlite");
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit: {
      rest: {
        issues: {
          createComment: async () => ({ data: { id: 1234 } }),
          listComments: "list-comments" as never,
          deleteComment: async () => {},
        },
        users: {
          getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
        },
      },
      paginate: async () => [],
    } as unknown as Octokit,
    ownershipVerifier: { hasCurrentJobOwnership: () => true },
  });
  const serving = runtime.serveHarnessIssueConversation(
    harnessToServe.readable,
    serveToHarness.writable,
    {
      jobId: "issue-conversation-1",
      jobLeaseId: "lease-1",
      repository: { owner: "mikan-919", name: "oriel" },
      issueNumber: 28,
    },
  );
  const input = harnessToServe.writable.getWriter();
  const output = serveToHarness.readable.getReader();

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
    await serving;
    output.releaseLock();
    runtime.close();
    await rm(directory, { force: true, recursive: true });
  }
});

test("revoking the device stops the worker, refuses new external operations, and moves the Job to interrupted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oriel-issue-revoked-"));
  const databasePath = join(directory, "serve.sqlite");
  const relay = startFakeOwnershipRelay();
  const ownershipVerifier = createRelayOwnershipConnection({
    relayOrigin: relay.origin,
    deviceToken: "7.11.device-token",
    jobId: "issue-conversation-1",
    heartbeatStopMs: 1_000,
  });
  const jobLeaseId = await ownershipVerifier.acquireJobOwnership();

  await ownershipVerifier.acquireBranchExclusivity("11/oriel-job-1");
  const harnessToServe = new TransformStream<Uint8Array, Uint8Array>();
  const serveToHarness = new TransformStream<Uint8Array, Uint8Array>();
  let published = 0;
  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit: {
      rest: {
        issues: {
          createComment: async () => ({ data: { id: ++published } }),
          listComments: "list-comments" as never,
          deleteComment: async () => {},
        },
        users: {
          getAuthenticated: async () => ({ data: { login: "oriel-bot" } }),
        },
      },
      paginate: async () => [],
    } as unknown as Octokit,
    ownershipVerifier,
  });
  const binding = {
    jobId: "issue-conversation-1",
    jobLeaseId: jobLeaseId ?? "",
    repository: { owner: "mikan-919", name: "oriel" },
    issueNumber: 28,
  };
  const serving = runtime.serveHarnessIssueConversation(
    harnessToServe.readable,
    serveToHarness.writable,
    binding,
  );
  const input = harnessToServe.writable.getWriter();

  try {
    expect(runtime.jobStatus(binding.jobId)).toBe("running");

    // relayがdeviceを失効させ、所有権接続とブランチ排他を閉じる。
    relay.revokeDevice();
    await Bun.sleep(50);

    expect(ownershipVerifier.stopSignal.aborted).toBe(true);
    expect(relay.openConnections()).toBe(0);
    expect(runtime.jobStatus(binding.jobId)).toBe("interrupted");

    // 失効後はharnessからの要求経路自体が閉じている。書き込みは受け付けない。
    const writeAfterRevocation = await input
      .write(
        new TextEncoder().encode(
          `${JSON.stringify({
            type: "issue_comment.request",
            requestId: "request-after-revocation",
            ...binding,
            body: "Agent reply after the device was revoked",
          })}\n`,
        ),
      )
      .then(
        () => "accepted",
        () => "refused",
      );

    expect(writeAfterRevocation).toBe("refused");
    await input.close().catch(() => undefined);
    await serving;

    // 失効後に新しい外部操作を送っていない。
    expect(published).toBe(0);
    expect(runtime.jobStatus(binding.jobId)).toBe("interrupted");
  } finally {
    ownershipVerifier.release();
    relay.stop();
    runtime.close();
    await rm(directory, { force: true, recursive: true });
  }
});
