import { identity } from "@mikan-919/oriel-identity";
import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import { createOctokitIssueCommentPublisher } from "./issue-comments";
import type {
  PrResponseReconciliationPorts,
  PrResponseReportPorts,
} from "./pr-response-job";
import type {
  PrResponseCandidatePullRequest,
  PrResponsePorts,
} from "./pr-response-discovery";

export interface GitHubPrResponsePortsOptions {
  octokit: Octokit;
  repository: GitHubRepository;
  /** 起動ごとに一度だけ解決すればよい、`serve`自身のGitHub actor login。 */
  actorLogin: string;
}

/**
 * ADR 0007のPR対応discoveryがGitHubへ触る境界。読み取りは現在値だけを返す。
 *
 * ponytail: required checkはCheck Runs APIだけを見る。legacy Commit Status API
 * 由来のrequired checkはv1の対象外とし、必要になったら`listRequiredCheckStatuses`
 * へ追加する。
 */
export function createGitHubPrResponsePorts({
  octokit,
  repository,
  actorLogin,
}: GitHubPrResponsePortsOptions): PrResponsePorts {
  const owner = repository.owner;
  const name = repository.name;

  return {
    async listOpenPullRequests() {
      try {
        const pulls = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/pulls",
          { owner, repo: name, state: "open", per_page: 100 },
        )) as {
          number: number;
          head: { ref: string; sha: string };
          base: { ref: string };
        }[];

        return pulls
          .filter((pull) => pull.head.ref.startsWith(`${identity.codeName}/`))
          .map((pull): PrResponseCandidatePullRequest => ({
            number: pull.number,
            headRef: pull.head.ref,
            baseRef: pull.base.ref,
            headOid: pull.head.sha,
          }));
      } catch {
        return null;
      }
    },
    async listReviews(prNumber) {
      try {
        const reviews = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
          { owner, repo: name, pull_number: prNumber, per_page: 100 },
        )) as {
          state: string;
          submitted_at?: string | null;
          body?: string | null;
          user?: { login?: string } | null;
        }[];

        return reviews.map((review) => ({
          authorIsActor: review.user?.login === actorLogin,
          state: review.state,
          submittedAt: review.submitted_at ?? "",
          body: review.body ?? "",
        }));
      } catch {
        return null;
      }
    },
    async listComments(prNumber) {
      try {
        const comments = await octokit.paginate(
          octokit.rest.issues.listComments,
          { owner, repo: name, issue_number: prNumber, per_page: 100 },
        );

        return comments.map((comment) => ({
          authorIsActor: comment.user?.login === actorLogin,
          createdAt: comment.created_at,
          body: comment.body ?? "",
        }));
      } catch {
        return null;
      }
    },
    async listReviewComments(prNumber) {
      try {
        const comments = await octokit.paginate(
          octokit.rest.pulls.listReviewComments,
          { owner, repo: name, pull_number: prNumber, per_page: 100 },
        );

        return comments.map((comment) => ({
          authorIsActor: comment.user?.login === actorLogin,
          createdAt: comment.created_at,
          body: comment.body ?? "",
          path: comment.path,
          line: comment.line ?? comment.original_line ?? null,
        }));
      } catch {
        return null;
      }
    },
    async listRequiredCheckStatuses({ headOid, baseRef }) {
      let required: string[];

      try {
        const protection = await octokit.rest.repos.getBranchProtection({
          owner,
          repo: name,
          branch: baseRef,
        });
        const checks = protection.data.required_status_checks?.checks;
        const contexts = protection.data.required_status_checks?.contexts;

        required =
          checks !== undefined
            ? checks.map((check) => check.context)
            : (contexts ?? []);
      } catch (error) {
        const failure = error as { status?: number };

        // branch protection未設定はrequired checkなしとして扱う。権限不足・
        // 通信不能だけをfail closedにする。
        if (failure.status === 404) {
          return [];
        }

        return null;
      }

      if (required.length === 0) {
        return [];
      }

      try {
        const checkRuns = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/commits/{ref}/check-runs",
          { owner, repo: name, ref: headOid, per_page: 100 },
        )) as {
          name: string;
          conclusion: string | null;
          output?: { summary?: string | null; text?: string | null } | null;
        }[];

        return checkRuns
          .filter((run) => required.includes(run.name))
          .map((run) => ({
            checkName: run.name,
            conclusion: run.conclusion,
            summary: run.output?.summary ?? run.output?.text ?? "",
          }));
      } catch {
        return null;
      }
    },
  };
}

/** checkpoint送信直前の再調停に使う、対象PRの現在値だけを読む境界。 */
export function createGitHubPrResponseReconciliationPorts({
  octokit,
  repository,
}: {
  octokit: Octokit;
  repository: GitHubRepository;
}): PrResponseReconciliationPorts {
  return {
    async isPullRequestOpenWithHead({ prNumber, headRef }) {
      try {
        const pull = await octokit.rest.pulls.get({
          owner: repository.owner,
          repo: repository.name,
          pull_number: prNumber,
        });

        return pull.data.state === "open" && pull.data.head.ref === headRef;
      } catch {
        return null;
      }
    },
  };
}

/** 収束できなかった場合の報告、および進捗ackのcomment投稿に使う境界。 */
export function createGitHubPrResponseReportPorts({
  octokit,
  repository,
}: {
  octokit: Octokit;
  repository: GitHubRepository;
}): PrResponseReportPorts {
  const publisher = createOctokitIssueCommentPublisher(octokit);

  return {
    async createComment({ prNumber, body }) {
      try {
        await publisher.createIssueComment({
          repository,
          issueNumber: prNumber,
          body,
        });

        return true;
      } catch {
        return false;
      }
    },
  };
}
