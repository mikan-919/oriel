import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import { onAbort } from "./abort-signal";
import { startIssueCommentRuntime } from "./issue-comment-runtime";
import type { RelayOwnershipConnection } from "./ownership-connection";

export interface HarnessWorkerOptions {
  databasePath: string;
  octokit: Octokit;
  ownership: RelayOwnershipConnection;
  harnessEntry: URL | string;
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
  /** harnessへ渡す作業内容。credentialは渡さない。 */
  body: string;
}

export interface HarnessWorker {
  /** harness processが終わるまで待つ。 */
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): void;
}

/**
 * Job単位のworker。credentialを持たないharness processを起動し、stdioのNDJSONを
 * `serve`の外部操作へつなぐ。所有権を失ったらprocessを止め、新しい外部操作を
 * させない。
 */
export function startHarnessWorker({
  databasePath,
  octokit,
  ownership,
  harnessEntry,
  jobId,
  jobLeaseId,
  repository,
  issueNumber,
  body,
}: HarnessWorkerOptions): HarnessWorker {
  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit,
    ownershipVerifier: ownership,
  });
  // harnessへはcredentialを渡さない。対象と取得IDだけを引数で渡す。
  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--request",
      `${jobId}:1`,
      "--job",
      jobId,
      "--lease",
      jobLeaseId,
      "--repository",
      `${repository.owner}/${repository.name}`,
      "--issue",
      String(issueNumber),
      "--body",
      body,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: {} },
  );
  const stopHarness = () => harness.kill();

  onAbort(ownership.stopSignal, stopHarness);

  const serving = runtime.serveHarnessIssueConversation(
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
    { jobId, jobLeaseId, repository, issueNumber },
  );

  let lastJobStatus: string | null = null;
  let closed = false;

  return {
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      // 所有権を失っていない正常終了だけを`completed`にする。
      if (!ownership.stopSignal.aborted && exitCode === 0) {
        runtime.completeJob(jobId);
      }
    }),
    jobStatus: () => (closed ? lastJobStatus : runtime.jobStatus(jobId)),
    close() {
      if (closed) {
        return;
      }

      // 閉じた後も最後の実行状態を答えられるようにする。
      lastJobStatus = runtime.jobStatus(jobId);
      closed = true;
      ownership.stopSignal.removeEventListener("abort", stopHarness);
      harness.kill();
      // heartbeatとleaseを持ち続けない。
      ownership.release();
      runtime.close();
    },
  };
}
