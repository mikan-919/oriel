import {
  parseNotificationServerMessage,
  parseTranscriptRelayMessage,
  type TranscriptEntry,
  type TranscriptSearchRequest,
} from "@mikan-919/oriel-contracts";

export interface NotificationConnectionOptions {
  relayOrigin: URL | string;
  /** device bearer tokenをその都度解決する。取れない間は再接続を待つだけにする。 */
  resolveDeviceToken: () => Promise<string | null>;
  onWake: (source: "github" | "linear") => void;
  /**
   * repository scopeの検索でrelayが中継してきた要求に、この`serve`の局所
   * transcriptだけで答える。同じrepositoryの他の`serve`へはさらに中継しない。
   */
  onTranscriptSearchRequest: (
    request: TranscriptSearchRequest,
  ) => Promise<TranscriptEntry[]> | TranscriptEntry[];
  openWebSocket?: (url: string, deviceToken: string) => WebSocket;
  reconnectDelayMs?: number;
  // ponytail: relay側の生存確認とは別の、切断を越えて答えを待たない安全弁。
  // 固定版runtimeでの実測が無いための暫定値。
  searchTimeoutMs?: number;
}

export interface NotificationConnection {
  stop(): void;
  /**
   * repository scopeのtranscript検索。接続が無い、または答えが返らない間は
   * 空配列に解決し、呼び出し元の局所検索だけを結果として使わせる。
   */
  searchRepository(
    request: Omit<TranscriptSearchRequest, "type" | "scope" | "requestId">,
  ): Promise<TranscriptEntry[]>;
}

function defaultOpenWebSocket(url: string, deviceToken: string): WebSocket {
  return new WebSocket(url, {
    headers: { authorization: `Bearer ${deviceToken}` },
  } as unknown as string[]);
}

/**
 * relayのwebhook起床通知だけを購読する接続。
 *
 * [ADR 0001](../../../docs/adr/0001-distributed-workflow-and-worker-model.md)の
 * とおりwebhookは起床通知に過ぎず、正本ではない。この接続はJob所有権接続
 * (`ownership-connection.ts`)と異なりlease、取得ID、heartbeatを持たない。
 * 欠落・遅延しても定期ポーリングが必ず後追いするため、切断時は固定の短い
 * 遅延で再接続するだけでよい。
 */
export function createNotificationConnection({
  relayOrigin,
  resolveDeviceToken,
  onWake,
  onTranscriptSearchRequest,
  openWebSocket = defaultOpenWebSocket,
  // ponytail: 安全性に無関係な再接続待ち。定期pollが後追いするため測定不要。
  reconnectDelayMs = 5_000,
  searchTimeoutMs = 5_000,
}: NotificationConnectionOptions): NotificationConnection {
  let stopped = false;
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingSearches = new Map<
    string,
    {
      resolve: (entries: TranscriptEntry[]) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  async function connect() {
    if (stopped) {
      return;
    }

    const deviceToken = await resolveDeviceToken();

    if (deviceToken === null || stopped) {
      scheduleReconnect();
      return;
    }

    const url = new URL("/notifications", relayOrigin);

    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    const ws = openWebSocket(url.toString(), deviceToken);

    socket = ws;

    ws.addEventListener("message", (event) => {
      let parsed: unknown;

      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }

      try {
        const message = parseNotificationServerMessage(parsed);

        if (message.type === "notification.wake") {
          onWake(message.source);
        }

        return;
      } catch {
        // notification.wakeでなければtranscript検索としてもう一度読む。
      }

      let transcript;

      try {
        transcript = parseTranscriptRelayMessage(parsed);
      } catch {
        return;
      }

      if (transcript.type === "transcript.search.result") {
        const pending = pendingSearches.get(transcript.requestId);

        if (pending !== undefined) {
          pendingSearches.delete(transcript.requestId);
          clearTimeout(pending.timer);
          pending.resolve(transcript.entries);
        }

        return;
      }

      // relayが同じrepositoryの他の`serve`へ中継してきた要求。局所結果だけで答える。
      Promise.resolve(onTranscriptSearchRequest(transcript))
        .catch(() => [])
        .then((entries) => {
          ws.send(
            JSON.stringify({
              type: "transcript.search.result",
              requestId: transcript.requestId,
              entries,
            }),
          );
        });
    });

    ws.addEventListener("close", () => {
      if (socket === ws) {
        socket = null;
      }

      scheduleReconnect();
    });
  }

  void connect();

  return {
    stop() {
      stopped = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      for (const pending of pendingSearches.values()) {
        clearTimeout(pending.timer);
        pending.resolve([]);
      }

      pendingSearches.clear();
      socket?.close();
      socket = null;
    },
    searchRepository(request) {
      if (socket === null) {
        return Promise.resolve([]);
      }

      const requestId = crypto.randomUUID();
      const ws = socket;

      return new Promise((resolve) => {
        pendingSearches.set(requestId, {
          resolve,
          timer: setTimeout(() => {
            pendingSearches.delete(requestId);
            resolve([]);
          }, searchTimeoutMs),
        });
        ws.send(
          JSON.stringify({
            type: "transcript.search.request",
            requestId,
            scope: "repository",
            ...request,
          } satisfies TranscriptSearchRequest),
        );
      });
    },
  };
}
