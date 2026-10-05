import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

export interface GitHubOpenIssuePort {
  /** open状態のGitHub Issue一覧。Pull Requestを除く。読めなければnull。 */
  listOpenIssues(): Promise<{ number: number; url: string }[] | null>;
}

/**
 * discoveryがJob候補を洗い出すための、GitHub側の現在値だけを読む境界。
 *
 * `github-approval-ports.ts`の`listOpenPullRequestHeadRefs`と同型のtry/catch
 * →nullパターンを使う。GitHubのopen issue一覧APIはPull Requestも含めて返す
 * ため、`pull_request`fieldを持つ要素を除外する。
 */
export function createGitHubOpenIssuePort({
  octokit,
  repository,
}: {
  octokit: Octokit;
  repository: GitHubRepository;
}): GitHubOpenIssuePort {
  return {
    async listOpenIssues() {
      try {
        const issues = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/issues",
          {
            owner: repository.owner,
            repo: repository.name,
            state: "open",
            per_page: 100,
          },
        )) as {
          number?: number;
          html_url?: string;
          pull_request?: unknown;
        }[];

        return issues
          .filter((issue) => issue.pull_request === undefined)
          .map((issue) => ({
            number: issue.number ?? 0,
            url: issue.html_url ?? "",
          }))
          .filter((issue) => issue.number > 0 && issue.url !== "");
      } catch {
        return null;
      }
    },
  };
}
