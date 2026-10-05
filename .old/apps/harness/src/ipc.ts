import type { ModelStreamServerMessage } from "@mikan-919/oriel-contracts";

/** 消費されるまで順序を保つ、単方向の受信queue。 */
class MessageQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiting: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) {
      return;
    }

    const waiter = this.waiting.shift();

    if (waiter === undefined) {
      this.buffered.push(value);
    } else {
      waiter({ value, done: false });
    }
  }

  end(): void {
    this.ended = true;

    while (this.waiting.length > 0) {
      this.waiting.shift()?.({ value: undefined, done: true });
    }
  }

  next(): Promise<T | undefined> {
    const buffered = this.buffered.shift();

    if (buffered !== undefined) {
      return Promise.resolve(buffered);
    }

    if (this.ended) {
      return Promise.resolve(undefined);
    }

    return new Promise<T | undefined>((resolve) => {
      this.waiting.push((result) =>
        resolve(result.done === true ? undefined : result.value),
      );
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const value = await this.next();

      if (value === undefined) {
        return;
      }

      yield value;
    }
  }
}

const modelStreamTypes = new Set([
  "model.stream.event",
  "model.stream.end",
  "model.stream.rejected",
]);

function modelStreamRequestId(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }

  const candidate = message as { type?: unknown; requestId?: unknown };

  return typeof candidate.type === "string" &&
    modelStreamTypes.has(candidate.type) &&
    typeof candidate.requestId === "string"
    ? candidate.requestId
    : null;
}

function isStopRequest(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as { type?: unknown }).type === "stop.request"
  );
}

/**
 * stdinで届くmessageの対応付け。
 *
 * IPCが加えるのは要求の対応付け、event配送、中止、切断検知だけとする。model
 * streamは`requestId`ごとの購読へ、それ以外は届いた順の単一応答として渡す。
 */
export function createHarnessMessageRouter() {
  const general = new MessageQueue<unknown>();
  const streams = new Map<string, MessageQueue<ModelStreamServerMessage>>();
  let onStop: (() => void) | null = null;

  return {
    deliver(message: unknown): void {
      // 停止要求はcheckpoint応答のような順序待ちの一般queueへ混ぜず、即座に
      // 中断へつなぐ。
      if (isStopRequest(message)) {
        onStop?.();
        return;
      }

      const requestId = modelStreamRequestId(message);
      const stream = requestId === null ? undefined : streams.get(requestId);

      if (requestId === null || stream === undefined) {
        general.push(message);
        return;
      }

      stream.push(message as ModelStreamServerMessage);

      if ((message as { type: string }).type === "model.stream.end") {
        streams.delete(requestId);
        stream.end();
      }
    },
    /** checkpointのような、順に届く単一の応答を待つ。 */
    read(): Promise<unknown> {
      return general.next() as Promise<unknown>;
    },
    /** model streamの購読を先に登録してから要求を送れるようにする。 */
    open(requestId: string): AsyncIterable<ModelStreamServerMessage> {
      const stream = new MessageQueue<ModelStreamServerMessage>();

      streams.set(requestId, stream);

      return stream;
    },
    /** 停止要求を受けたときの処理を登録する。 */
    onStop(handler: () => void): void {
      onStop = handler;
    },
    /** 切断時は購読も閉じ、待ち続けるturnを残さない。 */
    close(): void {
      for (const stream of streams.values()) {
        stream.end();
      }

      streams.clear();
      general.end();
    },
  };
}

export type HarnessMessageRouter = ReturnType<
  typeof createHarnessMessageRouter
>;
