import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { CheckpointRequest } from "@mikan-919/oriel-contracts";

import type { CheckpointPushResult } from "./canonical-worktree";
import {
  createCheckpointOutbox,
  createCheckpointService,
  type CheckpointBinding,
} from "./checkpoint-push";
import type { ApprovalReconciliation } from "./implementation-admission";
import { openServeLocalState } from "./local-state";

const digest = "a".repeat(64);
const sealedOid = "1".repeat(40);
const headOid = "2".repeat(40);

const binding: CheckpointBinding = {
  jobId: `implementation:11:28:${digest}`,
  jobLeaseId: "job-lease-1",
  branchLeaseId: "branch-lease-1",
  branchKey: `11/oriel/ENG-12-gh-28-${digest}`,
  approvalFingerprint: digest,
  canonicalBranch: `oriel/ENG-12-gh-28-${digest}`,
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

function request(
  overrides: Partial<CheckpointRequest> = {},
): CheckpointRequest {
  return {
    type: "checkpoint.request",
    requestId: "checkpoint-1",
    jobId: binding.jobId,
    jobLeaseId: binding.jobLeaseId,
    branchLeaseId: binding.branchLeaseId,
    approvalFingerprint: binding.approvalFingerprint,
    canonicalBranch: binding.canonicalBranch,
    expectedOid: sealedOid,
    headOid,
    verified: true,
    ...overrides,
  };
}

interface ServiceOptions {
  jobOwned?: boolean;
  branchOwned?: boolean;
  approval?: ApprovalReconciliation;
  push?: CheckpointPushResult;
  credential?: { username: string; token: string } | null;
}

async function withService<T>(
  options: ServiceOptions,
  run: (context: {
    service: ReturnType<typeof createCheckpointService>;
    pushes: unknown[];
    close(): void;
  }) => Promise<T>,
) {
  const directory = await mkdtemp(join(tmpdir(), "oriel-checkpoint-"));
  const database = openServeLocalState(join(directory, "state.sqlite"));
  const pushes: unknown[] = [];

  try {
    const service = createCheckpointService({
      outbox: createCheckpointOutbox(database),
      binding,
      ownership: {
        hasCurrentJobOwnership: () => options.jobOwned ?? true,
        hasCurrentBranchExclusivity: () => options.branchOwned ?? true,
      },
      reconcileApproval: async () =>
        options.approval ?? { status: "current", approvalFingerprint: digest },
      resolveCredential: async () =>
        options.credential === undefined
          ? { username: "x-access-token", token: "installation" }
          : options.credential,
      push: async (input) => {
        pushes.push(input);
        return options.push ?? { status: "pushed", canonicalOid: headOid };
      },
    });

    return await run({ service, pushes, close: () => database.close() });
  } finally {
    database.close();
    await rm(directory, { force: true, recursive: true });
  }
}

test("an owned checkpoint is persisted before the push and completed after it", async () => {
  await withService({}, async ({ service, pushes }) => {
    const accepted = await service.accept(request());

    // 操作IDを先に永続化して即時返し、外部応答まで要求を開いたままにしない。
    expect(accepted).toEqual({
      type: "checkpoint.accepted",
      requestId: "checkpoint-1",
      operationId: expect.any(String),
    });

    if (accepted.type !== "checkpoint.accepted") {
      return;
    }

    expect(await service.deliver(accepted.operationId)).toEqual({
      type: "checkpoint.completed",
      requestId: "checkpoint-1",
      operationId: accepted.operationId,
      canonicalOid: headOid,
    });
    // 送信前OIDを比較条件として渡す。
    expect(pushes).toEqual([
      {
        canonicalBranch: binding.canonicalBranch,
        expectedOid: sealedOid,
        headOid,
        credential: { username: "x-access-token", token: "installation" },
      },
    ]);
  });
});

test("the same request is one logical operation, never a second push", async () => {
  await withService({}, async ({ service, pushes }) => {
    const first = await service.accept(request());
    const second = await service.accept(request());

    expect(first).toEqual(second);

    if (first.type !== "checkpoint.accepted") {
      return;
    }

    await service.deliver(first.operationId);
    await service.deliver(first.operationId);

    // 完了した操作は同じ冪等性キーのまま再送しない。
    expect(pushes).toHaveLength(1);
  });
});

test("a checkpoint without the current acquisition IDs is refused before any push", async () => {
  await withService({ jobOwned: false }, async ({ service, pushes }) => {
    expect(await service.accept(request())).toEqual({
      type: "checkpoint.rejected",
      requestId: "checkpoint-1",
      reason: "ownership_not_current",
    });
    expect(pushes).toEqual([]);
  });

  // ブランチを変更する操作はブランチ取得IDの確認も必要とする。
  await withService({ branchOwned: false }, async ({ service, pushes }) => {
    expect(await service.accept(request())).toMatchObject({
      reason: "ownership_not_current",
    });
    expect(pushes).toEqual([]);
  });
});

test("a checkpoint aimed at another Job, branch or fingerprint is refused", async () => {
  await withService({}, async ({ service, pushes }) => {
    for (const wrong of [
      request({ jobId: "implementation:11:29:other" }),
      request({ canonicalBranch: "oriel/ENG-12-gh-28-other" }),
      request({ approvalFingerprint: "b".repeat(64) }),
      request({ branchLeaseId: "not-current" }),
    ]) {
      expect(await service.accept(wrong)).toMatchObject({
        type: "checkpoint.rejected",
        reason: "target_mismatch",
      });
    }

    expect(pushes).toEqual([]);
  });
});

test("an approval that no longer matches the current value is not written to Git", async () => {
  await withService(
    { approval: { status: "current", approvalFingerprint: "b".repeat(64) } },
    async ({ service, pushes }) => {
      const accepted = await service.accept(request());

      if (accepted.type !== "checkpoint.accepted") {
        throw new Error("the checkpoint was refused before reconciliation");
      }

      // 送信直前の再調停で承認指紋が変わっていれば、書き込まない。
      expect(await service.deliver(accepted.operationId)).toMatchObject({
        type: "checkpoint.rejected",
        reason: "target_mismatch",
      });
      expect(pushes).toEqual([]);
    },
  );

  // 承認そのものが変わったと確定できた場合も書き込まない。
  await withService(
    { approval: { status: "changed" } },
    async ({ service }) => {
      const accepted = await service.accept(request());

      if (accepted.type !== "checkpoint.accepted") {
        throw new Error("the checkpoint was refused before reconciliation");
      }

      expect(await service.deliver(accepted.operationId)).toMatchObject({
        reason: "target_mismatch",
      });
    },
  );
});

test("an approval that cannot be read is refused as unknown, not as a changed target", async () => {
  await withService(
    { approval: { status: "unknown" } },
    async ({ service, pushes }) => {
      const accepted = await service.accept(request());

      if (accepted.type !== "checkpoint.accepted") {
        throw new Error("the checkpoint was refused before reconciliation");
      }

      // 単なる提供元障害を承認の変更と混同せず、書き込みだけを止める。
      expect(await service.deliver(accepted.operationId)).toMatchObject({
        type: "checkpoint.rejected",
        reason: "approval_state_unknown",
      });
      expect(pushes).toEqual([]);
    },
  );
});

test("a third remote OID is returned for reconciliation instead of being forced", async () => {
  await withService(
    { push: { status: "diverged", canonicalOid: "3".repeat(40) } },
    async ({ service }) => {
      const accepted = await service.accept(request());

      if (accepted.type !== "checkpoint.accepted") {
        return;
      }

      expect(await service.deliver(accepted.operationId)).toMatchObject({
        type: "checkpoint.rejected",
        reason: "remote_diverged",
      });
    },
  );
});

test("a checkpoint without a purpose scoped credential never reaches Git", async () => {
  await withService({ credential: null }, async ({ service, pushes }) => {
    const accepted = await service.accept(request());

    if (accepted.type !== "checkpoint.accepted") {
      return;
    }

    expect(await service.deliver(accepted.operationId)).toMatchObject({
      type: "checkpoint.rejected",
      reason: "push_failed",
    });
    expect(pushes).toEqual([]);
  });
});
