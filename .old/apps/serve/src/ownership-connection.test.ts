import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
} from "@mikan-919/oriel-contracts";
import { expect, test } from "bun:test";

import { startFakeOwnershipRelay } from "./ownership-relay.fake";
import { createRelayOwnershipConnection } from "./ownership-connection";

const deviceToken = "7.11.device-token";
const jobId = "issue-conversation-1";
const binding = {
  jobId,
  repository: { owner: "mikan-919", name: "oriel" },
  issueNumber: 28,
};

function connect(relayOrigin: string, token = deviceToken, stopMs = 1_000) {
  return createRelayOwnershipConnection({
    relayOrigin,
    deviceToken: token,
    jobId,
    heartbeatStopMs: stopMs,
  });
}

/** 閉じる順序だけを観測する所有権接続のfake。 */
function recordingSocket(url: string, closed: string[]): WebSocket {
  const kind = new URL(url).searchParams.get("kind") ?? "";
  const events = new EventTarget();
  let alreadyClosed = false;

  queueMicrotask(() => {
    events.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ownership.acquired",
          leaseId: `${kind}-lease`,
          heartbeatIntervalMs: 10_000,
          heartbeatExpiryMs: 60_000,
        }),
      }),
    );
  });

  return {
    addEventListener: (type: string, listener: EventListener) => {
      events.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      events.removeEventListener(type, listener);
    },
    send: () => {},
    close: () => {
      if (alreadyClosed) {
        return;
      }

      alreadyClosed = true;
      closed.push(kind);
      queueMicrotask(() => events.dispatchEvent(new Event("close")));
    },
  } as unknown as WebSocket;
}

/** heartbeatへ答えるのはjob socketだけ。答えるたびに`advance`で論理時計が進む。 */
function answeringSocket(url: string, advance: () => void): WebSocket {
  const kind = new URL(url).searchParams.get("kind") ?? "";
  const events = new EventTarget();

  queueMicrotask(() => {
    events.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ownership.acquired",
          leaseId: `${kind}-lease`,
          heartbeatIntervalMs: 10,
          heartbeatExpiryMs: 60_000,
        }),
      }),
    );
  });

  return {
    addEventListener: (type: string, listener: EventListener) => {
      events.addEventListener(type, listener);
    },
    removeEventListener: (type: string, listener: EventListener) => {
      events.removeEventListener(type, listener);
    },
    send: (data: string) => {
      if (data !== ownershipHeartbeatRequest || kind !== "job") {
        return;
      }

      advance();
      events.dispatchEvent(
        new MessageEvent("message", { data: ownershipHeartbeatResponse }),
      );
    },
    close: () => {
      queueMicrotask(() => events.dispatchEvent(new Event("close")));
    },
  } as unknown as WebSocket;
}

test("releasing ownership closes the branch exclusivity before the Job ownership", async () => {
  const closed: string[] = [];
  const connection = createRelayOwnershipConnection({
    relayOrigin: "http://relay.test",
    deviceToken,
    jobId,
    heartbeatStopMs: 1_000,
    openWebSocket: (url) => recordingSocket(url, closed),
  });

  expect(await connection.acquireJobOwnership()).toBe("job-lease");
  expect(await connection.acquireBranchExclusivity("11/oriel-job-1")).toBe(
    "branch-lease",
  );

  connection.release();
  await Bun.sleep(10);

  // ADR 0002: 返却順序はブランチ排他接続、Job所有権接続とする。
  expect(closed).toEqual(["branch", "job"]);
});

test("Job ownership and branch exclusivity are acquired over the relay connection", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);

  try {
    const jobLeaseId = await connection.acquireJobOwnership();

    expect(jobLeaseId).toEqual(expect.any(String));
    expect(relay.authorizationHeaders()).toEqual([`Bearer ${deviceToken}`]);

    const branchLeaseId =
      await connection.acquireBranchExclusivity("11/oriel-job-1");

    expect(branchLeaseId).toEqual(expect.any(String));
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: jobLeaseId ?? "",
      }),
    ).toBe(true);
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: "not-current",
      }),
    ).toBe(false);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("the connection reads the live ownership of the repository and its own branch lease", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);
  const other = createRelayOwnershipConnection({
    relayOrigin: relay.origin,
    deviceToken,
    jobId: "implementation:11:28:other-fingerprint",
    heartbeatStopMs: 1_000,
  });

  try {
    const jobLeaseId = await connection.acquireJobOwnership();
    const branchLeaseId =
      await connection.acquireBranchExclusivity("11/oriel-job-1");

    await other.acquireJobOwnership();

    // 置換隔離の判断材料は、同じrepositoryで現在生きているキーだけとする。
    expect(await connection.inspectOwnership()).toEqual({
      jobKeys: [jobId, "implementation:11:28:other-fingerprint"],
      branchKeys: ["11/oriel-job-1"],
    });
    expect(
      await connection.hasCurrentBranchExclusivity(
        "11/oriel-job-1",
        branchLeaseId ?? "",
      ),
    ).toBe(true);
    expect(
      await connection.hasCurrentBranchExclusivity(
        "11/oriel-job-1",
        "not-current",
      ),
    ).toBe(false);
    expect(jobLeaseId).toEqual(expect.any(String));
  } finally {
    connection.release();
    other.release();
    relay.stop();
  }
});

test("a released connection reads no ownership at all", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);

  try {
    await connection.acquireJobOwnership();
    await connection.acquireBranchExclusivity("11/oriel-job-1");
    connection.release();

    expect(await connection.inspectOwnership()).toBeNull();
    expect(
      await connection.hasCurrentBranchExclusivity("11/oriel-job-1", "lease"),
    ).toBe(false);
  } finally {
    relay.stop();
  }
});

test("a second connection cannot take the same Job, and a branch needs a current Job lease", async () => {
  const relay = startFakeOwnershipRelay();
  const first = connect(relay.origin);
  const second = connect(relay.origin);
  const detached = connect(relay.origin);

  try {
    expect(await first.acquireJobOwnership()).toEqual(expect.any(String));
    expect(await second.acquireJobOwnership()).toBeNull();
    expect(
      await detached.acquireBranchExclusivity("11/oriel-job-1"),
    ).toBeNull();
  } finally {
    first.release();
    second.release();
    detached.release();
    relay.stop();
  }
});

test("a revoked device loses both connections and stops the worker", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin);

  try {
    const jobLeaseId = await connection.acquireJobOwnership();

    await connection.acquireBranchExclusivity("11/oriel-job-1");

    expect(connection.stopSignal.aborted).toBe(false);

    relay.revokeDevice();

    await Bun.sleep(50);

    expect(connection.stopSignal.aborted).toBe(true);
    expect(relay.openConnections()).toBe(0);
    expect(
      await connection.hasCurrentJobOwnership({
        ...binding,
        jobLeaseId: jobLeaseId ?? "",
      }),
    ).toBe(false);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("an unauthenticated device gets no ownership", async () => {
  const relay = startFakeOwnershipRelay();
  const connection = connect(relay.origin, "7.11.forged");

  try {
    expect(await connection.acquireJobOwnership()).toBeNull();
  } finally {
    connection.release();
    relay.stop();
  }
});

test("the connection heartbeats and stops when the relay stops answering", async () => {
  const relay = startFakeOwnershipRelay("7.11.device-token", {
    heartbeatIntervalMs: 10,
    heartbeatExpiryMs: 60_000,
  });
  // 停止期限は実時間のjitterへ埋もれない幅を取る。狭すぎると負荷で偽の停止が出る。
  const connection = connect(relay.origin, deviceToken, 200);

  try {
    expect(await connection.acquireJobOwnership()).toEqual(expect.any(String));

    await Bun.sleep(60);

    expect(relay.heartbeats()).toBeGreaterThan(0);
    expect(connection.stopSignal.aborted).toBe(false);

    relay.stopAnsweringHeartbeats();
    await Bun.sleep(400);

    // 応答を停止期限内に受け取れないので、切断通知を待たず止まる。
    expect(connection.stopSignal.aborted).toBe(true);
  } finally {
    connection.release();
    relay.stop();
  }
});

test("a silent branch socket stops the connection even while the Job socket keeps answering", async () => {
  let clock = 1_000;
  // job socketだけが答え、答えた瞬間に論理時計が進む。最終応答時刻を共有していると
  // 常にその時刻へ更新されるため、socketごとに持つ場合だけbranchが期限を超える。
  const connection = createRelayOwnershipConnection({
    relayOrigin: "http://relay.test",
    deviceToken,
    jobId,
    heartbeatStopMs: 50,
    openWebSocket: (url) => answeringSocket(url, () => (clock += 30)),
    now: () => clock,
  });

  try {
    expect(await connection.acquireJobOwnership()).toBe("job-lease");
    expect(await connection.acquireBranchExclusivity("11/oriel-job-1")).toBe(
      "branch-lease",
    );
    expect(connection.stopSignal.aborted).toBe(false);

    await Bun.sleep(100);

    expect(connection.stopSignal.aborted).toBe(true);
  } finally {
    connection.release();
  }
});

test("a client stop deadline that is not shorter than the relay expiry takes no ownership", async () => {
  const relay = startFakeOwnershipRelay("7.11.device-token", {
    heartbeatIntervalMs: 10,
    heartbeatExpiryMs: 1_000,
  });
  const connection = connect(relay.origin, deviceToken, 1_000);

  try {
    expect(await connection.acquireJobOwnership()).toBeNull();
    expect(connection.stopSignal.aborted).toBe(true);
  } finally {
    connection.release();
    relay.stop();
  }
});
