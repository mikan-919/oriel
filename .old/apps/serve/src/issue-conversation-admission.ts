import { createHash } from "node:crypto";

import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

/**
 * 明示的に起動したIssue対話の受け入れ判定。
 *
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * うち、この経路が満たすのは「現在のWHATだけを対象にする」「所有権取得の前後で
 * 二度読んで一致した現在値だけを実行条件にする」「JobキーをWHATの指紋から導く」
 * の三つとする。LinearのTriage→Todo、attachment逆引き、ブランチ封印は実装Jobの
 * 条件であり、コードを変更しない対話Jobでは要求しない。この入口はコードを変更
 * するJobを受け付けないため、canonicalブランチの排他も取得しない。
 */
export interface IssueConversationAdmission {
  admit(input: {
    repositoryId: number;
    repository: GitHubRepository;
    issueNumber: number;
  }): Promise<AdmittedIssueConversation | RefusedIssueConversation>;
  /** 所有権を取得した後の二度目の読み直し。 */
  reconfirm(input: {
    repository: GitHubRepository;
    issueNumber: number;
    approvalFingerprint: string;
  }): Promise<boolean>;
}

export interface AdmittedIssueConversation {
  status: "admitted";
  /** clientが指定できないJobキー。現在のWHATの指紋から導く。 */
  jobId: string;
  approvalFingerprint: string;
}

export interface RefusedIssueConversation {
  status: "refused";
  reason: "issue_not_found" | "issue_not_open" | "repository_mismatch";
}

async function readIssueFingerprint(
  octokit: Octokit,
  repository: GitHubRepository,
  issueNumber: number,
): Promise<{
  state: string;
  repositoryId: number;
  fingerprint: string;
} | null> {
  try {
    const issue = await octokit.rest.issues.get({
      owner: repository.owner,
      repo: repository.name,
      issue_number: issueNumber,
    });

    return {
      state: issue.data.state,
      repositoryId: issue.data.repository?.id ?? 0,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            issue.data.title,
            issue.data.body ?? "",
            issue.data.updated_at,
          ]),
        )
        .digest("hex"),
    };
  } catch {
    return null;
  }
}

export function createGitHubIssueConversationAdmission(
  octokit: Octokit,
): IssueConversationAdmission {
  return {
    async admit({ repositoryId, repository, issueNumber }) {
      const current = await readIssueFingerprint(
        octokit,
        repository,
        issueNumber,
      );

      if (current === null) {
        return { status: "refused", reason: "issue_not_found" };
      }

      if (current.repositoryId !== repositoryId) {
        return { status: "refused", reason: "repository_mismatch" };
      }

      if (current.state !== "open") {
        return { status: "refused", reason: "issue_not_open" };
      }

      return {
        status: "admitted",
        jobId: `issue-conversation:${repositoryId}:${issueNumber}:${current.fingerprint.slice(0, 16)}`,
        approvalFingerprint: current.fingerprint,
      };
    },
    async reconfirm({ repository, issueNumber, approvalFingerprint }) {
      const current = await readIssueFingerprint(
        octokit,
        repository,
        issueNumber,
      );

      return (
        current !== null &&
        current.state === "open" &&
        current.fingerprint === approvalFingerprint
      );
    },
  };
}
