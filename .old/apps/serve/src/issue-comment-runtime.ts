import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import {
  createIssueCommentOutbox,
  createIssueCommentService,
  createOctokitIssueCommentPublisher,
  type JobOwnershipVerifier,
} from "./issue-comments";
import {
  type IssueConversationBinding,
  serveOwnedHarnessIssueCommentIpc,
} from "./issue-comment-ipc";
import { createJobStateStore } from "./job-state";
import { openServeLocalState } from "./local-state";

export interface StartIssueCommentRuntimeOptions {
  databasePath: string;
  octokit: Octokit;
  ownershipVerifier: JobOwnershipVerifier;
}

export function startIssueCommentRuntime({
  databasePath,
  octokit,
  ownershipVerifier,
}: StartIssueCommentRuntimeOptions) {
  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const service = createIssueCommentService({
    outbox: createIssueCommentOutbox(database),
    ownershipVerifier,
    publisher: createOctokitIssueCommentPublisher(octokit),
  });
  const runningJobs = new Set<string>();

  // 所有権を失ったら、workerと新しい外部操作を止めてJobを`interrupted`へ移す。
  ownershipVerifier.stopSignal?.addEventListener("abort", () => {
    for (const jobId of runningJobs) {
      jobState.set(jobId, "interrupted");
    }

    runningJobs.clear();
  });

  return {
    serveHarnessIssueConversation(
      input: ReadableStream<Uint8Array>,
      output: WritableStream<Uint8Array>,
      binding: IssueConversationBinding,
    ) {
      if (ownershipVerifier.stopSignal?.aborted === true) {
        jobState.set(binding.jobId, "interrupted");
      } else {
        runningJobs.add(binding.jobId);
        jobState.set(binding.jobId, "running");
      }

      void service.resumePending(binding);
      return serveOwnedHarnessIssueCommentIpc(
        input,
        output,
        binding,
        service,
        ownershipVerifier.stopSignal,
      );
    },
    /** 正常終了。以後の所有権喪失で`interrupted`へ誤って移さない。 */
    completeJob(jobId: string) {
      if (runningJobs.delete(jobId)) {
        jobState.set(jobId, "completed");
      }
    },
    jobStatus(jobId: string) {
      return jobState.get(jobId);
    },
    close() {
      database.close();
    },
  };
}

export function issueConversationBinding(input: {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
}): IssueConversationBinding {
  return input;
}
