import { expect, test } from "bun:test";
import type { Octokit } from "@octokit/rest";

import { createWhatConfirmationAdmission } from "./what-confirmation-admission";

const repository = { owner: "acme", name: "widgets" };
const repositoryId = 11;

function octokitFor(issue: {
  state: string;
  title: string;
  body: string;
  updated_at: string;
}) {
  return {
    rest: {
      issues: {
        get: async () => ({
          data: { repository: { id: repositoryId }, ...issue },
        }),
      },
    },
  } as unknown as Octokit;
}

const openIssue = {
  state: "open",
  title: "Slow dashboard",
  body: "It takes 8s to load",
  updated_at: "2026-08-16T00:00:00Z",
};

test("folds the triggering comment id into the jobId so distinct comments admit distinct Jobs", async () => {
  const octokit = octokitFor(openIssue);
  const first = createWhatConfirmationAdmission(octokit, 101);
  const second = createWhatConfirmationAdmission(octokit, 202);

  const admittedFirst = await first.admit({
    repositoryId,
    repository,
    issueNumber: 28,
  });
  const admittedSecond = await second.admit({
    repositoryId,
    repository,
    issueNumber: 28,
  });

  expect(admittedFirst.status).toBe("admitted");
  expect(admittedSecond.status).toBe("admitted");
  expect(admittedFirst).not.toEqual(admittedSecond);

  if (
    admittedFirst.status === "admitted" &&
    admittedSecond.status === "admitted"
  ) {
    expect(admittedFirst.jobId).toContain(":comment-101");
    expect(admittedSecond.jobId).toContain(":comment-202");
    expect(admittedFirst.jobId).not.toBe(admittedSecond.jobId);
    // 同じ現在値からの承認指紋そのものは、トリガーによらず同じであるべき。
    expect(admittedFirst.approvalFingerprint).toBe(
      admittedSecond.approvalFingerprint,
    );
  }
});

test("reconfirm still validates against the current Issue, not the trigger comment", async () => {
  const octokit = octokitFor(openIssue);
  const admission = createWhatConfirmationAdmission(octokit, 101);
  const admitted = await admission.admit({
    repositoryId,
    repository,
    issueNumber: 28,
  });

  expect(admitted.status).toBe("admitted");

  if (admitted.status === "admitted") {
    expect(
      await admission.reconfirm({
        repository,
        issueNumber: 28,
        approvalFingerprint: admitted.approvalFingerprint,
      }),
    ).toBe(true);
    expect(
      await admission.reconfirm({
        repository,
        issueNumber: 28,
        approvalFingerprint: "a".repeat(64),
      }),
    ).toBe(false);
  }
});
