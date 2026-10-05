import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
  parseOwnershipServerMessage,
  type OwnershipClientMessage,
  type OwnershipServerMessage,
} from "@mikan-919/oriel-contracts";

import type { JobOwnershipVerifier } from "./issue-comments";

export interface RelayOwnershipConnectionOptions {
  relayOrigin: URL | string;
  /** device bearer tokenはWebSocket upgradeのAuthorization headerだけへ載せる。 */
  deviceToken: string;
  jobId: string;
  /**
   * client側停止期限。運用値は測定から決めるため既定値を持たず、
   * relayが伝えるserver側失効期限より短い場合だけ所有権を持つ。
   */
  heartbeatStopMs: number;
  openWebSocket?: (url: string, deviceToken: string) => WebSocket;
  now?: () => number;
}

function defaultOpenWebSocket(url: string, deviceToken: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  } as unknown as string[]);
}

/** 同じrepositoryで現在生きている所有権キー。 */
export interface LiveOwnership {
  jobKeys: string[];
  branchKeys: string[];
}

export interface RelayOwnershipConnection extends JobOwnershipVerifier {
  readonly jobLeaseId: string | null;
  readonly branchLeaseId: string | null;
  readonly stopSignal: AbortSignal;
  acquireJobOwnership(): Promise<string | null>;
  acquireBranchExclusivity(branchKey: string): Promise<string | null>;
  /** ブランチまたはプルリクエストを変更する直前の、ブランチ取得IDの確認。 */
  hasCurrentBranchExclusivity(
    branchKey: string,
    branchLeaseId: string,
  ): Promise<boolean>;
  /** Workflow全体の置換隔離のために、現在の所有権キーを読む。 */
  inspectOwnership(): Promise<LiveOwnership | null>;
  release(): void;
}

/**
 * 公開relayの所有権接続。取得IDはrelayだけが発行し、接続が閉じた時点で所有権も消える。
 * 接続を失った、または失効させられた場合は停止合図を出し、`serve`はworkerと
 * 新しい外部操作を止める。
 */
export function createRelayOwnershipConnection({
  relayOrigin,
  deviceToken,
  jobId,
  heartbeatStopMs,
  openWebSocket = defaultOpenWebSocket,
  now = Date.now,
}: RelayOwnershipConnectionOptions): RelayOwnershipConnection {
  const stopped = new AbortController();
  const heartbeats = new Set<ReturnType<typeof setInterval>>();
  /**
   * ADR 0005の停止期限は接続ごとに生きていることを確かめるものなので、
   * socketごとに持つ。共有すると片方の応答がもう片方の無応答を隠す。
   */
  const lastHeartbeatAt = new Map<WebSocket, number>();
  const acquired = new Set<WebSocket>();
  let jobSocket: WebSocket | null = null;
  let branchSocket: WebSocket | null = null;
  let jobLeaseId: string | null = null;
  let branchLeaseId: string | null = null;
  let branchKeyOwned: string | null = null;
  let nextRequestId = 0;
  const pendingRequests = new Map<
    string,
    (message: OwnershipServerMessage | null) => void
  >();

  function stop() {
    jobLeaseId = null;
    branchLeaseId = null;
    branchKeyOwned = null;

    for (const answer of pendingRequests.values()) {
      answer(null);
    }

    pendingRequests.clear();

    if (!stopped.signal.aborted) {
      stopped.abort();
    }

    // ADR 0002: 返却順序はブランチ排他接続、Job所有権接続とする。
    const ordered = [branchSocket, jobSocket].filter(
      (socket): socket is WebSocket => socket !== null,
    );

    for (const socket of ordered) {
      acquired.delete(socket);
    }

    const remaining = [...acquired];

    acquired.clear();
    jobSocket = null;
    branchSocket = null;

    for (const socket of [...ordered, ...remaining]) {
      socket.close();
    }

    for (const heartbeat of heartbeats) {
      clearInterval(heartbeat);
    }

    heartbeats.clear();
    lastHeartbeatAt.clear();
  }

  /**
   * application-level heartbeat。応答を停止期限内に受け取れない場合は、
   * relayの切断通知を待たずworkerと新しい外部操作を止める。
   */
  function startHeartbeat(socket: WebSocket, intervalMs: number) {
    lastHeartbeatAt.set(socket, now());

    const heartbeat = setInterval(() => {
      if (now() - (lastHeartbeatAt.get(socket) ?? 0) > heartbeatStopMs) {
        stop();
        return;
      }

      socket.send(ownershipHeartbeatRequest);
    }, intervalMs);

    heartbeat.unref?.();
    heartbeats.add(heartbeat);
  }

  function open(
    kind: "job" | "branch",
    key: string,
    parentLeaseId?: string,
  ): Promise<{ socket: WebSocket; leaseId: string } | null> {
    if (stopped.signal.aborted) {
      return Promise.resolve(null);
    }

    const url = new URL("/ownership", relayOrigin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("kind", kind);
    url.searchParams.set("key", key);

    if (parentLeaseId !== undefined) {
      url.searchParams.set("parent_lease_id", parentLeaseId);
    }

    const socket = openWebSocket(url.toString(), deviceToken);

    return new Promise((resolve) => {
      let settled = false;
      const settle = (value: { socket: WebSocket; leaseId: string } | null) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      socket.addEventListener("message", (event) => {
        let message;

        if (String(event.data) === ownershipHeartbeatResponse) {
          lastHeartbeatAt.set(socket, now());
          return;
        }

        try {
          message = parseOwnershipServerMessage(
            JSON.parse(String(event.data)) as unknown,
          );
        } catch {
          return;
        }

        if (message.type === "ownership.acquired") {
          // client側停止期限がserver側失効期限以上なら、所有権を持たない。
          if (heartbeatStopMs >= message.heartbeatExpiryMs) {
            settle(null);
            stop();
            return;
          }

          acquired.add(socket);

          if (kind === "job") {
            jobSocket = socket;
          } else {
            branchSocket = socket;
          }

          startHeartbeat(socket, message.heartbeatIntervalMs);
          settle({ socket, leaseId: message.leaseId });
          return;
        }

        if (
          message.type === "ownership.confirmed" ||
          message.type === "ownership.state"
        ) {
          pendingRequests.get(message.requestId)?.(message);
          pendingRequests.delete(message.requestId);
          return;
        }

        // 失効通知と拒否では所有権を持たない。
        settle(null);

        if (
          message.type === "ownership.revoked" ||
          message.type === "ownership.expired"
        ) {
          stop();
        }
      });

      // 切断も確認不能も同じ扱いとして停止する。
      socket.addEventListener("close", () => {
        settle(null);

        if (acquired.has(socket)) {
          stop();
        }
      });
      socket.addEventListener("error", () => {
        settle(null);
      });
    });
  }

  /**
   * 同じ所有権接続で現在値を問い合わせる。期限内に答えが来なければ、切断通知を
   * 待たず停止する。
   */
  function ask(
    socket: WebSocket,
    message: (requestId: string) => OwnershipClientMessage,
  ): Promise<OwnershipServerMessage | null> {
    const requestId = `ownership-${(nextRequestId += 1)}`;
    const answered = new Promise<OwnershipServerMessage | null>((resolve) => {
      pendingRequests.set(requestId, resolve);
      setTimeout(() => {
        if (pendingRequests.delete(requestId)) {
          stop();
          resolve(null);
        }
      }, heartbeatStopMs).unref?.();
    });

    socket.send(JSON.stringify(message(requestId)));

    return answered;
  }

  return {
    get jobLeaseId() {
      return jobLeaseId;
    },
    get branchLeaseId() {
      return branchLeaseId;
    },
    stopSignal: stopped.signal,
    async acquireJobOwnership() {
      jobLeaseId = (await open("job", jobId))?.leaseId ?? null;

      return jobLeaseId;
    },
    async acquireBranchExclusivity(branchKey) {
      if (jobLeaseId === null) {
        return null;
      }

      branchLeaseId =
        (await open("branch", branchKey, jobLeaseId))?.leaseId ?? null;
      branchKeyOwned = branchLeaseId === null ? null : branchKey;

      return branchLeaseId;
    },
    /** 外部操作の直前に、同じ所有権接続で現在の取得IDを確認する。 */
    async hasCurrentJobOwnership(request) {
      const socket = jobSocket;

      if (
        stopped.signal.aborted ||
        socket === null ||
        jobLeaseId === null ||
        request.jobId !== jobId ||
        request.jobLeaseId !== jobLeaseId
      ) {
        return false;
      }

      const leaseId = jobLeaseId;
      const answer = await ask(socket, (requestId) => ({
        type: "ownership.confirm",
        requestId,
        leaseId,
      }));

      return answer?.type === "ownership.confirmed" && answer.current;
    },
    async hasCurrentBranchExclusivity(branchKey, requestedBranchLeaseId) {
      const socket = branchSocket;

      if (
        stopped.signal.aborted ||
        socket === null ||
        branchLeaseId === null ||
        branchKeyOwned !== branchKey ||
        requestedBranchLeaseId !== branchLeaseId
      ) {
        return false;
      }

      const leaseId = branchLeaseId;
      const answer = await ask(socket, (requestId) => ({
        type: "ownership.confirm",
        requestId,
        leaseId,
      }));

      return answer?.type === "ownership.confirmed" && answer.current;
    },
    async inspectOwnership() {
      const socket = jobSocket;

      if (stopped.signal.aborted || socket === null || jobLeaseId === null) {
        return null;
      }

      const leaseId = jobLeaseId;
      const answer = await ask(socket, (requestId) => ({
        type: "ownership.inspect",
        requestId,
        leaseId,
      }));

      return answer?.type === "ownership.state" && answer.current
        ? { jobKeys: answer.jobKeys, branchKeys: answer.branchKeys }
        : null;
    },
    release() {
      stop();
    },
  };
}
