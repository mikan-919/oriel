import type {
  GitHubRepository,
  ModelStreamRequest,
  ModelStreamServerMessage,
} from "@mikan-919/oriel-contracts";

import type { JobOwnershipVerifier } from "./issue-comments";
import type { TranscriptStore } from "./transcript-store";

/** このJobがmodelへ要求してよい唯一の対象。 */
export interface ModelStreamBinding {
  jobId: string;
  jobLeaseId: string;
  /** `serve`が選んだ提供元とmodelの論理識別子。 */
  model: { provider: string; id: string };
  repository: GitHubRepository;
  issueNumber: number;
}

/**
 * 提供元への接続。
 *
 * 接続先、認証情報、互換性設定の正本は`serve`にあり、この境界の外へは論理識別子
 * しか出ない。modelを利用できない場合は例外で止め、別のmodelへ暗黙に切り替えない。
 */
export interface ModelStreamProvider {
  stream(input: {
    provider: string;
    model: string;
    context: unknown;
    signal: AbortSignal;
  }): AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;
}

export interface ModelStreamServiceDependencies {
  binding: ModelStreamBinding;
  ownership: JobOwnershipVerifier;
  provider: ModelStreamProvider;
  /** すべてのJob種別が通るAgent実行系のtranscriptを、ここ一箇所で記録する。 */
  transcript: TranscriptStore;
}

/**
 * harnessのAgent loopへmodel streamを供給する用途限定操作。
 *
 * harnessは論理的な提供元IDとmodel IDだけを指定し、credentialも接続先も知らない。
 * `serve`は要求の対象と現在のJob取得IDを確認してから提供元へ接続し、provider
 * eventを別形式へ変換せずそのまま運ぶ。
 */
export function createModelStreamService({
  binding,
  ownership,
  provider,
  transcript,
}: ModelStreamServiceDependencies) {
  const running = new Map<string, AbortController>();
  const record = (kind: string, content: unknown) =>
    transcript.append({
      jobId: binding.jobId,
      repository: binding.repository,
      kind,
      content: JSON.stringify(content),
    });

  async function* stream(
    request: ModelStreamRequest,
  ): AsyncGenerator<ModelStreamServerMessage> {
    if (!matchesBinding(request, binding)) {
      yield rejected(request.requestId, "target_mismatch");
      return;
    }

    const current = await Promise.resolve(
      ownership.hasCurrentJobOwnership({
        jobId: binding.jobId,
        jobLeaseId: binding.jobLeaseId,
        repository: binding.repository,
        issueNumber: binding.issueNumber,
      }),
    ).catch(() => false);

    if (!current) {
      yield rejected(request.requestId, "ownership_not_current");
      return;
    }

    record("model.stream.request", request.context);

    const abort = new AbortController();

    running.set(request.requestId, abort);

    let events;

    try {
      events = await provider.stream({
        provider: request.provider,
        model: request.model,
        context: request.context,
        signal: abort.signal,
      });
    } catch {
      running.delete(request.requestId);
      yield rejected(request.requestId, "model_unavailable");
      return;
    }

    let delivered = 0;

    try {
      for await (const event of events) {
        delivered += 1;
        record("model.stream.event", event);
        yield {
          type: "model.stream.event",
          requestId: request.requestId,
          event,
        };
      }
    } catch {
      // 途中で提供元が落ちた場合も、要求を開いたままにしない。
      running.delete(request.requestId);

      yield delivered === 0
        ? rejected(request.requestId, "model_unavailable")
        : { type: "model.stream.end", requestId: request.requestId };

      return;
    } finally {
      running.delete(request.requestId);
    }

    yield { type: "model.stream.end", requestId: request.requestId };
  }

  /** 中止は制御messageとして表す。AbortSignal自体はprocess間を渡らない。 */
  function abort(requestId: string): void {
    running.get(requestId)?.abort();
  }

  return { stream, abort };
}

function matchesBinding(
  request: ModelStreamRequest,
  binding: ModelStreamBinding,
): boolean {
  return (
    request.jobId === binding.jobId &&
    request.jobLeaseId === binding.jobLeaseId &&
    request.provider === binding.model.provider &&
    request.model === binding.model.id
  );
}

function rejected(
  requestId: string,
  reason: Extract<
    ModelStreamServerMessage,
    { type: "model.stream.rejected" }
  >["reason"],
): ModelStreamServerMessage {
  return { type: "model.stream.rejected", requestId, reason };
}
