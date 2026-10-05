import {
  ownershipHeartbeatRequest,
  ownershipHeartbeatResponse,
  parseOwnershipClientMessage,
  parseTranscriptRelayMessage,
  type DeviceRecord,
  type NotificationServerMessage,
  type OwnershipServerMessage,
  type TranscriptEntry,
  type TranscriptSearchRequest,
  type TranscriptSearchResult,
} from "@mikan-919/oriel-contracts";
import { DurableObject } from "cloudflare:workers";

export type RegistrationCodePurpose =
  "installations" | "registration" | "device_list" | "revocation";

export interface IssueCodeInput {
  codeHash: string;
  codeChallenge: string;
  state: string;
  purpose: RegistrationCodePurpose;
  deviceId?: string;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  expiresAt: number;
}

export interface ConsumedCode {
  codeChallenge: string;
  state: string;
  purpose: RegistrationCodePurpose;
  deviceId: string | null;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  expiresAt: number;
}

export interface RegisterDeviceInput {
  deviceId: string;
  deviceTokenHash: string;
  cancellationTokenHash: string;
  cancellationExpiresAt: number;
  installationId: number;
  repositoryId: number;
  repositoryOwner: string;
  repositoryName: string;
  registeredAt: number;
}

/** 休止を越えて残る接続付随情報。 */
interface OwnershipAttachment {
  deviceId: string;
  kind: "job" | "branch";
  key: string;
  leaseId: string;
  parentLeaseId: string | null;
  acceptedAt: number;
  audit: OwnershipAuditConfig;
  valid: boolean;
}

/**
 * webhookの起床通知を購読するだけの軽量な接続付随情報。
 *
 * ADR 0001のとおりwebhookは起床通知に過ぎないため、この接続には取得ID、
 * lease、生存確認を持たせない。欠落・遅延しても定期ポーリングが必ず後追いする。
 */
interface NotificationAttachment {
  deviceId: string;
  channel: "notification";
  transcriptSearchTimeoutMs: number;
}

/**
 * 生存確認の運用値。根拠のある値が決まるまで既定値を持たず、deploy設定から
 * 毎回の接続要求で受け取る。値はストレージへ保存せず、接続付随情報だけに置く。
 */
interface OwnershipAuditConfig {
  heartbeatIntervalMs: number;
  heartbeatExpiryMs: number;
  auditIntervalMs: number;
}

/**
 * 休止を越えて残る接続付随情報の全体。`channel`の有無だけを判別子にする。
 * 所有権接続へ判別子fieldを足すと、deploy前から休止している接続の付随情報が
 * どちらにも一致しなくなるため、既存の形のまま判別する。
 */
type ConnectionAttachment = OwnershipAttachment | NotificationAttachment;

/** 所有権接続の付随情報。通知接続なら`null`。 */
function ownershipAttachmentOf(ws: WebSocket): OwnershipAttachment | null {
  const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;

  return attachment === null || "channel" in attachment ? null : attachment;
}

/** 通知接続の付随情報。所有権接続なら`null`。 */
function notificationAttachmentOf(
  ws: WebSocket,
): NotificationAttachment | null {
  const attachment = ws.deserializeAttachment() as ConnectionAttachment | null;

  return attachment !== null && "channel" in attachment ? attachment : null;
}

interface PendingTranscriptSearch {
  from: WebSocket;
  entries: TranscriptEntry[];
  remaining: number;
  timer: ReturnType<typeof setTimeout>;
}

interface DeviceRow extends Record<string, SqlStorageValue> {
  device_id: string;
  installation_id: number;
  repository_id: number;
  repository_owner: string;
  repository_name: string;
  registered_at: number;
  revoked_at: number | null;
}

function readAuditConfig(request: Request): OwnershipAuditConfig | null {
  const heartbeatIntervalMs = Number(
    request.headers.get("x-ownership-heartbeat-interval-ms"),
  );
  const heartbeatExpiryMs = Number(
    request.headers.get("x-ownership-heartbeat-expiry-ms"),
  );
  const auditIntervalMs = Number(
    request.headers.get("x-ownership-audit-interval-ms"),
  );

  return Number.isInteger(heartbeatIntervalMs) &&
    heartbeatIntervalMs > 0 &&
    Number.isInteger(heartbeatExpiryMs) &&
    heartbeatExpiryMs >= 0 &&
    Number.isInteger(auditIntervalMs) &&
    auditIntervalMs > 0
    ? { heartbeatIntervalMs, heartbeatExpiryMs, auditIntervalMs }
    : null;
}

function ownershipKind(value: string | null): "job" | "branch" | null {
  return value === "job" || value === "branch" ? value : null;
}

function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return {
    deviceId: row.device_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repository: { owner: row.repository_owner, name: row.repository_name },
    registeredAt: row.registered_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * repository単位のデバイス登録簿。tokenのhash、経路制御に要るID、表示metadata、
 * 登録日時と失効日時だけをDurable ObjectのSQLiteへ永続化する。
 *
 * 短命codeはhashで保存し、`DELETE ... RETURNING`の単一文で一度だけ消費する。
 */
export class DeviceRegistryObject extends DurableObject {
  /** query/結果はDurable Objectsストレージへ保存せず、往復の間だけ保持する。 */
  private readonly pendingTranscriptSearches = new Map<
    string,
    PendingTranscriptSearch
  >();

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);

    // heartbeatはHibernationを解かずに自動応答する。
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        ownershipHeartbeatRequest,
        ownershipHeartbeatResponse,
      ),
    );

    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registration_codes (
          code_hash TEXT PRIMARY KEY,
          code_challenge TEXT NOT NULL,
          state TEXT NOT NULL,
          purpose TEXT NOT NULL,
          device_id TEXT,
          installation_id INTEGER NOT NULL,
          repository_id INTEGER NOT NULL,
          repository_owner TEXT NOT NULL,
          repository_name TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS devices (
          device_id TEXT PRIMARY KEY,
          device_token_hash TEXT NOT NULL UNIQUE,
          installation_id INTEGER NOT NULL,
          repository_id INTEGER NOT NULL,
          repository_owner TEXT NOT NULL,
          repository_name TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS installation_choices (
          code_hash TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS device_cancellations (
          device_id TEXT PRIMARY KEY,
          cancellation_token_hash TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS linear_team_routes (
          linear_team_id TEXT NOT NULL,
          installation_id INTEGER NOT NULL,
          repository_id INTEGER NOT NULL,
          registered_at INTEGER NOT NULL,
          PRIMARY KEY (linear_team_id, installation_id, repository_id)
        );
      `);
    });
  }

  issueCode(input: IssueCodeInput): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO registration_codes
       (code_hash, code_challenge, state, purpose, device_id, installation_id,
        repository_id, repository_owner, repository_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.codeHash,
      input.codeChallenge,
      input.state,
      input.purpose,
      input.deviceId ?? null,
      input.installationId,
      input.repositoryId,
      input.repositoryOwner,
      input.repositoryName,
      input.expiresAt,
    );
  }

  /** codeを一度だけ消費する。失敗した交換もcodeを使い切る。 */
  consumeCode(codeHash: string): ConsumedCode | null {
    const [row] = this.ctx.storage.sql
      .exec<{
        code_challenge: string;
        state: string;
        purpose: string;
        device_id: string | null;
        installation_id: number;
        repository_id: number;
        repository_owner: string;
        repository_name: string;
        expires_at: number;
      }>(
        `DELETE FROM registration_codes WHERE code_hash = ? RETURNING *`,
        codeHash,
      )
      .toArray();

    if (row === undefined) {
      return null;
    }

    return {
      codeChallenge: row.code_challenge,
      state: row.state,
      purpose: row.purpose as RegistrationCodePurpose,
      deviceId: row.device_id,
      installationId: row.installation_id,
      repositoryId: row.repository_id,
      repositoryOwner: row.repository_owner,
      repositoryName: row.repository_name,
      expiresAt: row.expires_at,
    };
  }

  registerDevice(input: RegisterDeviceInput): DeviceRecord {
    this.ctx.storage.sql.exec(
      `INSERT INTO devices
       (device_id, device_token_hash, installation_id, repository_id,
        repository_owner, repository_name, registered_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      input.deviceId,
      input.deviceTokenHash,
      input.installationId,
      input.repositoryId,
      input.repositoryOwner,
      input.repositoryName,
      input.registeredAt,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO device_cancellations (device_id, cancellation_token_hash, expires_at)
       VALUES (?, ?, ?)`,
      input.deviceId,
      input.cancellationTokenHash,
      input.cancellationExpiresAt,
    );

    return {
      deviceId: input.deviceId,
      installationId: input.installationId,
      repositoryId: input.repositoryId,
      repository: {
        owner: input.repositoryOwner,
        name: input.repositoryName,
      },
      registeredAt: input.registeredAt,
      revokedAt: null,
    };
  }

  /** 接続認証。失効したdeviceは解決せず、新しい接続を拒否させる。 */
  authenticateDevice(deviceTokenHash: string): DeviceRecord | null {
    const [row] = this.ctx.storage.sql
      .exec<DeviceRow>(
        `SELECT device_id, installation_id, repository_id, repository_owner,
                repository_name, registered_at, revoked_at
         FROM devices WHERE device_token_hash = ? AND revoked_at IS NULL`,
        deviceTokenHash,
      )
      .toArray();

    return row === undefined ? null : toDeviceRecord(row);
  }

  listDevices(): DeviceRecord[] {
    return this.ctx.storage.sql
      .exec<DeviceRow>(
        `SELECT device_id, installation_id, repository_id, repository_owner,
                repository_name, registered_at, revoked_at
         FROM devices ORDER BY registered_at, device_id`,
      )
      .toArray()
      .map(toDeviceRecord);
  }

  revokeDevice(deviceId: string, revokedAt: number): DeviceRecord | null {
    const [row] = this.ctx.storage.sql
      .exec<DeviceRow>(
        `UPDATE devices SET revoked_at = COALESCE(revoked_at, ?)
         WHERE device_id = ?
         RETURNING device_id, installation_id, repository_id, repository_owner,
                   repository_name, registered_at, revoked_at`,
        revokedAt,
        deviceId,
      )
      .toArray();

    if (row === undefined) {
      return null;
    }

    this.ctx.storage.sql.exec(
      `DELETE FROM device_cancellations WHERE device_id = ?`,
      deviceId,
    );
    // 登録簿を失効させた後で、そのdeviceの所有権接続とブランチ排他を閉じる。
    this.closeOwnershipOf(deviceId);
    this.closeNotificationOf(deviceId);

    return toDeviceRecord(row);
  }

  /**
   * 発行直後の登録を取り消す内部限定の経路。取消証明はそのdeviceだけに結び付き、
   * 短命で、一度使うと消える。他のdeviceは取り消せない。
   */
  cancelIssuedDevice(input: {
    deviceId: string;
    cancellationTokenHash: string;
    now: number;
  }): "cancelled" | "unknown_device" | "invalid_cancellation_proof" {
    const [row] = this.ctx.storage.sql
      .exec<{ cancellation_token_hash: string; expires_at: number }>(
        `SELECT cancellation_token_hash, expires_at FROM device_cancellations WHERE device_id = ?`,
        input.deviceId,
      )
      .toArray();

    if (row === undefined) {
      return "unknown_device";
    }

    if (
      row.cancellation_token_hash !== input.cancellationTokenHash ||
      row.expires_at < input.now
    ) {
      return "invalid_cancellation_proof";
    }

    return this.revokeDevice(input.deviceId, input.now) === null
      ? "unknown_device"
      : "cancelled";
  }

  rememberInstallations(
    codeHash: string,
    payload: string,
    expiresAt: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO installation_choices (code_hash, payload, expires_at) VALUES (?, ?, ?)`,
      codeHash,
      payload,
      expiresAt,
    );
  }

  takeInstallations(codeHash: string): string | null {
    const [row] = this.ctx.storage.sql
      .exec<{ payload: string }>(
        `DELETE FROM installation_choices WHERE code_hash = ? RETURNING payload`,
        codeHash,
      )
      .toArray();

    return row?.payload ?? null;
  }

  /**
   * Linear webhookのrouting先を登録する。ADR 0001のとおり、relayが永続化して
   * よいのは「routingに使うLinear workspace IDとteam ID」だけであり、Linear
   * tokenは保持しない。実際に問い合わせるのはinstallationId===0の共有
   * `discovery`インスタンスだけだが、`installation_choices`と同じ前例に倣い
   * class自体は分けない。
   */
  registerLinearRoute(input: {
    linearTeamId: string;
    installationId: number;
    repositoryId: number;
    registeredAt: number;
  }): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO linear_team_routes
       (linear_team_id, installation_id, repository_id, registered_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (linear_team_id, installation_id, repository_id)
       DO UPDATE SET registered_at = excluded.registered_at`,
      input.linearTeamId,
      input.installationId,
      input.repositoryId,
      input.registeredAt,
    );
  }

  linearRoutesFor(
    linearTeamId: string,
  ): { installationId: number; repositoryId: number }[] {
    return this.ctx.storage.sql
      .exec<{ installation_id: number; repository_id: number }>(
        `SELECT installation_id, repository_id FROM linear_team_routes
         WHERE linear_team_id = ?`,
        linearTeamId,
      )
      .toArray()
      .map((row) => ({
        installationId: row.installation_id,
        repositoryId: row.repository_id,
      }));
  }

  /**
   * 所有権接続のupgrade。取得IDと対象キーは接続付随情報だけに置き、
   * Durable Objectsストレージへ所有権recordも履歴も保存しない。
   */
  override fetch(request: Request): Response {
    if (request.headers.get("x-notification-channel") === "1") {
      return this.upgradeNotification(request);
    }

    const url = new URL(request.url);
    const deviceTokenHash = request.headers.get("x-device-token-hash") ?? "";
    // 未知のkindをjobへ丸めない。ブランチ排他の要求が黙ってJob取得になるため。
    const kind = ownershipKind(url.searchParams.get("kind"));
    const key = url.searchParams.get("key") ?? "";
    const parentLeaseId = url.searchParams.get("parent_lease_id");
    const device = this.authenticateDevice(deviceTokenHash);
    const audit = readAuditConfig(request);

    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      kind === null ||
      key === "" ||
      device === null ||
      audit === null
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 新しい取得の前に、期限を過ぎた接続を失効させてから数える。
    this.expireStaleOwnership();

    const outcome = this.admitOwnership({
      deviceId: device.deviceId,
      kind,
      key,
      parentLeaseId,
      audit,
    });
    const pair = new WebSocketPair();

    if (outcome.type === "ownership.acquired") {
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({
        deviceId: device.deviceId,
        kind,
        key,
        leaseId: outcome.leaseId,
        parentLeaseId,
        acceptedAt: Date.now(),
        audit,
        valid: true,
      } satisfies OwnershipAttachment);
      pair[1].send(JSON.stringify(outcome));
      void this.ctx.storage.setAlarm(Date.now() + audit.auditIntervalMs);
    } else {
      pair[1].accept();
      pair[1].send(JSON.stringify(outcome));
      pair[1].close(
        4001,
        outcome.type === "ownership.rejected" ? outcome.reason : "rejected",
      );
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * webhookの起床通知だけを購読する軽量なWebSocket。lease、取得ID、heartbeatは
   * 持たない。所有権接続と混同しないよう、別の接続付随情報の形を使う。
   */
  private upgradeNotification(request: Request): Response {
    const deviceTokenHash = request.headers.get("x-device-token-hash") ?? "";
    const device = this.authenticateDevice(deviceTokenHash);
    const transcriptSearchTimeoutMs = Number(
      request.headers.get("x-transcript-search-timeout-ms"),
    );

    if (
      request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
      device === null ||
      !Number.isInteger(transcriptSearchTimeoutMs) ||
      transcriptSearchTimeoutMs <= 0
    ) {
      return new Response("Unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();

    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment({
      deviceId: device.deviceId,
      channel: "notification",
      transcriptSearchTimeoutMs,
    } satisfies NotificationAttachment);

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 接続中の通知socket全てへ起床の合図を送る。payload内容は運ばない。 */
  broadcastWake(input: { source: "github" | "linear" }): void {
    const message: NotificationServerMessage = {
      type: "notification.wake",
      source: input.source,
    };

    for (const ws of this.activeNotificationSockets()) {
      ws.send(JSON.stringify(message));
    }
  }

  /**
   * transcript検索のrelay。notification channel上を双方向に流れる同じ二つの
   * message型を、要求元からの起点か、fan-out先からの答えかで振り分ける。
   * queryも結果もここでは保存せず、往復の間だけin-memoryに保持する。
   */
  private handleTranscriptRelayMessage(
    ws: WebSocket,
    raw: string,
    timeoutMs: number,
  ): void {
    let message;

    try {
      message = parseTranscriptRelayMessage(JSON.parse(raw));
    } catch {
      return;
    }

    if (message.type === "transcript.search.request") {
      this.fanOutTranscriptSearch(ws, message, timeoutMs);
      return;
    }

    this.collectTranscriptSearchResult(message.requestId, message.entries);
  }

  /** repository scopeの検索だけがここへ届く。要求元自身へは中継しない。 */
  private fanOutTranscriptSearch(
    ws: WebSocket,
    request: TranscriptSearchRequest,
    timeoutMs: number,
  ): void {
    const siblings = this.activeNotificationSockets().filter(
      (socket) => socket !== ws,
    );

    if (siblings.length === 0) {
      ws.send(
        JSON.stringify({
          type: "transcript.search.result",
          requestId: request.requestId,
          entries: [],
        } satisfies TranscriptSearchResult),
      );
      return;
    }

    this.pendingTranscriptSearches.set(request.requestId, {
      from: ws,
      entries: [],
      remaining: siblings.length,
      timer: setTimeout(
        () => this.finishTranscriptSearch(request.requestId),
        timeoutMs,
      ),
    });

    const forSiblings: TranscriptSearchRequest = {
      ...request,
      scope: "local",
    };

    for (const sibling of siblings) {
      sibling.send(JSON.stringify(forSiblings));
    }
  }

  private collectTranscriptSearchResult(
    requestId: string,
    entries: TranscriptEntry[],
  ): void {
    const pending = this.pendingTranscriptSearches.get(requestId);

    if (pending === undefined) {
      return;
    }

    pending.entries.push(...entries);
    pending.remaining -= 1;

    if (pending.remaining <= 0) {
      this.finishTranscriptSearch(requestId);
    }
  }

  private finishTranscriptSearch(requestId: string): void {
    const pending = this.pendingTranscriptSearches.get(requestId);

    if (pending === undefined) {
      return;
    }

    this.pendingTranscriptSearches.delete(requestId);
    clearTimeout(pending.timer);
    pending.from.send(
      JSON.stringify({
        type: "transcript.search.result",
        requestId,
        entries: pending.entries,
      } satisfies TranscriptSearchResult),
    );
  }

  private activeNotificationSockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => notificationAttachmentOf(ws) !== null);
  }

  /** 失効したdeviceの通知購読も閉じる。所有権接続の失効とは別処理にする。 */
  private closeNotificationOf(deviceId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (notificationAttachmentOf(ws)?.deviceId === deviceId) {
        ws.close(4003, "device revoked");
      }
    }
  }

  private admitOwnership(input: {
    deviceId: string;
    kind: "job" | "branch";
    key: string;
    parentLeaseId: string | null;
    audit: OwnershipAuditConfig;
  }): OwnershipServerMessage {
    if (input.kind === "branch") {
      const parent = this.activeOwnership().find(
        (attachment) =>
          attachment.kind === "job" &&
          attachment.leaseId === input.parentLeaseId &&
          attachment.deviceId === input.deviceId,
      );

      if (parent === undefined) {
        return { type: "ownership.rejected", reason: "ownership_not_current" };
      }
    }

    const taken = this.activeOwnership().some(
      (attachment) =>
        attachment.kind === input.kind && attachment.key === input.key,
    );

    return taken
      ? { type: "ownership.rejected", reason: "already_owned" }
      : {
          type: "ownership.acquired",
          leaseId: crypto.randomUUID(),
          heartbeatIntervalMs: input.audit.heartbeatIntervalMs,
          heartbeatExpiryMs: input.audit.heartbeatExpiryMs,
        };
  }

  /**
   * Alarmでも最終heartbeatを監査し、期限を過ぎた接続を失効させてから閉じる。
   * 監査の運用値は接続付随情報から再構成する。
   */
  override async alarm(): Promise<void> {
    this.expireStaleOwnership();

    const next = Math.min(
      ...this.ctx.getWebSockets().map(
        (ws) =>
          // 通知接続にはauditが無い。所有権接続だけがAlarmの間隔対象になる。
          ownershipAttachmentOf(ws)?.audit.auditIntervalMs ??
          Number.POSITIVE_INFINITY,
      ),
    );

    if (Number.isFinite(next)) {
      await this.ctx.storage.setAlarm(Date.now() + next);
    }
  }

  /** 失効させて閉じた接続を返す。閉じた接続へは以後何も送らない。 */
  private expireStaleOwnership(): Set<WebSocket> {
    const expired = new Set<WebSocket>();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ownershipAttachmentOf(ws);

      if (attachment === null || !attachment.valid) {
        continue;
      }

      const lastHeartbeat =
        this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ??
        attachment.acceptedAt;

      if (Date.now() - lastHeartbeat <= attachment.audit.heartbeatExpiryMs) {
        continue;
      }

      // 接続付随情報を失効状態にしてから閉じる。以後の確認は取得ID不一致になる。
      ws.serializeAttachment({ ...attachment, valid: false });
      ws.send(
        JSON.stringify({
          type: "ownership.expired",
        } satisfies OwnershipServerMessage),
      );
      ws.close(4004, "heartbeat expired");
      expired.add(ws);
    }

    return expired;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      return;
    }

    const notification = notificationAttachmentOf(ws);

    if (notification !== null) {
      this.handleTranscriptRelayMessage(
        ws,
        message,
        notification.transcriptSearchTimeoutMs,
      );
      return;
    }

    let request;

    try {
      request = parseOwnershipClientMessage(JSON.parse(message));
    } catch {
      ws.send(
        JSON.stringify({
          type: "ownership.rejected",
          reason: "invalid_request",
        } satisfies OwnershipServerMessage),
      );
      return;
    }

    if (request.type === "ownership.inspect") {
      // 問い合わせ元も数える側も、期限を過ぎた接続を先に失効させてから読む。
      if (this.expireStaleOwnership().has(ws)) {
        // 自身が失効した接続には、失効通知とcloseだけを答えとして返す。
        return;
      }

      const current = this.isCurrent(ws, request.leaseId);
      const active = current ? this.activeOwnership() : [];

      ws.send(
        JSON.stringify({
          type: "ownership.state",
          requestId: request.requestId,
          current,
          jobKeys: active
            .filter((entry) => entry.kind === "job")
            .map((entry) => entry.key),
          branchKeys: active
            .filter((entry) => entry.kind === "branch")
            .map((entry) => entry.key),
        } satisfies OwnershipServerMessage),
      );
      return;
    }

    ws.send(
      JSON.stringify({
        type: "ownership.confirmed",
        requestId: request.requestId,
        current: this.isCurrent(ws, request.leaseId),
      } satisfies OwnershipServerMessage),
    );
  }

  /** 有効な接続付随情報を持ち、取得IDが現在のものと一致するか。 */
  private isCurrent(ws: WebSocket, leaseId: string): boolean {
    const attachment = ownershipAttachmentOf(ws);

    return (
      attachment !== null && attachment.valid && attachment.leaseId === leaseId
    );
  }

  private activeOwnership(): OwnershipAttachment[] {
    return this.ctx
      .getWebSockets()
      .map(ownershipAttachmentOf)
      .filter(
        (attachment): attachment is OwnershipAttachment =>
          attachment !== null && attachment.valid,
      );
  }

  /** 失効したdeviceの接続を、付随情報を失効させてから閉じる。 */
  private closeOwnershipOf(deviceId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ownershipAttachmentOf(ws);

      if (attachment === null || attachment.deviceId !== deviceId) {
        continue;
      }

      ws.serializeAttachment({ ...attachment, valid: false });
      ws.send(
        JSON.stringify({
          type: "ownership.revoked",
        } satisfies OwnershipServerMessage),
      );
      ws.close(4003, "device revoked");
    }
  }

  /** 期限切れのcodeと取消証明を掃除する。失効済deviceの記録は残す。 */
  purgeExpired(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM registration_codes WHERE expires_at < ?`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM device_cancellations WHERE expires_at < ?`,
      now,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM installation_choices WHERE expires_at < ?`,
      now,
    );
  }
}
