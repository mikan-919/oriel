import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import { createGitHubIssueConversationAdmission } from "./issue-conversation-admission";

const repository = { owner: "mikan-919", name: "oriel" };
const repositoryId = 11;

function octokitFor(
  issue: {
    state: string;
    title: string;
    body: string;
    updated_at: string;
    repository?: { id: number };
  } | null,
) {
  return {
    rest: {
      issues: {
        get: async () => {
          if (issue === null) {
            throw new Error("Not Found");
          }

          return { data: { repository: { id: repositoryId }, ...issue } };
        },
      },
    },
  } as unknown as Octokit;
}

const openIssue = {
  state: "open",
  title: "deviceの登録と失効を製品経路で通す",
  body: "本文",
  updated_at: "2026-08-13T00:00:00Z",
};

test("only the current open Issue of the registered repository is admitted", async () => {
  const admission = createGitHubIssueConversationAdmission(
    octokitFor(openIssue),
  );
  const admitted = await admission.admit({
    repositoryId,
    repository,
    issueNumber: 30,
  });

  expect(admitted).toMatchObject({ status: "admitted" });

  if (admitted.status !== "admitted") {
    return;
  }

  // JobキーはWHATの現在値の指紋から導く。clientは指定できない。
  expect(admitted.jobId).toStartWith(`issue-conversation:${repositoryId}:30:`);
  expect(admitted.jobId).toEndWith(admitted.approvalFingerprint.slice(0, 16));

  expect(
    await createGitHubIssueConversationAdmission(octokitFor(null)).admit({
      repositoryId,
      repository,
      issueNumber: 30,
    }),
  ).toEqual({ status: "refused", reason: "issue_not_found" });

  expect(
    await createGitHubIssueConversationAdmission(
      octokitFor({ ...openIssue, state: "closed" }),
    ).admit({ repositoryId, repository, issueNumber: 30 }),
  ).toEqual({ status: "refused", reason: "issue_not_open" });

  expect(
    await createGitHubIssueConversationAdmission(
      octokitFor({ ...openIssue, repository: { id: repositoryId + 1 } }),
    ).admit({ repositoryId, repository, issueNumber: 30 }),
  ).toEqual({ status: "refused", reason: "repository_mismatch" });
});

test("the second read refuses a WHAT that changed after the first read", async () => {
  const admission = createGitHubIssueConversationAdmission(
    octokitFor(openIssue),
  );
  const admitted = await admission.admit({
    repositoryId,
    repository,
    issueNumber: 30,
  });

  if (admitted.status !== "admitted") {
    throw new Error("the Issue was refused");
  }

  expect(
    await admission.reconfirm({
      repository,
      issueNumber: 30,
      approvalFingerprint: admitted.approvalFingerprint,
    }),
  ).toBe(true);

  const changed = createGitHubIssueConversationAdmission(
    octokitFor({ ...openIssue, title: "改訂されたWHAT" }),
  );

  expect(
    await changed.reconfirm({
      repository,
      issueNumber: 30,
      approvalFingerprint: admitted.approvalFingerprint,
    }),
  ).toBe(false);
});
