/**
 * webhook通知と定期ポーリングから実装Job候補を発見するオーケストレーション層。
 *
 * [ADR 0001](../../../docs/adr/0001-distributed-workflow-and-worker-model.md)の
 * とおりwebhookは起床通知に過ぎず、承認そのものではない。ここで行うのは
 * `startImplementationJob`へ渡す`linearIssueId`候補の発見だけであり、承認指紋の
 * 計算、二度読みの一致確認、canonicalブランチの封印は`implementation-job.ts`の
 * `startImplementationJob`がすでに行う。一つのGitHub Issueに対応するLinear
 * issueが複数見つかった場合は、ADR 0001のとおり勝手に選ばず停止する。
 */
export interface DiscoveryPorts {
  /** open状態のGitHub Issue一覧。Pull Requestを除く。読めなければnull。 */
  listOpenIssues(): Promise<{ number: number; url: string }[] | null>;
  /** GitHub Issue URLをLinear attachment APIへ渡し、対応するLinear issueを逆引きする。 */
  findLinearIssuesByGitHubIssueUrl(
    url: string,
  ): Promise<{ issueId: string }[] | null>;
}

export interface DiscoveryScanResult {
  candidatesConsidered: number;
  jobsStarted: number;
  ambiguous: number;
}

export type DiscoveryStartResult =
  | {
      status: "started";
      finished: Promise<void>;
      close: () => void | Promise<void>;
    }
  | { status: "refused"; reason?: string };

export type DiscoveryWakeSource = "github" | "linear" | "poll";

export type DiscoveryLogEvent =
  | { type: "scan_started"; source: DiscoveryWakeSource }
  | { type: "scan_completed"; result: DiscoveryScanResult }
  | { type: "job_start_refused"; linearIssueId: string; reason?: string };

export interface DiscoveryLoopOptions {
  /** 短命tokenを都度解決するため、毎scanで呼び直す。取れなければnullでscanを無害に終える。 */
  createPorts: () => Promise<DiscoveryPorts | null>;
  startImplementationJob: (input: {
    linearIssueId: string;
  }) => Promise<DiscoveryStartResult>;
  /** 運用値は測定と検証専用環境から決めるため既定値を持たない。 */
  pollIntervalMs: number;
  log?: (event: DiscoveryLogEvent) => void;
}

export interface DiscoveryLoop {
  start(): void;
  stop(): void;
  /** webhook起床通知を受けた時に呼ぶ。実行中ならcoalesceして一回だけ追いscanする。 */
  wake(source: DiscoveryWakeSource): Promise<void>;
  /** 同時実行制御を経ない単発のscan。テストや手動実行に使う。 */
  runOnce(): Promise<DiscoveryScanResult>;
}

export function createDiscoveryLoop({
  createPorts,
  startImplementationJob,
  pollIntervalMs,
  log = () => undefined,
}: DiscoveryLoopOptions): DiscoveryLoop {
  // 起動中のlinearIssueIdへの重複呼び出しを避けるためだけの最適化。正しさは
  // startImplementationJob自身のJob所有権機構(already_owned)が最終的に守る。
  const inFlight = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let pendingRescan = false;
  let stopped = true;
  // 実行中のtriggerScan呼び出し(追いscanまで含む)。runningな間にwakeされた
  // 呼び出しは、これを返すことで実際にscanが終わるまで待てるようにする。
  let currentRun: Promise<void> | null = null;

  async function scan(): Promise<DiscoveryScanResult> {
    const result: DiscoveryScanResult = {
      candidatesConsidered: 0,
      jobsStarted: 0,
      ambiguous: 0,
    };
    const ports = await createPorts();

    if (ports === null) {
      return result;
    }

    const issues = await ports.listOpenIssues();

    if (issues === null) {
      return result;
    }

    for (const issue of issues) {
      const matches = await ports.findLinearIssuesByGitHubIssueUrl(issue.url);

      if (matches === null || matches.length === 0) {
        continue;
      }

      result.candidatesConsidered += 1;

      // 複数のLinear issueが対応する場合は選ばず停止する。
      if (matches.length > 1) {
        result.ambiguous += 1;
        continue;
      }

      const linearIssueId = matches[0]!.issueId;

      if (inFlight.has(linearIssueId)) {
        continue;
      }

      inFlight.add(linearIssueId);

      const started = await startImplementationJob({ linearIssueId });

      if (started.status !== "started") {
        inFlight.delete(linearIssueId);
        log({
          type: "job_start_refused",
          linearIssueId,
          reason: started.reason,
        });
        continue;
      }

      result.jobsStarted += 1;
      void started.finished
        .catch(() => undefined)
        .finally(() => {
          inFlight.delete(linearIssueId);
          void started.close();
        });
    }

    return result;
  }

  function triggerScan(source: DiscoveryWakeSource): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }

    if (running) {
      pendingRescan = true;
      // 現在実行中のscan(と、それに続く追いscan)の完了まで待てるようにする。
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
