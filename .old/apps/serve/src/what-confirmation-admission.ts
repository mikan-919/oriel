import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import {
  createGitHubIssueConversationAdmission,
  type IssueConversationAdmission,
} from "./issue-conversation-admission";

/**
 * WHAT確定Jobの受け入れ判定。
 *
 * issue-conversation-admissionと同じ「現在のWHATだけを対象にする」「所有権取得
 * 前後の二度読み一致」を再利用しつつ、jobIdへトリガーとなったcomment IDを
 * 折り込む。同じcommentを複数回pollしても同じJobキーになり、`already_owned`で
 * 自然に重複を避けられる一方、次のcommentが来れば別のJobキーになる。
 */
export function createWhatConfirmationAdmission(
  octokit: Octokit,
  triggerCommentId: number,
): IssueConversationAdmission {
  const base = createGitHubIssueConversationAdmission(octokit);

  return {
    async admit(input: {
      repositoryId: number;
      repository: GitHubRepository;
      issueNumber: number;
    }) {
      const result = await base.admit(input);

      return result.status === "refused"
        ? result
        : { ...result, jobId: `${result.jobId}:comment-${triggerCommentId}` };
    },
    reconfirm: base.reconfirm,
  };
}
