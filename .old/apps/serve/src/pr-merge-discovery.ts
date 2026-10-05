import type { Database } from "bun:sqlite";

import { reflectDoneState, type LinearDonePorts } from "./linear-done";
import type { PullRequestWatchStore } from "./pull-request-watch";

export interface PrMergePorts extends LinearDonePorts {
  /** 読めない場合はnull。 */
  isPullRequestMerged(prNumber: number): Promise<boolean | null>;
}

export interface PrMergeScanResult {
  checked: number;
  reflected: number;
}

export type PrMergeWakeSource = "github" | "linear" | "poll";

export interface PrMergeDiscoveryLoopOptions {
  /** 短命tokenを都度解決するため、毎scanで呼び直す。取れなければnullでscanを無害に終える。 */
  createPorts: () => Promise<PrMergePorts | null>;
  database: Database;
  watchStore: PullRequestWatchStore;
  pollIntervalMs: number;
  log?: (result: PrMergeScanResult) => void;
}

export interface PrMergeDiscoveryLoop {
  start(): void;
  stop(): void;
  wake(source: PrMergeWakeSource): Promise<void>;
  runOnce(): Promise<PrMergeScanResult>;
}

/**
 * PR作成後、mergeを検出してLinearをDoneへ反映するloop。
 *
 * ADR 0005「Linear状態」のとおり、mergeを現在値から確認した後にDoneへ移す。
 * webhookは起床通知に過ぎず、定期pollingが最終的な正しさを担う。
 */
export function createPrMergeDiscoveryLoop({
  createPorts,
  database,
  watchStore,
  pollIntervalMs,
  log = () => undefined,
}: PrMergeDiscoveryLoopOptions): PrMergeDiscoveryLoop {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let stopped = true;

  async function scan(): Promise<PrMergeScanResult> {
    const result: PrMergeScanResult = { checked: 0, reflected: 0 };
    const ports = await createPorts();

    if (ports === null) {
      return result;
    }

    for (const entry of watchStore.watching()) {
      result.checked += 1;

      const merged = await ports
        .isPullRequestMerged(entry.prNumber)
        .catch(() => null);

      if (merged !== true) {
        continue;
      }

      const status = await reflectDoneState({
        database,
        ports,
        target: { jobId: entry.jobId, linearIssueId: entry.linearIssueId },
      });

      if (status === "done") {
        watchStore.markDone(entry.jobId);
        result.reflected += 1;
      }
    }

    return result;
  }

  async function triggerScan(): Promise<void> {
    if (stopped || running) {
      return;
    }

    running = true;

    try {
      log(await scan());
    } finally {
      running = false;
    }
  }

  return {
    start() {
      stopped = false;
      void triggerScan();
      timer = setInterval(() => void triggerScan(), pollIntervalMs);
      timer.unref?.();
    },
    stop() {
      stopped = true;

      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    wake() {
      return triggerScan();
    },
    runOnce: scan,
  };
}
