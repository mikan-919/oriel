/**
 * webhook通知と定期ポーリングからWHAT確定Jobのmention/commandトリガーを発見する
 * オーケストレーション層。
 *
 * [ADR 0006](../../../docs/adr/0006-webhook-verification-and-wake-notification.md)
 * の改訂のとおり、`issue_comment` webhookも起床通知に過ぎない。ここではcontentを
 * 一切運ばず、起床後に対象issueのcomment一覧を`serve`自身が読み直してtriggerを
 * 判定する。「既に応答済みか」は、harnessの応答自体がGitHub上へ残す事実
 * (actor自身の最新comment)から判定し、別の正本を持たない。
 */
import {
  confirmCommandPattern,
  mentionPattern,
} from "@mikan-919/oriel-identity";

export interface WhatTriggerPorts {
  listOpenIssues(): Promise<{ number: number; url: string }[] | null>;
  listIssueComments(
    issueNumber: number,
  ): Promise<{ id: number; body: string; authorLogin: string }[] | null>;
  getActorLogin(): Promise<string>;
  /** 既にLinearと結び付いているIssueはWHAT確定の対象外とする。 */
  findLinearIssuesByGitHubIssueUrl(
    url: string,
  ): Promise<{ issueId: string }[] | null>;
}

export interface WhatTrigger {
  commentId: number;
  /** 確定を求める明示的な指示か、単なるmentionか。 */
  command: boolean;
}

/**
 * 最新commentがtriggerかどうかを判定する。actor(harness)自身の最新commentが
 * 既にある場合は、そのtriggerに応答済みとみなして何も返さない。
 */
export function detectWhatTrigger(
  comments: { id: number; body: string; authorLogin: string }[],
  actorLogin: string,
): WhatTrigger | null {
  const latest = [...comments].sort((left, right) => left.id - right.id).at(-1);

  if (latest === undefined || latest.authorLogin === actorLogin) {
    return null;
  }

  const command = confirmCommandPattern.test(latest.body);

  if (command || mentionPattern.test(latest.body)) {
    return { commentId: latest.id, command };
  }

  return null;
}

export interface WhatTriggerScanResult {
  candidatesConsidered: number;
  jobsStarted: number;
}

export type WhatTriggerStartResult =
  | {
      status: "started";
      finished: Promise<void>;
      close: () => void | Promise<void>;
    }
  | { status: "refused"; reason?: string };

export type WhatTriggerWakeSource = "github" | "linear" | "poll";

export type WhatTriggerLogEvent =
  | { type: "scan_started"; source: WhatTriggerWakeSource }
  | { type: "scan_completed"; result: WhatTriggerScanResult }
  | { type: "job_start_refused"; issueNumber: number; reason?: string };

export interface WhatTriggerLoopOptions {
  createPorts: () => Promise<WhatTriggerPorts | null>;
  startWhatConfirmationJob: (input: {
    issueNumber: number;
    trigger: WhatTrigger;
  }) => Promise<WhatTriggerStartResult>;
  pollIntervalMs: number;
  log?: (event: WhatTriggerLogEvent) => void;
}

export interface WhatTriggerLoop {
  start(): void;
  stop(): void;
  wake(source: WhatTriggerWakeSource): Promise<void>;
  runOnce(): Promise<WhatTriggerScanResult>;
}

export function createWhatTriggerLoop({
  createPorts,
  startWhatConfirmationJob,
  pollIntervalMs,
  log = () => undefined,
}: WhatTriggerLoopOptions): WhatTriggerLoop {
  const inFlight = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let pendingRescan = false;
  let stopped = true;
  let currentRun: Promise<void> | null = null;

  async function scan(): Promise<WhatTriggerScanResult> {
    const result: WhatTriggerScanResult = {
      candidatesConsidered: 0,
      jobsStarted: 0,
    };
    const ports = await createPorts();

    if (ports === null) {
      return result;
    }

    const issues = await ports.listOpenIssues();

    if (issues === null) {
      return result;
    }

    const actorLogin = await ports.getActorLogin().catch(() => null);

    if (actorLogin === null) {
      return result;
    }

    for (const issue of issues) {
      // 既にLinearと結び付いている(=WHATは既に確定済み)Issueは対象外とする。
      const linked = await ports.findLinearIssuesByGitHubIssueUrl(issue.url);

      if (linked === null || linked.length > 0) {
        continue;
      }

      const comments = await ports.listIssueComments(issue.number);

      if (comments === null) {
        continue;
      }

      const trigger = detectWhatTrigger(comments, actorLogin);

      if (trigger === null) {
        continue;
      }

      result.candidatesConsidered += 1;

      if (inFlight.has(issue.number)) {
        continue;
      }

      inFlight.add(issue.number);

      const started = await startWhatConfirmationJob({
        issueNumber: issue.number,
        trigger,
      });

      if (started.status !== "started") {
        inFlight.delete(issue.number);
        log({
          type: "job_start_refused",
          issueNumber: issue.number,
          reason: started.reason,
        });
        continue;
      }

      result.jobsStarted += 1;
      void started.finished
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(issue.number);
          void started.close();
        });
    }

    return result;
  }

  function triggerScan(source: WhatTriggerWakeSource): Promise<void> {
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
