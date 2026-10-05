import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type {
  GitHubIssueSnapshot,
  ImplementationApprovalPorts,
  LinearApprovalSnapshot,
  RefRead,
  SealOutcome,
} from "./implementation-admission";

const zeroOid = "0".repeat(40);

export interface LinearApprovalReader {
  readIssue(linearIssueId: string): Promise<LinearApprovalSnapshot | null>;
}

export interface GitHubApprovalPortsOptions {
  octokit: Octokit;
  repository: GitHubRepository;
  linear: LinearApprovalReader;
  /** canonicalブランチ名をGit実装のcheck-ref-formatへ通す。 */
  checkRefFormat?: (branch: string) => Promise<boolean>;
}

async function gitCheckRefFormat(branch: string): Promise<boolean> {
  // shell文字列を介さず引数配列で渡す。
  const git = Bun.spawn(["git", "check-ref-format", "--branch", branch], {
    stdout: "ignore",
    stderr: "ignore",
  });

  return (await git.exited) === 0;
}

/**
 * `updateRefs`の失敗の種類を、ADR 0003が要求する三つへ分ける。
 *
 * 能力不足と権限不足は`unsupported`、providerが明示的に拒否したものは`rejected`、
 * 送ったか分からないものは`unknown`とする。どれでも弱いcreate APIへは落とさない。
 */
function classifySealFailure(error: unknown): SealOutcome {
  const failure = error as {
    status?: number;
    message?: string;
    errors?: { type?: string }[];
  };
  const types = (failure.errors ?? []).map((entry) => entry.type ?? "");

  if (
    types.includes("UNDEFINED_FIELD") ||
    /doesn't exist|Unknown argument|Unknown type/i.test(failure.message ?? "")
  ) {
    return "unsupported";
  }

  if (
    failure.status === 401 ||
    failure.status === 403 ||
    failure.status === 404
  ) {
    return "unsupported";
  }

  return types.length > 0 ? "rejected" : "unknown";
}

export interface GitHubTargetBaseReader {
  readTargetBase(): Promise<{ ref: string; oid: string } | null>;
  readTargetBaseFile(
    oid: string,
    path: string,
  ): Promise<
    | { status: "present"; content: string }
    | { status: "absent" }
    | { status: "unknown" }
  >;
}

/**
 * 取り込み先branchの現在値とその版のfile内容を読む境界。
 *
 * ADR 0003の実装Jobと、[ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)
 * のPR対応Jobの両方が、実行設定を読むためだけにこれを使う。
 */
export function createGitHubTargetBaseReader({
  octokit,
  repository,
}: {
  octokit: Octokit;
  repository: GitHubRepository;
}): GitHubTargetBaseReader {
  const owner = repository.owner;
  const name = repository.name;

  return {
    async readTargetBase() {
      try {
        const read = (await octokit.graphql(
          `query($owner: String!, $name: String!) {
             repository(owner: $owner, name: $name) {
               defaultBranchRef { name target { oid } }
             }
           }`,
          { owner, name },
        )) as {
          repository?: {
            defaultBranchRef?: {
              name?: string;
              target?: { oid?: string } | null;
            } | null;
          } | null;
        };
        const base = read.repository?.defaultBranchRef;

        return base?.name === undefined || base.target?.oid === undefined
          ? null
          : { ref: `refs/heads/${base.name}`, oid: base.target.oid };
      } catch {
        return null;
      }
    },
    /**
     * 実行設定は取り込み先branchの版だけを信頼する。
     *
     * ROADMAPのとおり、Agentが作業branchで変更した設定はそのJobへ適用しない。
     * 承認の読み直しで確認した取り込み先のcommit OIDから直接読み、読めない場合を
     * 不存在と区別する。
     */
    async readTargetBaseFile(oid, path) {
      try {
        const read = (await octokit.graphql(
          `query($owner: String!, $name: String!, $expression: String!) {
             repository(owner: $owner, name: $name) {
               object(expression: $expression) {
                 ... on Blob { text isBinary }
               }
             }
           }`,
          { owner, name, expression: `${oid}:${path}` },
        )) as {
          repository?: {
            object?: { text?: string | null; isBinary?: boolean | null } | null;
          } | null;
        };
        const object = read.repository?.object;

        if (object === null || object === undefined) {
          return { status: "absent" };
        }

        // blobでない、またはtextとして読めないものを設定として解釈しない。
        return typeof object.text === "string" && object.isBinary !== true
          ? { status: "present", content: object.text }
          : { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    },
  };
}

/**
 * ADR 0003のadmissionがGitHubへ触る境界。読み取りは現在値だけを返し、封印は
 * GraphQLの`updateRefs`一回だけを使う。
 */
export function createGitHubApprovalPorts({
  octokit,
  repository,
  linear,
  checkRefFormat = gitCheckRefFormat,
}: GitHubApprovalPortsOptions): ImplementationApprovalPorts {
  const owner = repository.owner;
  const name = repository.name;
  const targetBase = createGitHubTargetBaseReader({ octokit, repository });

  function issueNumberOf(url: string): number | null {
    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return null;
    }

    if (parsed.origin !== "https://github.com") {
      return null;
    }

    const [urlOwner, urlName, kind, rawNumber, ...rest] = parsed.pathname
      .slice(1)
      .split("/");

    if (
      urlOwner !== owner ||
      urlName !== name ||
      kind !== "issues" ||
      rest.length > 0 ||
      rawNumber === undefined ||
      !/^[1-9][0-9]*$/.test(rawNumber)
    ) {
      return null;
    }

    return Number(rawNumber);
  }

  return {
    readLinearIssue: (linearIssueId) => linear.readIssue(linearIssueId),
    async resolveGitHubIssueByAttachmentUrl(url) {
      const issueNumber = issueNumberOf(url);

      if (issueNumber === null) {
        return null;
      }

      try {
        const read = (await octokit.graphql(
          `query($owner: String!, $name: String!, $number: Int!) {
             repository(owner: $owner, name: $name) {
               id
               issue(number: $number) { id number title body state }
             }
           }`,
          { owner, name, number: issueNumber },
        )) as {
          repository?: {
            id?: string;
            issue?: {
              id?: string;
              number?: number;
              title?: string;
              body?: string | null;
              state?: string;
            } | null;
          } | null;
        };
        const issue = read.repository?.issue;

        if (
          read.repository?.id === undefined ||
          issue?.id === undefined ||
          issue.number === undefined ||
          issue.title === undefined ||
          issue.state === undefined
        ) {
          return null;
        }

        return {
          issueNumber: issue.number,
          issueNodeId: issue.id,
          repositoryNodeId: read.repository.id,
          title: issue.title,
          body: issue.body ?? null,
          state: issue.state,
        } satisfies GitHubIssueSnapshot;
      } catch {
        return null;
      }
    },
    readTargetBase: () => targetBase.readTargetBase(),
    async readRef(qualifiedRef): Promise<RefRead> {
      try {
        const read = (await octokit.graphql(
          `query($owner: String!, $name: String!, $ref: String!) {
             repository(owner: $owner, name: $name) {
               ref(qualifiedName: $ref) { target { oid } }
             }
           }`,
          { owner, name, ref: qualifiedRef },
        )) as {
          repository?: {
            ref?: { target?: { oid?: string } | null } | null;
          } | null;
        };
        const oid = read.repository?.ref?.target?.oid;

        return oid === undefined
          ? { status: "absent" }
          : { status: "present", oid };
      } catch {
        // 読めないことを不存在と扱わない。
        return { status: "unknown" };
      }
    },
    readTargetBaseFile: (oid, path) => targetBase.readTargetBaseFile(oid, path),
    async listOpenPullRequestHeadRefs() {
      try {
        const pulls = (await octokit.paginate(
          "GET /repos/{owner}/{repo}/pulls",
          {
            owner,
            repo: name,
            state: "open",
            per_page: 100,
          },
        )) as { head?: { ref?: string } }[];

        return pulls.map((pull) => pull.head?.ref ?? "");
      } catch {
        return null;
      }
    },
    checkRefFormat,
    async updateRefsAtomically({
      repositoryNodeId,
      baseRef,
      expectedBaseOid,
      canonicalRef,
    }) {
      try {
        await octokit.graphql(
          `mutation($input: UpdateRefsInput!) {
             updateRefs(input: $input) { clientMutationId }
           }`,
          {
            input: {
              repositoryId: repositoryNodeId,
              refUpdates: [
                {
                  name: baseRef,
                  beforeOid: expectedBaseOid,
                  afterOid: expectedBaseOid,
                  force: false,
                },
                {
                  name: canonicalRef,
                  beforeOid: zeroOid,
                  afterOid: expectedBaseOid,
                  force: false,
                },
              ],
            },
          },
        );

        return "sealed";
      } catch (error) {
        return classifySealFailure(error);
      }
    },
  };
}
