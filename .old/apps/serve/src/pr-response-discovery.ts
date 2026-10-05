import type { PrResponseTrigger } from "@mikan-919/oriel-contracts";

import {
  detectPrResponseTrigger,
  failingCheckConclusions,
  parseCanonicalBranchCandidate,
  resolvedCheckConclusions,
  type PrResponseCheckStatus,
  type PrResponseComment,
  type PrResponseReview,
  type PrResponseReviewComment,
} from "./pr-response-admission";
import {
  prResponseCheckFailureLimit,
  type PrResponseCheckFailureStore,
} from "./pr-response-check-failures";

/**
 * webhook通知と定期ポーリングからPR対応Jobのtriggerを発見するオーケストレーション
 * 層。[ADR 0007](../../../docs/adr/0007-pull-request-response-job.md)のとおり、
 * webhookは起床通知に過ぎない。起床後に対象PRのreview・comment・checkの現在値を
 * `serve`自身が読み直してtrigger判定する。
 */
export interface PrResponseCandidatePullRequest {
  number: number;
  headRef: string;
  baseRef: string;
  headOid: string;
}

export interface PrResponsePorts {
  /** headがcanonical branch命名規約に一致するものを含む、openなPull Request一覧。 */
  listOpenPullRequests(): Promise<PrResponseCandidatePullRequest[] | null>;
  listReviews(prNumber: number): Promise<PrResponseReview[] | null>;
  listComments(prNumber: number): Promise<PrResponseComment[] | null>;
  listReviewComments(
    prNumber: number,
  ): Promise<PrResponseReviewComment[] | null>;
  /**
   * target baseのbranch protectionが要求するcheckの現在値。branch protection未
   * 設定なら空配列、権限不足・通信不能などで読めない場合はnull(fail closed)。
   */
  listRequiredCheckStatuses(input: {
    prNumber: number;
    headOid: string;
    baseRef: string;
  }): Promise<PrResponseCheckStatus[] | null>;
}

export interface PrResponseScanResult {
  candidatesConsidered: number;
  jobsStarted: number;
}

export type PrResponseStartResult =
  | {
      status: "started";
      finished: Promise<void>;
      close: () => void | Promise<void>;
    }
  | { status: "refused"; reason?: string };

export type PrResponseWakeSource = "github" | "linear" | "poll";

export type PrResponseLogEvent =
  | { type: "scan_started"; source: PrResponseWakeSource }
  | { type: "scan_completed"; result: PrResponseScanResult }
  | { type: "job_start_refused"; prNumber: number; reason?: string };

export interface PrResponseLoopOptions {
  /** 短命tokenを都度解決するため、毎scanで呼び直す。取れなければnullでscanを無害に終える。 */
  createPorts: () => Promise<PrResponsePorts | null>;
  repositoryId: number;
  checkFailures: PrResponseCheckFailureStore;
  startPrResponseJob: (input: {
    prNumber: number;
    headRef: string;
    baseRef: string;
    headOid: string;
    githubIssueNumber: number;
    approvalFingerprint: string;
    trigger: PrResponseTrigger;
  }) => Promise<PrResponseStartResult>;
  pollIntervalMs: number;
  log?: (event: PrResponseLogEvent) => void;
}

export interface PrResponseLoop {
  start(): void;
  stop(): void;
  wake(source: PrResponseWakeSource): Promise<void>;
  runOnce(): Promise<PrResponseScanResult>;
}

export function createPrResponseLoop({
  createPorts,
  repositoryId,
  checkFailures,
  startPrResponseJob,
  pollIntervalMs,
  log = () => undefined,
}: PrResponseLoopOptions): PrResponseLoop {
  const inFlight = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let pendingRescan = false;
  let stopped = true;
  let currentRun: Promise<void> | null = null;

  async function scan(): Promise<PrResponseScanResult> {
    const result: PrResponseScanResult = {
      candidatesConsidered: 0,
      jobsStarted: 0,
    };
    const ports = await createPorts();

    if (ports === null) {
      return result;
    }

    const pullRequests = await ports.listOpenPullRequests();

    if (pullRequests === null) {
      return result;
    }

    for (const pullRequest of pullRequests) {
      const candidate = parseCanonicalBranchCandidate(pullRequest.headRef);

      if (candidate === null || inFlight.has(pullRequest.number)) {
        continue;
      }

      const [reviews, comments, reviewComments, requiredCheckStatuses] =
        await Promise.all([
          ports.listReviews(pullRequest.number),
          ports.listComments(pullRequest.number),
          ports.listReviewComments(pullRequest.number),
          ports.listRequiredCheckStatuses({
            prNumber: pullRequest.number,
            headOid: pullRequest.headOid,
            baseRef: pullRequest.baseRef,
          }),
        ]);

      if (
        reviews === null ||
        comments === null ||
        reviewComments === null ||
        requiredCheckStatuses === null
      ) {
        continue;
      }

      result.candidatesConsidered += 1;

      // ADR 0007の収束上限: successまたはneutralへ転じたcheckは回数を0へ戻す。
      for (const status of requiredCheckStatuses) {
        if (
          status.conclusion !== null &&
          resolvedCheckConclusions.has(status.conclusion)
        ) {
          checkFailures.reset(
            repositoryId,
            pullRequest.headRef,
            status.checkName,
          );
        }
      }

      const trigger = detectPrResponseTrigger({
        reviews,
        comments,
        reviewComments,
        // 上限に達したcheckはtriggerの対象から外す。
        checkFailures: requiredCheckStatuses.filter(
          (status): status is PrResponseCheckStatus & { conclusion: string } =>
            status.conclusion !== null &&
            failingCheckConclusions.has(status.conclusion) &&
            checkFailures.count(
              repositoryId,
              pullRequest.headRef,
              status.checkName,
            ) < prResponseCheckFailureLimit,
        ),
      });

      if (trigger === null) {
        continue;
      }

      inFlight.add(pullRequest.number);

      const started = await startPrResponseJob({
        prNumber: pullRequest.number,
        headRef: pullRequest.headRef,
        baseRef: pullRequest.baseRef,
        headOid: pullRequest.headOid,
        githubIssueNumber: candidate.githubIssueNumber,
        approvalFingerprint: candidate.approvalFingerprint,
        trigger,
      });

      if (started.status !== "started") {
        inFlight.delete(pullRequest.number);
        log({
          type: "job_start_refused",
          prNumber: pullRequest.number,
          reason: started.reason,
        });
        continue;
      }

      result.jobsStarted += 1;
      void started.finished
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(pullRequest.number);
          void started.close();
        });
    }

    return result;
  }

  function triggerScan(source: PrResponseWakeSource): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }

    if (running) {
      pendingRescan = true;
      return currentRun ?? Promise.resolve();
    }

    running = true;
    log({ type: "scan_started", source });

    const run = (async () => {
      try {
        const result = await scan();

        log({ type: "scan_completed", result });
      } finally {
        running = false;
      }

      if (pendingRescan) {
        pendingRescan = false;
        await triggerScan(source);
      }
    })();

    currentRun = run;

    return run.finally(() => {
      if (currentRun === run) {
        currentRun = null;
      }
    });
  }

  return {
    start() {
      stopped = false;
      void triggerScan("poll");
      timer = setInterval(() => void triggerScan("poll"), pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;

      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    wake(source) {
      return triggerScan(source);
    },
    runOnce: scan,
  };
}
