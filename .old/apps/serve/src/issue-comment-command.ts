import type { GitHubRepository } from "@mikan-919/oriel-contracts";
import type { Octokit } from "@octokit/rest";

import type { JobOwnershipVerifier } from "./issue-comments";
import { startIssueCommentRuntime } from "./issue-comment-runtime";

export interface ExplicitIssueConversation {
  jobId: string;
  jobLeaseId: string;
  repository: GitHubRepository;
  issueNumber: number;
}

/**
 * Binds a harness stdio channel to a Job whose ownership was already verified
 * by trusted serve orchestration. The harness cannot provide the verifier or
 * GitHub client.
 */
export async function runExplicitIssueConversation({
  input,
  output,
  conversation,
  databasePath,
  octokit,
  ownershipVerifier,
}: {
  input: ReadableStream<Uint8Array>;
  output: WritableStream<Uint8Array>;
  conversation: ExplicitIssueConversation;
  databasePath: string;
  octokit: Octokit;
  ownershipVerifier: JobOwnershipVerifier;
}) {
  const runtime = startIssueCommentRuntime({
    databasePath,
    octokit,
    ownershipVerifier,
  });

  try {
    await runtime.serveHarnessIssueConversation(input, output, conversation);
  } finally {
    runtime.close();
  }
}
