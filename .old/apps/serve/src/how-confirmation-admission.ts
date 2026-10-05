import { createHash } from "node:crypto";

import type { LinearApprovalReader } from "./github-approval-ports";
import { triageStateName } from "./linear-approval";

/**
 * HOW確定対話の受け入れ判定。
 *
 * issue-conversation-admission.tsと同じ「現在値だけを対象にする」「所有権
 * 取得の前後で二度読んで一致した現在値だけを実行条件にする」「JobキーをHOWの
 * 指紋から導く」を、Linear issueのtitle・descriptionを対象に行う。Triage状態
 * だけを受け入れ、Todoへ移った(=人間が承認した)ものは対象外にする。この入口は
 * コードを変更しないため、canonicalブランチの排他も取得しない。
 */
export interface LinearIssueConversationAdmission {
  admit(input: {
    repositoryId: number;
    issueNumber: number;
    linearIssueId: string;
  }): Promise<AdmittedLinearIssueConversation | RefusedLinearIssueConversation>;
  reconfirm(input: {
    linearIssueId: string;
    approvalFingerprint: string;
  }): Promise<boolean>;
}

export interface AdmittedLinearIssueConversation {
  status: "admitted";
  /** clientが指定できないJobキー。現在のHOWの指紋から導く。 */
  jobId: string;
  approvalFingerprint: string;
}

export interface RefusedLinearIssueConversation {
  status: "refused";
  reason: "linear_issue_not_found" | "linear_issue_not_triage";
}

async function readLinearFingerprint(
  reader: LinearApprovalReader,
  linearIssueId: string,
): Promise<{ stateName: string; fingerprint: string } | null> {
  const issue = await reader.readIssue(linearIssueId);

  if (issue === null) {
    return null;
  }

  return {
    stateName: issue.stateName,
    fingerprint: createHash("sha256")
      .update(JSON.stringify([issue.title, issue.description ?? ""]))
      .digest("hex"),
  };
}

export function createLinearIssueConversationAdmission(
  reader: LinearApprovalReader,
): LinearIssueConversationAdmission {
  return {
    async admit({ repositoryId, issueNumber, linearIssueId }) {
      const current = await readLinearFingerprint(reader, linearIssueId);

      if (current === null) {
        return { status: "refused", reason: "linear_issue_not_found" };
      }

      if (current.stateName !== triageStateName) {
        return { status: "refused", reason: "linear_issue_not_triage" };
      }

      return {
        status: "admitted",
        jobId: `linear-conversation:${repositoryId}:${issueNumber}:${current.fingerprint.slice(0, 16)}`,
        approvalFingerprint: current.fingerprint,
      };
    },
    async reconfirm({ linearIssueId, approvalFingerprint }) {
      const current = await readLinearFingerprint(reader, linearIssueId);

      return (
        current !== null &&
        current.stateName === triageStateName &&
        current.fingerprint === approvalFingerprint
      );
    },
  };
}
