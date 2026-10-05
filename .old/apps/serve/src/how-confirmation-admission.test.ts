import { expect, test } from "bun:test";

import type { LinearApprovalReader } from "./github-approval-ports";
import { createLinearIssueConversationAdmission } from "./how-confirmation-admission";

const repositoryId = 11;
const issueNumber = 34;

function readerFor(
  issue: {
    title: string;
    description: string | null;
    stateName: string;
  } | null,
): LinearApprovalReader {
  return {
    readIssue: async () =>
      issue === null
        ? null
        : {
            issueId: "lin-1",
            identifier: "ORI-1",
            title: issue.title,
            description: issue.description,
            stateName: issue.stateName,
            attachmentUrls: [],
          },
  };
}

const triageIssue = {
  title: "HOW draft",
  description: "本文",
  stateName: "Triage",
};

test("only a Triage-state Linear issue is admitted", async () => {
  const admission = createLinearIssueConversationAdmission(
    readerFor(triageIssue),
  );
  const admitted = await admission.admit({
    repositoryId,
    issueNumber,
    linearIssueId: "lin-1",
  });

  expect(admitted).toMatchObject({ status: "admitted" });

  if (admitted.status !== "admitted") {
    return;
  }

  // JobキーはHOWの現在値の指紋から導く。clientは指定できない。
  expect(admitted.jobId).toStartWith(
    `linear-conversation:${repositoryId}:${issueNumber}:`,
  );
  expect(admitted.jobId).toEndWith(admitted.approvalFingerprint.slice(0, 16));

  expect(
    await createLinearIssueConversationAdmission(readerFor(null)).admit({
      repositoryId,
      issueNumber,
      linearIssueId: "lin-1",
    }),
  ).toEqual({ status: "refused", reason: "linear_issue_not_found" });

  expect(
    await createLinearIssueConversationAdmission(
      readerFor({ ...triageIssue, stateName: "Todo" }),
    ).admit({ repositoryId, issueNumber, linearIssueId: "lin-1" }),
  ).toEqual({ status: "refused", reason: "linear_issue_not_triage" });
});

test("the second read refuses a HOW that changed after the first read", async () => {
  const admission = createLinearIssueConversationAdmission(
    readerFor(triageIssue),
  );
  const admitted = await admission.admit({
    repositoryId,
    issueNumber,
    linearIssueId: "lin-1",
  });

  if (admitted.status !== "admitted") {
    throw new Error("the Linear issue was refused");
  }

  expect(
    await admission.reconfirm({
      linearIssueId: "lin-1",
      approvalFingerprint: admitted.approvalFingerprint,
    }),
  ).toBe(true);

  const changed = createLinearIssueConversationAdmission(
    readerFor({ ...triageIssue, description: "改訂されたHOW" }),
  );

  expect(
    await changed.reconfirm({
      linearIssueId: "lin-1",
      approvalFingerprint: admitted.approvalFingerprint,
    }),
  ).toBe(false);
});

test("Triage to Todo revokes reconfirmation even with an unchanged fingerprint", async () => {
  const admission = createLinearIssueConversationAdmission(
    readerFor({ ...triageIssue, stateName: "Todo" }),
  );

  expect(
    await admission.reconfirm({
      linearIssueId: "lin-1",
      approvalFingerprint: "irrelevant",
    }),
  ).toBe(false);
});
