import type {
  ImplementationResult,
  ImplementationStartEvent,
} from "@mikan-919/oriel-contracts";

import {
  openCanonicalWorktree,
  pushCheckpoint,
  type CanonicalWorktree,
} from "./canonical-worktree";
import {
  createCheckpointOutbox,
  createCheckpointService,
  type BranchOwnershipVerifier,
  type CheckpointBinding,
} from "./checkpoint-push";
import type { GitCredential } from "./git";
import { onAbort } from "./abort-signal";
import type { ReconcileApproval } from "./implementation-admission";
import {
  serveOwnedHarnessImplementationIpc,
  type CheckpointOperations,
} from "./implementation-ipc";
import { createJobStateStore } from "./job-state";
import { openServeLocalState } from "./local-state";
import {
  createModelStreamService,
  type ModelStreamProvider,
} from "./model-stream";
import { integrateTargetBase } from "./target-base-integration";
import { createTranscriptStore } from "./transcript-store";

export interface StartImplementationWorkerOptions {
  databasePath: string;
  /** `serve`が持つrepositoryのcloneと、worktreeを置く領域。 */
  repositoryRoot: string;
  worktreesRoot: string;
  remote: string;
  harnessEntry: URL | string;
  ownership: BranchOwnershipVerifier & { readonly stopSignal?: AbortSignal };
  binding: CheckpointBinding;
  /** worktreeを開いた後にharnessへ渡すstart event。 */
  start: Omit<ImplementationStartEvent, "worktreePath" | "worktreeOid">;
  /** 引き継ぎで統合する取り込み先Git参照と、承認で確認したその現在OID。 */
  targetBase: { ref: string; oid: string };
  /** 提供元への接続とcredentialの解決。harnessへは渡さない。 */
  modelProvider: ModelStreamProvider;
  reconcileApproval: ReconcileApproval;
  resolveCredential: () => Promise<GitCredential | null>;
  /**
   * 実行中に承認の変更を確定した場合の、Todo→Triage差し戻し。
   *
   * ADR 0003のとおり、実行できるのは現在のJob所有権を確認した`serve`だけであり、
   * この関数はworkerが所有権を保ったまま呼ぶ。
   */
  onApprovalChanged: () => Promise<unknown>;
  release: () => void;
}

export interface ImplementationWorker {
  status: "started";
  worktreePath: string;
  /** worktreeの現在の先端。統合した場合は遠隔のcanonical先端より進む。 */
  worktreeOid: string;
  finished: Promise<void>;
  jobStatus(): string | null;
  close(): Promise<void>;
  /**
   * Web UIからの計画停止。harnessへ停止要求を送り、現在のturnを安全に区切って
   * checkpointをpushさせてから終了させる。接続所有権喪失時の即時abortとは別。
   */
  requestStop(): void;
}

export type ImplementationWorkerRefusalReason =
  | "canonical_worktree_unavailable"
  | "target_base_not_integrated"
  | "approval_changed"
  /** 承認対象を読めず、変わったかどうかを決められない。差し戻しもしない。 */
  | "approval_state_unknown"
  | "ownership_not_current";

export type StartImplementationWorkerResult =
  | ImplementationWorker
  | { status: "refused"; reason: ImplementationWorkerRefusalReason };

/**
 * 実装Jobのworker。
 *
 * 封印済みcanonicalブランチのworktreeを開き、引き継ぎでは最新の取り込み先を統合
 * してから承認と所有権を確認し直す。そのうえで、credentialを持たないharness
 * processへその一つのworktreeと承認済みWHAT/HOWだけを渡す。modelへの要求も遠隔
 * Gitへの送信も`serve`の用途限定操作としてだけ通し、所有権を失えばworkerを止める。
 */
export async function startImplementationWorker({
  databasePath,
  repositoryRoot,
  worktreesRoot,
  remote,
  harnessEntry,
  ownership,
  binding,
  start,
  targetBase,
  modelProvider,
  reconcileApproval,
  resolveCredential,
  onApprovalChanged,
  release,
}: StartImplementationWorkerOptions): Promise<StartImplementationWorkerResult> {
  const credential = await resolveCredential();
  const worktree: CanonicalWorktree | null = await openCanonicalWorktree({
    repositoryRoot,
    worktreesRoot,
    jobId: binding.jobId,
    canonicalBranch: start.canonicalBranch,
    canonicalOid: start.canonicalOid,
    remote,
    credential,
  });

  if (worktree === null) {
    return { status: "refused", reason: "canonical_worktree_unavailable" };
  }

  const refuse = async (
    reason: ImplementationWorkerRefusalReason,
  ): Promise<StartImplementationWorkerResult> => {
    // 統合や再確認に失敗したsandboxは、復元可能でcleanなときだけ消える。
    await worktree.remove([start.canonicalOid]);

    return { status: "refused", reason };
  };

  let worktreeOid = start.canonicalOid;

  if (start.adopted) {
    // ADR 0004: 取り込み先の前進は承認を失効させない。統合して再検証する。
    const integrated = await integrateTargetBase({
      worktreePath: worktree.path,
      remote,
      targetBaseRef: targetBase.ref,
      targetBaseOid: targetBase.oid,
      credential,
    });

    if (integrated.status !== "integrated") {
      return refuse("target_base_not_integrated");
    }

    worktreeOid = integrated.headOid;

    // 統合の後にも、承認対象と現在の取得IDをもう一度確かめる。
    const approval = await reconcileApproval().catch(
      () => ({ status: "unknown" }) as const,
    );

    // 読めなかっただけの提供元障害を、承認の変更として差し戻さない。
    if (approval.status === "unknown") {
      return refuse("approval_state_unknown");
    }

    if (
      approval.status === "changed" ||
      approval.approvalFingerprint !== binding.approvalFingerprint
    ) {
      return refuse("approval_changed");
    }

    const current =
      (await ownership.hasCurrentJobOwnership({
        jobId: binding.jobId,
        jobLeaseId: binding.jobLeaseId,
        repository: binding.repository,
        issueNumber: binding.issueNumber,
      })) &&
      (await ownership.hasCurrentBranchExclusivity(
        binding.branchKey,
        binding.branchLeaseId,
      ));

    if (!current) {
      return refuse("ownership_not_current");
    }
  }

  const database = openServeLocalState(databasePath);
  const jobState = createJobStateStore(database);
  const transcripts = createTranscriptStore(database);

  transcripts.append({
    jobId: binding.jobId,
    repository: binding.repository,
    kind: "job.start",
    content: JSON.stringify({ type: "implementation", adopted: start.adopted }),
  });

  const checkpoints = createCheckpointService({
    outbox: createCheckpointOutbox(database),
    binding,
    ownership,
    reconcileApproval,
    resolveCredential,
    push: (input) =>
      pushCheckpoint({ ...input, worktreePath: worktree.path, remote }),
  });
  const models = createModelStreamService({
    binding: {
      jobId: binding.jobId,
      jobLeaseId: binding.jobLeaseId,
      model: start.model,
      repository: binding.repository,
      issueNumber: binding.issueNumber,
    },
    ownership,
    provider: modelProvider,
    transcript: transcripts,
  });

  // harnessへはcredentialを渡さない。承認済みの対象だけをstdinのstart eventで渡す。
  const harness = Bun.spawn(
    [
      process.execPath,
      typeof harnessEntry === "string" ? harnessEntry : harnessEntry.pathname,
      "--mode",
      "implementation",
    ],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      /**
       * harnessが必要とするのはcommandを見つけるPATHだけとする。credentialも、
       * 利用者のglobal Git設定やcredential helperも継承させない。
       */
      env: {
        PATH: Bun.env.PATH ?? "",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
      },
    },
  );
  const stopHarness = () => harness.kill();
  const userStop = new AbortController();
  let running = !(ownership.stopSignal?.aborted ?? false);
  /** 遠隔から復元できると確認済みの先端。sandboxの削除条件に使う。 */
  const restorable = [start.canonicalOid];
  let checkpointRefused = false;
  let checkpointCompleted = false;
  /** harnessが明示した実装結果。受け取れなければ実装完了とみなさない。 */
  let reported: ImplementationResult | null = null;

  const interrupt = () => {
    if (running) {
      running = false;
      jobState.set(binding.jobId, "interrupted");
    }
  };

  jobState.set(binding.jobId, running ? "running" : "interrupted");
  onAbort(ownership.stopSignal, stopHarness);
  onAbort(ownership.stopSignal, interrupt);

  /**
   * checkpointの結果を観測する。
   *
   * 拒否、送信失敗、所有権喪失ではJobを完了にせず、workerを止めて未検証の
   * 作業途中成果をworktreeへ残す。
   */
  const observed: CheckpointOperations = {
    async accept(request) {
      const event = await checkpoints.accept(request);

      if (event.type === "checkpoint.rejected") {
        checkpointRefused = true;
        interrupt();
        stopHarness();
      }

      return event;
    },
    async deliver(operationId) {
      const event = await checkpoints.deliver(operationId);

      if (event.type === "checkpoint.completed") {
        checkpointCompleted = true;
        restorable.push(event.canonicalOid);
      } else {
        checkpointRefused = true;

        /**
         * 送信直前の再調停で承認の変更を確定した場合だけ、ADR 0003の差し戻しへ
         * 送る。読めなかっただけの`approval_state_unknown`では何も書かない。
         */
        if (event.reason === "target_mismatch") {
          await onApprovalChanged().catch(() => {});
        }

        interrupt();
        stopHarness();
      }

      return event;
    },
  };

  const serving = serveOwnedHarnessImplementationIpc(
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
    { ...start, worktreePath: worktree.path, worktreeOid },
    {
      checkpoint: observed,
      model: models,
      result: {
        report(result) {
          reported = result;
          transcripts.append({
            jobId: binding.jobId,
            repository: binding.repository,
            kind: "job.result",
            content: JSON.stringify(result),
          });
        },
      },
    },
    ownership.stopSignal,
    userStop.signal,
  );

  let lastJobStatus: string | null = null;
  let closed = false;

  return {
    status: "started",
    worktreePath: worktree.path,
    worktreeOid,
    requestStop: () => userStop.abort(),
    finished: serving.then(async () => {
      const exitCode = await harness.exited;

      if (!running) {
        return;
      }

      running = false;
      /**
       * 実装が完了したと言えるのは、Agentがworktree内のsourceを実際に編集し、
       * 取り込み先の設定由来の検証を通し、そのcheckpointを遠隔へ送れた場合だけ
       * とする。Agentがerrorやabortedで止まった、何も編集しなかった、または
       * 結果を受け取れなかった実行は、HANDOFFだけのWIP checkpointが残っていても
       * `interrupted`にする。
       */
      jobState.set(
        binding.jobId,
        exitCode === 0 &&
          !checkpointRefused &&
          checkpointCompleted &&
          implemented(reported)
          ? "completed"
          : "interrupted",
      );
    }),
    jobStatus: () => (closed ? lastJobStatus : jobState.get(binding.jobId)),
    async close() {
      if (closed) {
        return;
      }

      lastJobStatus = jobState.get(binding.jobId);
      closed = true;
      ownership.stopSignal?.removeEventListener("abort", stopHarness);
      harness.kill();
      // heartbeatと取得IDを持ち続けない。
      release();
      database.close();

      // 完了していないJobのsandboxは、cleanに見えても作業途中成果として残す。
      if (lastJobStatus === "completed") {
        await worktree.remove(restorable);
      }
    },
  };
}

/**
 * harnessが明示した結果が、実装完了と言えるか。
 *
 * 停止理由がerrorまたはabortedの未完了turn、tool実行のない実行、sourceを変えて
 * いない実行、検証を通していない実行、結果そのものが届かなかった実行は完了に
 * しない。
 */
function implemented(result: ImplementationResult | null): boolean {
  return (
    result !== null &&
    result.stopReason !== "error" &&
    result.stopReason !== "aborted" &&
    result.stopReason !== "unknown" &&
    result.acted &&
    result.sourceChanged &&
    result.verified
  );
}
