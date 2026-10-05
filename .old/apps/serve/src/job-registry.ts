export type JobKind =
  | "issue_conversation"
  | "implementation"
  | "what_confirmation"
  | "how_confirmation"
  | "pr_response";

/** Job起動関数が返す、開始できたJobの共通の形。 */
export interface StartedJob {
  jobId: string;
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): void | Promise<void>;
  /** 実行に時間がかかるJob種別だけが持つ、Web UIからの計画停止。 */
  requestStop?(): void;
}

export interface JobSummary {
  jobId: string;
  kind: JobKind;
  status: string | null;
}

export interface JobRegistry {
  /** 起動できたJobを保持し、終了まで面倒を見る共通処理。 */
  hold(kind: JobKind, job: StartedJob): void;
  /** Workflow/Jobの現在状態を横断的に確認する唯一の一覧経路。 */
  list(): JobSummary[];
  /** 停止時に、まだ動いているJobのprocessと所有権接続を閉じる。 */
  closeAll(): void;
  /**
   * Web UIからの計画停止をJobへ伝える。対象が見つからない、または計画停止を
   * 持たないJob種別では何もせず`false`を返す。
   */
  requestStop(jobId: string): boolean;
}

export function createJobRegistry(): JobRegistry {
  const active = new Set<{ kind: JobKind; job: StartedJob }>();

  return {
    hold(kind, job) {
      const entry = { kind, job };

      active.add(entry);
      // 正常終了でも失敗でも、leaseとheartbeatとprocessを片付ける。
      void job.finished
        .catch(() => undefined)
        .finally(() => {
          void job.close();
          active.delete(entry);
        });
    },
    list() {
      return [...active].map(({ kind, job }) => ({
        jobId: job.jobId,
        kind,
        status: job.jobStatus(),
      }));
    },
    closeAll() {
      for (const { job } of active) {
        void job.close();
      }

      active.clear();
    },
    requestStop(jobId) {
      const entry = [...active].find(({ job }) => job.jobId === jobId);

      if (entry?.job.requestStop === undefined) {
        return false;
      }

      entry.job.requestStop();
      return true;
    },
  };
}

/** Job起動関数の結果が`started`のときだけregistryへ登録し、結果はそのまま返す。 */
export function holdIfStarted<
  T extends { status: string } & Partial<StartedJob>,
>(registry: JobRegistry, kind: JobKind, result: T): T {
  if (result.status === "started") {
    registry.hold(kind, result as T & StartedJob);
  }

  return result;
}
