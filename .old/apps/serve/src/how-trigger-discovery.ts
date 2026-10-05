/**
 * webhook通知と定期ポーリングからHOW確定Jobのmention/commandトリガーを発見する
 * オーケストレーション層。
 *
 * what-trigger-discovery.tsと同じ設計とする。`issue_comment`・Linear webhookは
 * 起床通知に過ぎず、contentを運ばない。起床後に対象Linear issueのcomment一覧を
 * `serve`自身が読み直してtriggerを判定する。「既に応答済みか」は、harnessの
 * 応答自体がLinear上へ残す事実(actor自身の最新comment)から判定する。
 *
 * 対象はGitHub Issueに対応するLinear issueが一つだけあり、かつTriage状態の
 * ものに限る。WHAT確定(#33)がTriageのLinear issueを作った後、人間がTriageから
 * Todoへ移すまでの間だけがHOW対話の対象期間であり、Agentはその遷移を起こせない。
 */
import {
  confirmCommandPattern,
  mentionPattern,
} from "@mikan-919/oriel-identity";

export interface HowTriggerLinearComment {
  id: string;
  body: string;
  authorId: string | null;
  createdAt: string;
}

export interface HowTriggerPorts {
  listOpenIssues(): Promise<{ number: number; url: string }[] | null>;
  findLinearIssuesByGitHubIssueUrl(
    url: string,
  ): Promise<{ issueId: string }[] | null>;
  readLinearIssue(linearIssueId: string): Promise<{
    title: string;
    description: string | null;
    stateName: string;
  } | null>;
  listLinearComments(
    linearIssueId: string,
  ): Promise<HowTriggerLinearComment[] | null>;
  getLinearViewerId(): Promise<string | null>;
}

export interface HowTrigger {
  commentId: string;
  /** 確定を求める明示的な指示か、単なるmentionか。 */
  command: boolean;
}

/**
 * 最新commentがtriggerかどうかを判定する。actor(harness)自身の最新commentが
 * 既にある場合は、そのtriggerに応答済みとみなして何も返さない。LinearのIDは
 * 生成順を保証しないため、`createdAt`で最新を判定する。
 */
export function detectHowTrigger(
  comments: HowTriggerLinearComment[],
  viewerId: string,
): HowTrigger | null {
  const latest = [...comments]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .at(-1);

  if (latest === undefined || latest.authorId === viewerId) {
    return null;
  }

  const command = confirmCommandPattern.test(latest.body);

  if (command || mentionPattern.test(latest.body)) {
    return { commentId: latest.id, command };
  }

  return null;
}

export interface HowTriggerScanResult {
  candidatesConsidered: number;
  jobsStarted: number;
}

export type HowTriggerStartResult =
  | {
      status: "started";
      finished: Promise<void>;
      close: () => void | Promise<void>;
    }
  | { status: "refused"; reason?: string };

export type HowTriggerWakeSource = "github" | "linear" | "poll";

export type HowTriggerLogEvent =
  | { type: "scan_started"; source: HowTriggerWakeSource }
  | { type: "scan_completed"; result: HowTriggerScanResult }
  | { type: "job_start_refused"; issueNumber: number; reason?: string };

export interface HowTriggerLoopOptions {
  createPorts: () => Promise<HowTriggerPorts | null>;
  startHowConfirmationJob: (input: {
    issueNumber: number;
    linearIssueId: string;
    trigger: HowTrigger;
  }) => Promise<HowTriggerStartResult>;
  pollIntervalMs: number;
  log?: (event: HowTriggerLogEvent) => void;
}

export interface HowTriggerLoop {
  start(): void;
  stop(): void;
  wake(source: HowTriggerWakeSource): Promise<void>;
  runOnce(): Promise<HowTriggerScanResult>;
}

export function createHowTriggerLoop({
  createPorts,
  startHowConfirmationJob,
  pollIntervalMs,
  log = () => undefined,
}: HowTriggerLoopOptions): HowTriggerLoop {
  const inFlight = new Set<number>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let pendingRescan = false;
  let stopped = true;
  let currentRun: Promise<void> | null = null;

  async function scan(): Promise<HowTriggerScanResult> {
    const result: HowTriggerScanResult = {
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

    const viewerId = await ports.getLinearViewerId();

    if (viewerId === null) {
      return result;
    }

    for (const issue of issues) {
      const linked = await ports.findLinearIssuesByGitHubIssueUrl(issue.url);

      // 対応するLinear issueが一意でなければ、選ばず対象外にする。
      if (linked === null || linked.length !== 1) {
        continue;
      }

      const linearIssueId = linked[0]!.issueId;
      const linearIssue = await ports.readLinearIssue(linearIssueId);

      // Triageの間だけがHOW対話の対象期間。
      if (linearIssue === null || linearIssue.stateName !== "Triage") {
        continue;
      }

      const comments = await ports.listLinearComments(linearIssueId);

      if (comments === null) {
        continue;
      }

      const trigger = detectHowTrigger(comments, viewerId);

      if (trigger === null) {
        continue;
      }

      result.candidatesConsidered += 1;

      if (inFlight.has(issue.number)) {
        continue;
      }

      inFlight.add(issue.number);

      const started = await startHowConfirmationJob({
        issueNumber: issue.number,
        linearIssueId,
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

  function triggerScan(source: HowTriggerWakeSource): Promise<void> {
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
