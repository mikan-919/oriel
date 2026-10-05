import {
  parseWhatConfirmationClientMessage,
  type IssueBodyUpdateEvent,
  type IssueBodyUpdateRequest,
  type IssueCommentAcceptedEvent,
  type IssueCommentEvent,
  type IssueCommentRejectedEvent,
  type IssueCommentRequest,
  type LinearTriageLinkEvent,
  type LinearTriageLinkRequest,
  type ModelStreamRequest,
  type ModelStreamServerMessage,
  type WhatConfirmationResult,
  type WhatConfirmationStartEvent,
} from "@mikan-919/oriel-contracts";

import { readNdjson, writeNdjson } from "./ndjson";

export interface IssueCommentOperations {
  accept(
    request: IssueCommentRequest,
  ): Promise<IssueCommentAcceptedEvent | IssueCommentRejectedEvent>;
  waitForOutcome(operationId: string): Promise<IssueCommentEvent>;
}

export interface IssueBodyOperations {
  update(request: IssueBodyUpdateRequest): Promise<IssueBodyUpdateEvent>;
}

export interface LinearTriageLinkOperations {
  ensure(request: LinearTriageLinkRequest): Promise<LinearTriageLinkEvent>;
}

export interface ModelStreamOperations {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamServerMessage>;
  abort(requestId: string): void;
}

export interface WhatConfirmationResultOperations {
  report(result: WhatConfirmationResult): void;
}

export interface WhatConfirmationOperations {
  issueComment: IssueCommentOperations;
  issueBody: IssueBodyOperations;
  linearTriageLink: LinearTriageLinkOperations;
  model: ModelStreamOperations;
  result: WhatConfirmationResultOperations;
}

/**
 * WHAT確定workerのIPC。
 *
 * `issue_comment`(既存の返答経路)、`issue_body`(本文確定)、
 * `linear_triage_link`(Triage作成・紐付け)、model streamを一本のstdioで多重化
 * する。いずれの要求もstart eventが示す対象と一致する場合だけ処理する。
 */
export async function serveOwnedHarnessWhatConfirmationIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  start: WhatConfirmationStartEvent,
  operations: WhatConfirmationOperations,
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

      if (request.type === "what_confirmation.result") {
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

      if (request.type === "issue_body.request") {
        await send(await operations.issueBody.update(request));
        continue;
      }

      if (request.type === "linear_triage_link.request") {
        await send(await operations.linearTriageLink.ensure(request));
        continue;
      }

      const acceptedOrRejected = await operations.issueComment.accept(request);
      await send(acceptedOrRejected);

      if (acceptedOrRejected.type === "issue_comment.rejected") {
        continue;
      }

      await send(
        await operations.issueComment.waitForOutcome(
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
): ReturnType<typeof parseWhatConfirmationClientMessage> | null {
  try {
    return parseWhatConfirmationClientMessage(message);
  } catch {
    return null;
  }
}

function matchesTarget(
  request:
    IssueCommentRequest | IssueBodyUpdateRequest | LinearTriageLinkRequest,
  start: WhatConfirmationStartEvent,
): boolean {
  return (
    request.jobId === start.jobId &&
    request.jobLeaseId === start.jobLeaseId &&
    request.repository.owner === start.repository.owner &&
    request.repository.name === start.repository.name &&
    request.issueNumber === start.issueNumber
  );
}

function rejectedTargetMismatch(
  request:
    IssueCommentRequest | IssueBodyUpdateRequest | LinearTriageLinkRequest,
): IssueCommentRejectedEvent | IssueBodyUpdateEvent | LinearTriageLinkEvent {
  if (request.type === "issue_comment.request") {
    return {
      type: "issue_comment.rejected",
      requestId: request.requestId,
      reason: "target_mismatch",
    };
  }

  if (request.type === "issue_body.request") {
    return {
      type: "issue_body.rejected",
      requestId: request.requestId,
      reason: "target_mismatch",
    };
  }

  return {
    type: "linear_triage_link.rejected",
    requestId: request.requestId,
    reason: "target_mismatch",
  };
}

function invalid(message: unknown): IssueCommentRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    message.requestId !== ""
      ? message.requestId
      : "invalid-request";

  return {
    type: "issue_comment.rejected",
    requestId,
    reason: "invalid_request",
  };
}
