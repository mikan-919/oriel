import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import {
  parseLinearCommentEvent,
  parseLinearDescriptionUpdateEvent,
  type GitHubRepository,
} from "@mikan-919/oriel-contracts";

export interface HowConfirmationTransport {
  write(message: unknown): void | Promise<void>;
  read(): Promise<unknown>;
}

export interface HowConfirmationToolsOptions {
  transport: HowConfirmationTransport;
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  linearIssueId: string;
  /** turn開始時点のLinear issue description。同時変更検知の最初の基準値。 */
  initialDescription: string;
  newRequestId?: () => string;
}

export interface HowConfirmationToolset {
  tools: AgentTool[];
  /** post_commentが実際にLinearへ投稿できたか。discoveryの次trigger判定が読む外部状態を必ず残すため、呼び出し側は失敗時にfallback commentを送る。 */
  commentPosted(): boolean;
}

/**
 * HOW確定Jobだけが持つ狭いtool群。
 *
 * ADR 0005のとおりharnessへLinearの汎用API中継は公開しない。ここにあるのは
 * Linear issueへのcomment投稿とdescriptionの更新の二つに限る。stateを変更する
 * tool(Triage→Todoを含む)は一切提供しない。CONCEPT不変原則2のとおり、
 * Triage→Todoの承認は常に人間だけが行う。
 */
export function createHowConfirmationTools({
  transport,
  jobId,
  jobLeaseId,
  repository,
  issueNumber,
  linearIssueId,
  initialDescription,
  newRequestId,
}: HowConfirmationToolsOptions): HowConfirmationToolset {
  let posted = false;
  let currentDescription = initialDescription;
  let requestCounter = 0;
  const nextRequestId = newRequestId ?? (() => `how-${++requestCounter}`);

  function text(content: string) {
    return { content: [{ type: "text" as const, text: content }], details: {} };
  }

  function stringField(params: unknown, name: string): string {
    const value =
      typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)[name]
        : undefined;

    if (typeof value !== "string") {
      throw new Error(`${name} must be a string`);
    }

    return value;
  }

  const tools: AgentTool[] = [
    {
      name: "post_comment",
      label: "Post a comment",
      description: "Post a reply comment on this Linear issue.",
      parameters: Type.Object({ body: Type.String() }),
      async execute(_toolCallId, params) {
        await transport.write({
          type: "linear_comment.request",
          requestId: nextRequestId(),
          jobId,
          jobLeaseId,
          repository,
          issueNumber,
          linearIssueId,
          body: stringField(params, "body"),
        });

        const accepted = parseLinearCommentEvent(await transport.read());

        if (accepted.type === "linear_comment.rejected") {
          return text(`rejected: ${accepted.reason}`);
        }

        const outcome = parseLinearCommentEvent(await transport.read());

        if (outcome.type === "linear_comment.completed") {
          posted = true;
          return text(`posted comment ${outcome.linearCommentId}`);
        }

        return text(
          outcome.type === "linear_comment.rejected"
            ? `rejected: ${outcome.reason}`
            : "comment pending reconciliation",
        );
      },
    },
    {
      name: "update_description",
      label: "Update the Linear issue description",
      description:
        "Replace this Linear issue's description with the currently " +
        "confirmed HOW. Prior comments are not the spec of record; only " +
        "this description is. Call this whenever your understanding of HOW " +
        "solidifies or changes.",
      parameters: Type.Object({ description: Type.String() }),
      async execute(_toolCallId, params) {
        const description = stringField(params, "description");

        await transport.write({
          type: "linear_description.request",
          requestId: nextRequestId(),
          jobId,
          jobLeaseId,
          repository,
          issueNumber,
          linearIssueId,
          description,
          baselineDescription: currentDescription,
        });

        const outcome = parseLinearDescriptionUpdateEvent(
          await transport.read(),
        );

        if (outcome.type === "linear_description.completed") {
          currentDescription = description;
          return text("description updated");
        }

        return text(
          outcome.reason === "concurrent_change"
            ? "rejected: a human changed the description concurrently — do not retry blindly, tell the human instead"
            : `rejected: ${outcome.reason}`,
        );
      },
    },
  ];

  return { tools, commentPosted: () => posted };
}
