import { identity } from "@mikan-919/oriel-identity";

import type { LinearApprovalReader } from "./github-approval-ports";

const linearApi = "https://api.linear.app/graphql";
const issueQuery = `query($id: String!) {
  issue(id: $id) {
    id
    identifier
    title
    description
    state { name }
    attachments(first: 100) { nodes { url } }
  }
}`;

export interface LinearApprovalReaderOptions {
  /** Linear OAuth token。`serve`だけが持ち、harnessへは渡さない。 */
  token: string;
  fetchImpl?: (request: Request) => Promise<Response>;
}

/**
 * HOWと実行承認の現在値を読む境界。承認指紋の計算に必要な現在値だけを返し、
 * 本文をローカルの正本として保存しない。読めない、曖昧、能力不足はnullにして
 * fail closedにする。
 */
export function createLinearApprovalReader({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions): LinearApprovalReader {
  return {
    async readIssue(linearIssueId) {
      let payload;

      try {
        const response = await fetchImpl(
          new Request(linearApi, {
            method: "POST",
            headers: {
              // tokenはheaderだけへ載せる。
              authorization: token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: issueQuery,
              variables: { id: linearIssueId },
            }),
          }),
        );

        if (!response.ok) {
          return null;
        }

        payload = (await response.json()) as {
          data?: {
            issue?: {
              id?: string;
              identifier?: string;
              title?: string;
              description?: string | null;
              state?: { name?: string } | null;
              attachments?: { nodes?: { url?: string }[] } | null;
            } | null;
          };
          errors?: unknown[];
        };
      } catch {
        return null;
      }

      const issue = payload.data?.issue;

      if (
        (payload.errors ?? []).length > 0 ||
        issue?.id === undefined ||
        issue.identifier === undefined ||
        issue.title === undefined ||
        issue.state?.name === undefined
      ) {
        return null;
      }

      return {
        issueId: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description ?? null,
        stateName: issue.state.name,
        attachmentUrls: (issue.attachments?.nodes ?? []).map(
          (node) => node.url ?? "",
        ),
      };
    },
  };
}

const attachmentsForUrlQuery = `query($url: String!) {
  attachmentsForURL(url: $url) { nodes { issue { id } } }
}`;

export interface LinearDiscoveryReader {
  /**
   * GitHub Issue URLをLinearのattachment検索へ渡し、対応するLinear issueを
   * 逆引きする。複数見つかった場合もそのまま返し、選ぶかどうかは呼び出し側
   * (discoveryのadmission判断)が決める。読めなければnullでfail closedにする。
   */
  findIssuesByAttachmentUrl(url: string): Promise<{ issueId: string }[] | null>;
}

/**
 * GitHub Issue起点でLinear issueを発見する境界。承認指紋やHOWの本文は扱わず、
 * `attachmentsForURL`が返すissue IDの集合だけを返す。
 */
export function createLinearDiscoveryReader({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions): LinearDiscoveryReader {
  return {
    async findIssuesByAttachmentUrl(url) {
      let payload;

      try {
        const response = await fetchImpl(
          new Request(linearApi, {
            method: "POST",
            headers: {
              authorization: token,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              query: attachmentsForUrlQuery,
              variables: { url },
            }),
          }),
        );

        if (!response.ok) {
          return null;
        }

        payload = (await response.json()) as {
          data?: {
            attachmentsForURL?: {
              nodes?: { issue?: { id?: string } | null }[];
            } | null;
          };
          errors?: unknown[];
        };
      } catch {
        return null;
      }

      if ((payload.errors ?? []).length > 0) {
        return null;
      }

      const nodes = payload.data?.attachmentsForURL?.nodes ?? [];
      const issueIds = new Set<string>();

      for (const node of nodes) {
        const issueId = node.issue?.id;

        if (typeof issueId === "string" && issueId !== "") {
          issueIds.add(issueId);
        }
      }

      return [...issueIds].map((issueId) => ({ issueId }));
    },
  };
}

const stateQuery = `query($id: String!) {
  issue(id: $id) { state { name } }
}`;
const teamStatesQuery = `query($id: String!) {
  issue(id: $id) { team { states(first: 100) { nodes { id name type } } } }
}`;
const stateMutation = `mutation($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

/** 差し戻し先と、worker起動直後・merge確認後に反映するworkflow state名。 */
export const triageStateName = "Triage";
const inProgressStateName = "In Progress";
export const doneStateName = "Done";

/**
 * teamに一意な「レビュー用state」の判定規則。
 *
 * ADR 0005はこの詳細規則を明示的に対象外としているため、type"started"
 * (In Progress系)のうち名前に"review"を含むものを候補とする。
 */
const reviewStateNamePattern = /review/i;

export type ReviewStateCandidate =
  { id: string; name: string } | "none" | "ambiguous";

/**
 * 無効になった承認状態をLinearへ反映する境界。
 *
 * ADR 0003のとおり、これは承認ではなく機械的な差し戻しであり、実行できるのは
 * 現在のJob所有権を確認した`serve`だけである。理由commentは投稿しない。stateを
 * 一意に決められない場合は何も書かずfail closedにする。
 */
export function createLinearApprovalStateWriter({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions) {
  async function graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchImpl(
        new Request(linearApi, {
          method: "POST",
          // tokenはheaderだけへ載せる。
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify({ query, variables }),
        }),
      );

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as {
        data?: Record<string, unknown>;
        errors?: unknown[];
      };

      return (payload.errors ?? []).length > 0 ? null : (payload.data ?? null);
    } catch {
      return null;
    }
  }

  return {
    async readLinearState(linearIssueId: string): Promise<string | null> {
      const data = await graphql(stateQuery, { id: linearIssueId });
      const name = (
        data?.issue as { state?: { name?: string } | null } | null | undefined
      )?.state?.name;

      return typeof name === "string" ? name : null;
    },
    /** teamに一意な対象stateがある場合だけ、そのstateへ移す。 */
    async moveToState(
      linearIssueId: string,
      stateName: string,
    ): Promise<boolean> {
      const data = await graphql(teamStatesQuery, { id: linearIssueId });
      const nodes =
        (
          data?.issue as {
            team?: { states?: { nodes?: { id?: string; name?: string }[] } };
          } | null
        )?.team?.states?.nodes ?? [];
      const matching = nodes.filter((node) => node.name === stateName);

      // 一意な対象stateがなければ、別のstateで代替しない。
      if (matching.length !== 1 || typeof matching[0]?.id !== "string") {
        return false;
      }

      const updated = await graphql(stateMutation, {
        id: linearIssueId,
        stateId: matching[0].id,
      });

      return (
        (updated?.issueUpdate as { success?: boolean } | null)?.success === true
      );
    },
    moveToTriage(linearIssueId: string): Promise<boolean> {
      return this.moveToState(linearIssueId, triageStateName);
    },
    /**
     * 承認後の機械的な反映として、TodoからIn Progressへ移す。承認そのものは
     * 人間のTriage→Todoだけであり、この操作は承認ではない。
     */
    moveToInProgress(linearIssueId: string): Promise<boolean> {
      return this.moveToState(linearIssueId, inProgressStateName);
    },
    /** teamのtype"started"かつ名前が/review/iに一致する一意なstateを探す。 */
    async readReviewStateCandidate(
      linearIssueId: string,
    ): Promise<ReviewStateCandidate | null> {
      const data = await graphql(teamStatesQuery, { id: linearIssueId });
      const nodes =
        (
          data?.issue as {
            team?: {
              states?: {
                nodes?: { id?: string; name?: string; type?: string }[];
              };
            };
          } | null
        )?.team?.states?.nodes ?? [];
      const matching = nodes.filter(
        (node) =>
          node.type === "started" &&
          typeof node.name === "string" &&
          reviewStateNamePattern.test(node.name),
      );

      if (matching.length === 0) {
        return "none";
      }

      if (matching.length !== 1) {
        return "ambiguous";
      }

      const [state] = matching;

      return typeof state?.id === "string" && typeof state.name === "string"
        ? { id: state.id, name: state.name }
        : null;
    },
    async moveToStateId(
      linearIssueId: string,
      stateId: string,
    ): Promise<boolean> {
      const updated = await graphql(stateMutation, {
        id: linearIssueId,
        stateId,
      });

      return (
        (updated?.issueUpdate as { success?: boolean } | null)?.success === true
      );
    },
    /** mergeを現在値から確認した後の機械的な反映として、Doneへ移す。 */
    moveToDone(linearIssueId: string): Promise<boolean> {
      return this.moveToState(linearIssueId, doneStateName);
    },
  };
}

/** Linear tokenの保存先。Secret Serviceを使えない場合はfail closedにする。 */
export function bunSecretsLinearToken(repositoryId: number) {
  return {
    async get(): Promise<string | null> {
      try {
        return (
          (await Bun.secrets.get({
            service: identity.codeName,
            name: `linear-token:${repositoryId}`,
          })) ?? null
        );
      } catch {
        return null;
      }
    },
  };
}
