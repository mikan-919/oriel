import {
  triageStateName,
  type LinearApprovalReaderOptions,
} from "./linear-approval";

const linearApi = "https://api.linear.app/graphql";

const teamStatesByTeamQuery = `query($teamId: String!) {
  team(id: $teamId) { states(first: 100) { nodes { id name } } }
}`;
const issueCreateMutation = `mutation($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id } }
}`;
const attachmentCreateMutation = `mutation($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success attachment { id } }
}`;

export interface LinearTriageWriter {
  /**
   * teamのTriage stateへ新規issueを作る。teamに一意なTriage stateが無ければ
   * fail closedでnullを返す。`clientId`をLinearのissue IDとして渡すことで、
   * 同じ要求の再送を新規作成として重複させない(Linearが同じIDへ収束させる)。
   */
  createTriageIssue(input: {
    teamId: string;
    title: string;
    description: string;
    clientId: string;
  }): Promise<{ issueId: string } | null>;
  /** GitHub Issue URLをLinear issueへattachmentとして結び付ける。 */
  createAttachment(input: {
    issueId: string;
    url: string;
    title: string;
  }): Promise<boolean>;
}

/**
 * Linear issueの新規作成とattachment紐付けの境界。
 *
 * ADR 0003・CONCEPT不変原則2のとおり、Agentが到達できるのはTriageまでであり、
 * ここで作る操作もTriage作成と紐付けだけに限る。Todoへの昇格は人間だけが行う。
 */
export function createLinearTriageWriter({
  token,
  fetchImpl = (request) => fetch(request),
}: LinearApprovalReaderOptions): LinearTriageWriter {
  async function graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const response = await fetchImpl(
        new Request(linearApi, {
          method: "POST",
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
    async createTriageIssue({ teamId, title, description, clientId }) {
      const statesData = await graphql(teamStatesByTeamQuery, { teamId });
      const nodes =
        (
          statesData?.team as {
            states?: { nodes?: { id?: string; name?: string }[] };
          } | null
        )?.states?.nodes ?? [];
      const matching = nodes.filter((node) => node.name === triageStateName);

      if (matching.length !== 1 || typeof matching[0]?.id !== "string") {
        return null;
      }

      const created = await graphql(issueCreateMutation, {
        input: {
          id: clientId,
          teamId,
          title,
          description,
          stateId: matching[0].id,
        },
      });
      const issueId = (
        created?.issueCreate as {
          success?: boolean;
          issue?: { id?: string } | null;
        } | null
      )?.issue?.id;

      return typeof issueId === "string" ? { issueId } : null;
    },
    async createAttachment({ issueId, url, title }) {
      const created = await graphql(attachmentCreateMutation, {
        input: { issueId, url, title },
      });

      return (
        (created?.attachmentCreate as { success?: boolean } | null)?.success ===
        true
      );
    },
  };
}
