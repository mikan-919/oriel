import {
  type GitHubRepository,
  type IssueCommentEvent,
  type IssueCommentRejectedEvent,
  parseIssueCommentRequest,
} from "@mikan-919/oriel-contracts";

import { type createIssueCommentService } from "./issue-comments";
import { readNdjson, writeNdjson } from "./ndjson";

type IssueCommentService = ReturnType<typeof createIssueCommentService>;

export interface IssueConversationBinding {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
}

export async function serveOwnedHarnessIssueCommentIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  binding: IssueConversationBinding,
  service: IssueCommentService,
  stopSignal?: AbortSignal,
) {
  const writer = output.getWriter();

  try {
    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await writeEvent(writer, rejectedFromMalformedMessage(message));
        continue;
      }

      if (!matchesBinding(request, binding)) {
        await writeEvent(
          writer,
          rejected(request.requestId, "target_mismatch"),
        );
        continue;
      }

      const acceptedOrRejected = await service.accept(request);
      await writeEvent(writer, acceptedOrRejected);

      if (acceptedOrRejected.type === "issue_comment.rejected") {
        continue;
      }

      await writeEvent(
        writer,
        await service.waitForOutcome(acceptedOrRejected.operationId),
      );
    }
  } finally {
    writer.releaseLock();
  }
}

function parseRequest(message: unknown) {
  try {
    return parseIssueCommentRequest(message);
  } catch {
    return null;
  }
}

function matchesBinding(
  request: IssueConversationBinding,
  binding: IssueConversationBinding,
) {
  return (
    request.jobId === binding.jobId &&
    request.jobLeaseId === binding.jobLeaseId &&
    request.repository.owner === binding.repository.owner &&
    request.repository.name === binding.repository.name &&
    request.issueNumber === binding.issueNumber
  );
}

function rejectedFromMalformedMessage(
  message: unknown,
): IssueCommentRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string"
      ? message.requestId
      : "invalid-request";

  return rejected(requestId, "invalid_request");
}

function rejected(
  requestId: string,
  reason: IssueCommentRejectedEvent["reason"],
): IssueCommentRejectedEvent {
  return { type: "issue_comment.rejected", requestId, reason };
}

async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: IssueCommentEvent,
) {
  await writeNdjson(writer, event);
}
