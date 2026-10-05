import type {
  HowConfirmationResult,
  HowConfirmationStartEvent,
} from "@mikan-919/oriel-contracts";

import { onAbort } from "./abort-signal";
import { serveOwnedHarnessHowConfirmationIpc } from "./how-conversation-ipc";
import type { JobOwnershipVerifier } from "./issue-comments";
import {
  createLinearCommentOutbox,
  createLinearCommentService,
  type LinearCommentPublisher,
} from "./linear-comments";
import {
  updateLinearDescription,
  type LinearDescriptionPublisher,
} from "./linear-description";
import { createJobStateStore } from "./job-state";
import { openServeLocalState } from "./local-state";
import {
  createModelStreamService,
  type ModelStreamProvider,
} from "./model-stream";
import { createTranscriptStore } from "./transcript-store";

export interface HowConfirmationOwnership extends JobOwnershipVerifier {
  readonly stopSignal: AbortSignal;
  release(): void;
}

export interface StartHowConfirmationWorkerOptions {
  databasePath: string;
  ownership: HowConfirmationOwnership;
  harnessEntry: URL | string;
  start: HowConfirmationStartEvent;
  linearCommentPublisher: LinearCommentPublisher;
  linearDescriptionPublisher: LinearDescriptionPublisher;
  modelProvider: ModelStreamProvider;
}

export interface HowConfirmationWorker {
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): void;
}

/**
 * HOW確定Jobのworker。credentialを持たないharness processを起動し、Linear
 * comment・Linear description・model streamの3種の用途限定操作を一本のNDJSON
 * stdioで提供する。GitHub credentialは不要(この対話はLinear issueだけを書く)。
 */
export function startHowConfirmationWorker({
  databasePath,
  ownership,
  harnessEntry,
  start,
  linearCommentPublisher,
  linearDescriptionPublisher,
  modelProvider,
}: StartHowConfirmationWorkerOptions): HowConfirmationWorker {
  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const transcripts = createTranscriptStore(database);

  transcripts.append({
    jobId: start.jobId,
    repository: start.repository,
    kind: "job.start",
    content: JSON.stringify({ type: "how_confirmation" }),
  });

  const linearCommentService = createLinearCommentService({
    outbox: createLinearCommentOutbox(database),
    ownershipVerifier: ownership,
    publisher: linearCommentPublisher,
  });
  const models = createModelStreamService({
    binding: {
      jobId: start.jobId,
      jobLeaseId: start.jobLeaseId,
      model: start.model,
      repository: start.repository,
      issueNumber: start.issueNumber,
    },
    ownership,
    provider: modelProvider,
    transcript: transcripts,
  });
  const target = {
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
  };

  void linearCommentService.resumePending(target);

  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--mode",
      "how",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} },
  );
  const stopHarness = () => harness.kill();
  let running = !ownership.stopSignal.aborted;
  let reported: HowConfirmationResult | null = null;

  const interrupt = () => {
    if (running) {
      running = false;
      jobState.set(start.jobId, "interrupted");
    }
  };

  jobState.set(start.jobId, running ? "running" : "interrupted");
  onAbort(ownership.stopSignal, stopHarness);
  onAbort(ownership.stopSignal, interrupt);

  const serving = serveOwnedHarnessHowConfirmationIpc(
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
    start,
    {
      linearComment: linearCommentService,
      linearDescription: {
        update: (request) =>
          updateLinearDescription({
            database,
            ownershipVerifier: ownership,
            publisher: linearDescriptionPublisher,
            request,
          }),
      },
      model: models,
      result: {
        report(result) {
          reported = result;
          transcripts.append({
            jobId: start.jobId,
            repository: start.repository,
            kind: "job.result",
            content: JSON.stringify(result),
          });
        },
      },
    },
    ownership.stopSignal,
  );

  let lastJobStatus: string | null = null;
  let closed = false;

  return {
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      if (!running) {
        return;
      }

      running = false;
      jobState.set(
        start.jobId,
        exitCode === 0 && completed(reported) ? "completed" : "interrupted",
      );
    }),
    jobStatus: () => (closed ? lastJobStatus : jobState.get(start.jobId)),
    close() {
      if (closed) {
        return;
      }

      lastJobStatus = jobState.get(start.jobId);
      closed = true;
      ownership.stopSignal.removeEventListener("abort", stopHarness);
      harness.kill();
      ownership.release();
      database.close();
    },
  };
}

/** harnessが結果を明示し、turnがerror/aborted/unknownで止まっていない場合だけ完了とする。 */
function completed(result: HowConfirmationResult | null): boolean {
  return (
    result !== null &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted" &&
    result.stopReason !== "unknown"
  );
}
