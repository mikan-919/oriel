import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { PullRequestPorts } from "./pull-request";

export interface GitHubPullRequestPortsOptions {
  octokit: Octokit;
  repository: GitHubRepository;
}

/**
 * ADR 0004/0005のPull Request作成がGitHubへ触る境界。用途を絞った
 * `pull_request` installation tokenだけを使う。
 */
export function createGitHubPullRequestPorts({
  octokit,
  repository,
}: GitHubPullRequestPortsOptions): PullRequestPorts {
  const owner = repository.owner;
  const name = repository.name;

  return {
    async listOpenPullRequestsByHeadBase({ head, base }) {
      try {
        const pulls = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/pulls",
          {
            owner,
            repo: name,
            head: `${owner}:${head}`,
            base,
            state: "open",
            per_page: 100,
          },
        )) as { number: number }[];

        return pulls.map((pull) => ({ number: pull.number }));
      } catch {
        return null;
      }
    },
    async createPullRequest({ head, base, title, body }) {
      try {
        const created = await octokit.rest.pulls.create({
          owner,
          repo: name,
          head,
          base,
          title,
          body,
        });

        return { number: created.data.number };
      } catch (error) {
        const failure = error as { status?: number; message?: string };

        // 別の試行が直前に同じhead/baseで作った。弱いfallbackはせず呼び出し側で
        // 現在値を読み直す。
        return failure.status === 422 &&
          /already exists/i.test(failure.message ?? "")
          ? "already_exists"
          : null;
      }
    },
    async closeDuplicatePullRequest({ number, canonicalNumber }) {
      try {
        await octokit.rest.issues.createComment({
          owner,
          repo: name,
          issue_number: number,
          body: `Duplicate of #${canonicalNumber}. Closing this pull request in favor of the canonical one.`,
        });
        await octokit.rest.pulls.update({
          owner,
          repo: name,
          pull_number: number,
          state: "closed",
        });

        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * merge確認だけに使う境界。ADR 0005「Linear状態」のmerge検出loopがこれだけを使う。
 */
export function createGitHubPullRequestMergeCheck({
  octokit,
  repository,
}: GitHubPullRequestPortsOptions) {
  return {
    /** 読めない場合はnull。 */
    async isPullRequestMerged(prNumber: number): Promise<boolean | null> {
      try {
        const pull = await octokit.rest.pulls.get({
          owner: repository.owner,
          repo: repository.name,
          pull_number: prNumber,
        });

        return pull.data.merged === true;
      } catch {
        return null;
      }
    },
  };
}
