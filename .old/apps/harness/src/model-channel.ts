import { randomUUID } from "node:crypto";

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type ProviderId,
} from "@earendil-works/pi-ai";
import type {
  ModelStreamRequest,
  ModelStreamServerMessage,
} from "@mikan-919/oriel-contracts";

/** `serve`のmodel stream操作へつなぐIPC境界。 */
export interface ModelStreamChannel {
  open(request: ModelStreamRequest): AsyncIterable<ModelStreamServerMessage>;
  abort(requestId: string): void;
}

export interface ProxyStreamFnOptions {
  jobId: string;
  jobLeaseId: string;
  /** `serve`がstart eventで指定した論理識別子。 */
  model: { provider: string; id: string };
  channel: ModelStreamChannel;
  newRequestId?: () => string;
}

/**
 * Agent loopのStreamFnを`serve`へのproxyにする。
 *
 * ROADMAPのとおり、プロセス間の境界は`pi-agent-core`が受け取る`StreamFn`とし、
 * pi-aiのstream eventを別形式へ変換しない。IPCは要求の対応付け、event配送、
 * 中止、切断検知だけを加える。credentialも接続先もこちら側には存在しない。
 *
 * StreamFnの契約どおり例外は投げず、失敗はstream内のerror eventと最終message
 * として表す。切断で終端eventが届かなかったturnは`aborted`として閉じる。
 */
export function createProxyStreamFn({
  jobId,
  jobLeaseId,
  model,
  channel,
  newRequestId = randomUUID,
}: ProxyStreamFnOptions): StreamFn {
  return (requestModel, context, options) => {
    const stream = createAssistantMessageEventStream();
    const requestId = newRequestId();
    let terminated = false;

    const terminate = (
      reason: "error" | "aborted",
      errorMessage: string,
    ): void => {
      if (terminated) {
        return;
      }

      terminated = true;
      stream.push({
        type: "error",
        reason,
        error: finalMessage(requestModel, reason, errorMessage),
      });
    };

    options?.signal?.addEventListener(
      "abort",
      () => {
        channel.abort(requestId);
      },
      { once: true },
    );

    void (async () => {
      try {
        const messages = channel.open({
          type: "model.stream.request",
          requestId,
          jobId,
          jobLeaseId,
          provider: model.provider,
          model: model.id,
          context,
        });

        for await (const message of messages) {
          if (message.type === "model.stream.rejected") {
            terminate(
              "error",
              `the model stream was refused: ${message.reason}`,
            );
            break;
          }

          if (message.type === "model.stream.end") {
            break;
          }

          const event = message.event as AssistantMessageEvent;

          if (event.type === "done" || event.type === "error") {
            terminated = true;
          }

          stream.push(event);
        }
      } catch (cause) {
        terminate(
          "error",
          cause instanceof Error ? cause.message : "the model stream failed",
        );
      }

      // 終端eventのないまま切れたturnは、未完了として閉じる。
      terminate("aborted", "the model stream ended without a final message");
      stream.end();
    })();

    return stream;
  };
}

function finalMessage(
  model: Model<Api>,
  stopReason: "error" | "aborted",
  errorMessage: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider as ProviderId,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: Date.now(),
  };
}
