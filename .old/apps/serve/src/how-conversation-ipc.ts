import {
  parseHowConfirmationClientMessage,
  type HowConfirmationResult,
  type HowConfirmationStartEvent,
  type LinearCommentAcceptedEvent,
  type LinearCommentEvent,
  type LinearCommentRejectedEvent,
  type LinearCommentRequest,
  type LinearDescriptionUpdateEvent,
  type LinearDescriptionUpdateRequest,
  type ModelStreamRequest,
  type ModelStreamServerMessage,
} from "@mikan-919/oriel-contracts";

import { readNdjson, writeNdjson } from "./ndjson";

export interface LinearCommentOperations {
  accept(
    request: LinearCommentRequest,
  ): Promise<LinearCommentAcceptedEvent | LinearCommentRejectedEvent>;
  waitForOutcome(operationId: string): Promise<LinearCommentEvent>;
}

export interface LinearDescriptionOperations {
  update(
    request: LinearDescriptionUpdateRequest,
  ): Promise<LinearDescriptionUpdateEvent>;
}

export interface ModelStreamOperations {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamServerMessage>;
  abort(requestId: string): void;
}

export interface HowConfirmationResultOperations {
  report(result: HowConfirmationResult): void;
}

export interface HowConfirmationOperations {
  linearComment: LinearCommentOperations;
  linearDescription: LinearDescriptionOperations;
  model: ModelStreamOperations;
  result: HowConfirmationResultOperations;
}

/**
 * HOW確定workerのIPC。
 *
 * what-conversation-ipc.tsと同じ多重化を、`linear_comment`(Linearへの返信)、
 * `linear_description`(HOW確定の反映)、model streamの三つで行う。いずれの要求も
 * start eventが示す対象(GitHub repository・issueNumber・Linear issue)と一致
 * する場合だけ処理する。
 */
export async function serveOwnedHarnessHowConfirmationIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  start: HowConfirmationStartEvent,
  operations: HowConfirmationOperations,
  stopSignal?: AbortSignal,
): Promise<void> {
  const writer = output.getWriter();
  let writes = Promise.resolve();
  const send = (message: unknown): Promise<void> => {
    writes = writes.then(() => writeNdjson(writer, message));
    return writes;
  };
  const streaming = new Set<Promise<void>>();

  try {
    await send(start);

    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await send(invalid(message));
        continue;
      }

      if (request.type === "how_confirmation.result") {
        if (
          request.jobId === start.jobId &&
          request.jobLeaseId === start.jobLeaseId
        ) {
          operations.result.report(request);
        }

        continue;
      }

      if (request.type === "model.stream.abort") {
        operations.model.abort(request.requestId);
        continue;
      }

      if (request.type === "model.stream.request") {
        const pump = (async () => {
          for await (const event of operations.model.stream(request)) {
            await send(event);
          }
        })().finally(() => streaming.delete(pump));

        streaming.add(pump);
        continue;
      }

      if (!matchesTarget(request, start)) {
        await send(rejectedTargetMismatch(request));
        continue;
      }

      if (request.type === "linear_description.request") {
        await send(await operations.linearDescription.update(request));
        continue;
      }

      const acceptedOrRejected = await operations.linearComment.accept(request);
      await send(acceptedOrRejected);

      if (acceptedOrRejected.type === "linear_comment.rejected") {
        continue;
      }

      await send(
        await operations.linearComment.waitForOutcome(
          acceptedOrRejected.operationId,
        ),
      );
    }

    await Promise.all(streaming);
  } finally {
    await writes.catch(() => {});
    writer.releaseLock();
  }
}

function parseRequest(
  message: unknown,
): ReturnType<typeof parseHowConfirmationClientMessage> | null {
  try {
    return parseHowConfirmationClientMessage(message);
  } catch {
    return null;
  }
}

function matchesTarget(
  request: LinearCommentRequest | LinearDescriptionUpdateRequest,
  start: HowConfirmationStartEvent,
): boolean {
  return (
    request.jobId === start.jobId &&
    request.jobLeaseId === start.jobLeaseId &&
    request.repository.owner === start.repository.owner &&
    request.repository.name === start.repository.name &&
    request.issueNumber === start.issueNumber &&
    request.linearIssueId === start.linearIssueId
  );
}

function rejectedTargetMismatch(
  request: LinearCommentRequest | LinearDescriptionUpdateRequest,
): LinearCommentRejectedEvent | LinearDescriptionUpdateEvent {
  if (request.type === "linear_comment.request") {
    return {
      type: "linear_comment.rejected",
      requestId: request.requestId,
      reason: "target_mismatch",
    };
  }

  return {
    type: "linear_description.rejected",
    requestId: request.requestId,
    reason: "target_mismatch",
  };
}

function invalid(message: unknown): LinearCommentRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    message.requestId !== ""
      ? message.requestId
      : "invalid-request";

  return {
    type: "linear_comment.rejected",
    requestId,
    reason: "invalid_request",
  };
}
