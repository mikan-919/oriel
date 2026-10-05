import {
  parsePrResponseClientMessage,
  type CheckpointAcceptedEvent,
  type CheckpointCompletedEvent,
  type CheckpointRejectedEvent,
  type CheckpointRequest,
  type ModelStreamRequest,
  type ModelStreamServerMessage,
  type PrResponseResult,
  type PrResponseStartEvent,
} from "@mikan-919/oriel-contracts";

import { readNdjson, writeNdjson } from "./ndjson";

export interface CheckpointOperations {
  accept(
    request: CheckpointRequest,
  ): Promise<CheckpointAcceptedEvent | CheckpointRejectedEvent>;
  deliver(
    operationId: string,
  ): Promise<CheckpointCompletedEvent | CheckpointRejectedEvent>;
}

export interface ModelStreamOperations {
  stream(request: ModelStreamRequest): AsyncIterable<ModelStreamServerMessage>;
  abort(requestId: string): void;
}

/** harnessが明示するPR対応結果の受け取り。応答は返さない。 */
export interface PrResponseResultOperations {
  report(result: PrResponseResult): void;
}

export interface PrResponseOperations {
  checkpoint: CheckpointOperations;
  model: ModelStreamOperations;
  result: PrResponseResultOperations;
}

/**
 * PR対応workerのIPC。`implementation-ipc.ts`と同じ形だが、
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のPR対応契約
 * (`pr_response.*`)だけを解釈する。
 */
export async function serveOwnedHarnessPrResponseIpc(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  start: PrResponseStartEvent,
  operations: PrResponseOperations,
  stopSignal?: AbortSignal,
  /** ユーザーがWeb UIから求めた計画停止。接続所有権喪失時のstopSignalとは別。 */
  userStopSignal?: AbortSignal,
): Promise<void> {
  const writer = output.getWriter();
  let writes = Promise.resolve();
  const send = (message: unknown): Promise<void> => {
    writes = writes.then(() => writeNdjson(writer, message));
    return writes;
  };
  const streaming = new Set<Promise<void>>();
  let stopRequested = false;
  const requestStop = () => {
    if (stopRequested) {
      return;
    }

    stopRequested = true;
    void send({
      type: "stop.request",
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
    });
  };

  // すでに求められていた場合も含め、必ずstart eventの後に送る。
  userStopSignal?.addEventListener("abort", requestStop, { once: true });

  try {
    await send(start);

    if (userStopSignal?.aborted === true) {
      requestStop();
    }

    for await (const message of readNdjson(input, stopSignal)) {
      const request = parseRequest(message);

      if (request === null) {
        await send(invalid(message));
        continue;
      }

      if (request.type === "pr_response.result") {
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

      const acceptedOrRejected = await operations.checkpoint.accept(request);
      await send(acceptedOrRejected);

      if (acceptedOrRejected.type === "checkpoint.rejected") {
        continue;
      }

      await send(
        await operations.checkpoint.deliver(acceptedOrRejected.operationId),
      );
    }

    await Promise.all(streaming);
  } finally {
    userStopSignal?.removeEventListener("abort", requestStop);
    await writes.catch(() => {});
    writer.releaseLock();
  }
}

function parseRequest(
  message: unknown,
): ReturnType<typeof parsePrResponseClientMessage> | null {
  try {
    return parsePrResponseClientMessage(message);
  } catch {
    return null;
  }
}

function invalid(message: unknown): CheckpointRejectedEvent {
  const requestId =
    typeof message === "object" &&
    message !== null &&
    "requestId" in message &&
    typeof message.requestId === "string" &&
    message.requestId !== ""
      ? message.requestId
      : "invalid-request";

  return { type: "checkpoint.rejected", requestId, reason: "invalid_request" };
}
