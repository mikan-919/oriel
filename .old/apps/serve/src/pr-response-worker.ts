import type {
  PrResponseResult,
  PrResponseStartEvent,
} from "@mikan-919/oriel-contracts";

import {
  openCanonicalWorktree,
  pushCheckpoint,
  type CanonicalWorktree,
} from "./canonical-worktree";
import {
  createCheckpointOutbox,
  createCheckpointService,
  type BranchOwnershipVerifier,
  type CheckpointBinding,
} from "./checkpoint-push";
import type { GitCredential } from "./git";
import {
  serveOwnedHarnessPrResponseIpc,
  type CheckpointOperations,
} from "./pr-response-ipc";
import { createJobStateStore } from "./job-state";
import { openServeLocalState } from "./local-state";
import {
  createModelStreamService,
  type ModelStreamProvider,
} from "./model-stream";
import { createTranscriptStore } from "./transcript-store";
import type { ReconcileApproval } from "./implementation-admission";
import { onAbort } from "./abort-signal";

export interface StartPrResponseWorkerOptions {
  databasePath: string;
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  harnessEntry: URL | string;
  ownership: BranchOwnershipVerifier & { readonly stopSignal?: AbortSignal };
  binding: CheckpointBinding;
  /** worktreeを開いた後にharnessへ渡すstart event。 */
  start: Omit<PrResponseStartEvent, "worktreePath" | "worktreeOid">;
  modelProvider: ModelStreamProvider;
  reconcileApproval: ReconcileApproval;
  resolveCredential: () => Promise<GitCredential | null>;
  release: () => void;
}

export interface PrResponseWorker {
  status: "started";
  worktreePath: string;
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): Promise<void>;
  /**
   * Web UIからの計画停止。harnessへ停止要求を送り、現在のturnを安全に区切って
   * checkpointをpushさせてから終了させる。接続所有権喪失時の即時abortとは別。
   */
  requestStop(): void;
}

export type PrResponseWorkerRefusalReason = "canonical_worktree_unavailable";

export type StartPrResponseWorkerResult =
  | PrResponseWorker
  | { status: "refused"; reason: PrResponseWorkerRefusalReason };

/**
 * PR対応Jobのworker。
 *
 * [ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のとおり、
 * 既に開いているPull Requestのcanonicalブランチの現在の先端でworktreeを開き
 * (`openCanonicalWorktree`を実装Jobとそのまま共有する)、credentialを持たない
 * harnessへtriggerの内容だけを渡す。checkpoint機構も実装Jobと共有する。
 */
export async function startPrResponseWorker({
  databasePath,
  repositoryRoot,
  worktreesRoot,
  remote,
  harnessEntry,
  ownership,
  binding,
  start,
  modelProvider,
  reconcileApproval,
  resolveCredential,
  release,
}: StartPrResponseWorkerOptions): Promise<StartPrResponseWorkerResult> {
  const credential = await resolveCredential();
  const worktree: CanonicalWorktree | null = await openCanonicalWorktree({
    repositoryRoot,
    worktreesRoot,
    jobId: binding.jobId,
    canonicalBranch: start.canonicalBranch,
    canonicalOid: start.canonicalOid,
    remote,
    credential,
  });

  if (worktree === null) {
    return { status: "refused", reason: "canonical_worktree_unavailable" };
  }

  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const transcripts = createTranscriptStore(database);

  transcripts.append({
    jobId: binding.jobId,
    repository: binding.repository,
    kind: "job.start",
    content: JSON.stringify({ type: "pr_response" }),
  });

  const checkpoints = createCheckpointService({
    outbox: createCheckpointOutbox(database),
    binding,
    ownership,
    reconcileApproval,
    resolveCredential,
    push: (input) =>
      pushCheckpoint({ ...input, worktreePath: worktree.path, remote }),
  });
  const models = createModelStreamService({
    binding: {
      jobId: binding.jobId,
      jobLeaseId: binding.jobLeaseId,
      model: start.model,
      repository: binding.repository,
      issueNumber: binding.issueNumber,
    },
    ownership,
    provider: modelProvider,
    transcript: transcripts,
  });

  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--mode",
      "pr-response",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: Bun.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
    },
  );
  const stopHarness = () => harness.kill();
  const userStop = new AbortController();
  let running = !(ownership.stopSignal?.aborted ?? false);
  const restorable = [start.canonicalOid];
  let checkpointRefused = false;
  let checkpointCompleted = false;
  let reported: PrResponseResult | null = null;

  const interrupt = () => {
    if (running) {
      running = false;
      jobState.set(binding.jobId, "interrupted");
    }
  };

  jobState.set(binding.jobId, running ? "running" : "interrupted");
  onAbort(ownership.stopSignal, stopHarness);
  onAbort(ownership.stopSignal, interrupt);

  const observed: CheckpointOperations = {
    async accept(request) {
      const event = await checkpoints.accept(request);

      if (event.type === "checkpoint.rejected") {
        checkpointRefused = true;
        interrupt();
        stopHarness();
      }

      return event;
    },
    async deliver(operationId) {
      const event = await checkpoints.deliver(operationId);

      if (event.type === "checkpoint.completed") {
        checkpointCompleted = true;
        restorable.push(event.canonicalOid);
      } else {
        checkpointRefused = true;
        interrupt();
        stopHarness();
      }

      return event;
    },
  };

  const serving = serveOwnedHarnessPrResponseIpc(
    harness.stdout,
    new WritableStream<Uint8Array>({
      write(chunk) {
        try {
          harness.stdin.write(chunk);
          harness.stdin.flush();
        } catch {
          // harnessが既に終了している場合、書き込みの失敗はabort/interrupt
          // 側が扱う。ここで投げるとJobを不必要に異常終了させる。
        }
      },
      close() {
        harness.stdin.end();
      },
    }),
    { ...start, worktreePath: worktree.path, worktreeOid: start.canonicalOid },
    {
      checkpoint: observed,
      model: models,
      result: {
        report(result) {
          reported = result;
          transcripts.append({
            jobId: binding.jobId,
            repository: binding.repository,
            kind: "job.result",
            content: JSON.stringify(result),
          });
        },
      },
    },
    ownership.stopSignal,
    userStop.signal,
  );

  let lastJobStatus: string | null = null;
  let closed = false;

  return {
    status: "started",
    worktreePath: worktree.path,
    requestStop: () => userStop.abort(),
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      if (!running) {
        return;
      }

      running = false;
      jobState.set(
        binding.jobId,
        exitCode === 0 &&
          !checkpointRefused &&
          checkpointCompleted &&
          resolved(reported)
          ? "completed"
          : "interrupted",
      );
    }),
    jobStatus: () => (closed ? lastJobStatus : jobState.get(binding.jobId)),
    async close() {
      if (closed) {
        return;
      }

      lastJobStatus = jobState.get(binding.jobId);
      closed = true;
      ownership.stopSignal?.removeEventListener("abort", stopHarness);
      harness.kill();
      release();
      database.close();

      if (lastJobStatus === "completed") {
        await worktree.remove(restorable);
      }
    },
  };
}

/**
 * harnessが明示した結果が、対応完了と言えるか。実装Jobの`implemented`と同じ
 * 基準を使う: 未完了のturn、tool実行のない実行、sourceを変えていない実行、
 * 検証を通していない実行、結果そのものが届かなかった実行は完了にしない。
 */
function resolved(result: PrResponseResult | null): boolean {
  return (
    result !== null &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted" &&
    result.stopReason !== "unknown" &&
    result.acted &&
    result.sourceChanged &&
    result.verified
  );
}
