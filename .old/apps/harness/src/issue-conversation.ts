import {
  type GitHubRepository,
  type IssueCommentAcceptedEvent,
  type IssueCommentCompletedEvent,
  type IssueCommentEvent,
  type IssueCommentRequest,
  parseIssueCommentEvent,
} from "@mikan-919/oriel-contracts";

export interface NdjsonIssueCommentTransport {
  write(message: IssueCommentRequest): void | Promise<void>;
  read(): Promise<unknown>;
}

export interface IssueCommentOperationClient {
  requestIssueComment(
    request: IssueCommentRequest,
  ): Promise<IssueCommentAcceptedEvent>;
  waitForIssueCommentCompletion(
    accepted: IssueCommentAcceptedEvent,
  ): Promise<IssueCommentCompletedEvent>;
}

export function createNdjsonIssueCommentOperationClient(
  transport: NdjsonIssueCommentTransport,
): IssueCommentOperationClient {
  return {
    async requestIssueComment(request) {
      await transport.write(request);
      const event = await nextEvent(transport);

      if (event.type === "issue_comment.rejected") {
        throw new Error(
          `Issue-comment operation was rejected: ${event.reason}`,
        );
      }

      if (
        event.type !== "issue_comment.accepted" ||
        event.requestId !== request.requestId
      ) {
        throw new Error(
          "Issue-comment operation did not acknowledge its request",
        );
      }

      return event;
    },
    async waitForIssueCommentCompletion(accepted) {
      const event = await nextEvent(transport);

      if (event.type === "issue_comment.rejected") {
        throw new Error(
          `Issue-comment operation was rejected: ${event.reason}`,
        );
      }

      if (event.type === "issue_comment.reconciliation_required") {
        throw new Error("Issue-comment operation requires reconciliation");
      }

      if (
        event.type !== "issue_comment.completed" ||
        event.requestId !== accepted.requestId ||
        event.operationId !== accepted.operationId
      ) {
        throw new Error(
          "Issue-comment completion did not match the accepted operation",
        );
      }

      return event;
    },
  };
}

async function nextEvent(
  transport: NdjsonIssueCommentTransport,
): Promise<IssueCommentEvent> {
  return parseIssueCommentEvent(await transport.read());
}

export interface IssueConversationReply {
  requestId: string;
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  body: string;
}

export async function postIssueConversationReply(
  reply: IssueConversationReply,
  operationClient: IssueCommentOperationClient,
  onEvent: (
    event: IssueCommentAcceptedEvent | IssueCommentCompletedEvent,
  ) => void,
) {
  const accepted = await operationClient.requestIssueComment({
    type: "issue_comment.request",
    ...reply,
  });
  onEvent(accepted);

  const completed =
    await operationClient.waitForIssueCommentCompletion(accepted);
  onEvent(completed);
}
