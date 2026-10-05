import type {
  GitHubRepository,
  WhatConfirmationResult,
  WhatConfirmationStartEvent,
} from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import { onAbort } from "./abort-signal";
import {
  createIssueCommentOutbox,
  createIssueCommentService,
  createOctokitIssueCommentPublisher,
  type JobOwnershipVerifier,
} from "./issue-comments";
import { createOctokitIssueBodyPublisher, updateIssueBody } from "./issue-body";
import { createJobStateStore } from "./job-state";
import type { LinearDiscoveryReader } from "./linear-approval";
import { ensureLinearTriageLink } from "./linear-triage-link";
import type { LinearTriageWriter } from "./linear-triage-writer";
import { openServeLocalState } from "./local-state";
import {
  createModelStreamService,
  type ModelStreamProvider,
} from "./model-stream";
import { createTranscriptStore } from "./transcript-store";
import { serveOwnedHarnessWhatConfirmationIpc } from "./what-conversation-ipc";

export interface WhatConfirmationOwnership extends JobOwnershipVerifier {
  readonly stopSignal: AbortSignal;
  release(): void;
}

export interface StartWhatConfirmationWorkerOptions {
  databasePath: string;
  octokit: Octokit;
  ownership: WhatConfirmationOwnership;
  harnessEntry: URL | string;
  start: WhatConfirmationStartEvent;
  githubIssueUrl: string;
  linearTeamId: string;
  linearDiscovery: LinearDiscoveryReader;
  linearTriageWriter: LinearTriageWriter;
  modelProvider: ModelStreamProvider;
}

export interface WhatConfirmationWorker {
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): void;
}

/**
 * WHAT確定Jobのworker。credentialを持たないharness processを起動し、Issue
 * comment・Issue本文・Linear Triage紐付け・model streamの4種の用途限定操作を
 * 一本のNDJSON stdioで提供する。
 */
export function startWhatConfirmationWorker({
  databasePath,
  octokit,
  ownership,
  harnessEntry,
  start,
  githubIssueUrl,
  linearTeamId,
  linearDiscovery,
  linearTriageWriter,
  modelProvider,
}: StartWhatConfirmationWorkerOptions): WhatConfirmationWorker {
  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const transcripts = createTranscriptStore(database);

  transcripts.append({
    jobId: start.jobId,
    repository: start.repository,
    kind: "job.start",
    content: JSON.stringify({ type: "what_confirmation" }),
  });

  const issueCommentService = createIssueCommentService({
    outbox: createIssueCommentOutbox(database),
    ownershipVerifier: ownership,
    publisher: createOctokitIssueCommentPublisher(octokit),
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
  const target: {
    jobId: string;
    jobLeaseId: string;
    repository: GitHubRepository;
    issueNumber: number;
  } = {
    jobId: start.jobId,
    jobLeaseId: start.jobLeaseId,
    repository: start.repository,
    issueNumber: start.issueNumber,
  };

  void issueCommentService.resumePending(target);

  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--mode",
      "what",
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} },
  );
  const stopHarness = () => harness.kill();
  let running = !ownership.stopSignal.aborted;
  let reported: WhatConfirmationResult | null = null;

  const interrupt = () => {
    if (running) {
      running = false;
      jobState.set(start.jobId, "interrupted");
    }
  };

  jobState.set(start.jobId, running ? "running" : "interrupted");
  onAbort(ownership.stopSignal, stopHarness);
  onAbort(ownership.stopSignal, interrupt);

  const serving = serveOwnedHarnessWhatConfirmationIpc(
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
      issueComment: issueCommentService,
      issueBody: {
        update: (request) =>
          updateIssueBody({
            database,
            ownershipVerifier: ownership,
            publisher: createOctokitIssueBodyPublisher(octokit),
            request,
          }),
      },
      linearTriageLink: {
        ensure: (request) =>
          ensureLinearTriageLink({
            database,
            ownershipVerifier: ownership,
            discovery: linearDiscovery,
            writer: linearTriageWriter,
            linearTeamId,
            githubIssueUrl,
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
function completed(result: WhatConfirmationResult | null): boolean {
  return (
    result !== null &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted" &&
    result.stopReason !== "unknown"
  );
}
