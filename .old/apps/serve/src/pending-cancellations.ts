import type { Database } from "bun:sqlite";

/**
 * 発行済deviceの取消証明。credential storeへ保存できなかった登録を、
 * `serve`の再起動を越えて取り消せるようにする。
 *
 * この値はそのdeviceを失効させることしかできず、接続にも外部操作にも使えない。
 */
export interface PendingDeviceCancellation {
  deviceId: string;
  cancellationToken: string;
  cancellationExpiresAt: number;
}

export interface PendingCancellationStore {
  list(): PendingDeviceCancellation[];
  save(cancellation: PendingDeviceCancellation): void;
  delete(deviceId: string): void;
}

export function createPendingCancellationStore(
  database: Database,
): PendingCancellationStore {
  const insert = database.query(
    `INSERT INTO pending_device_cancellations
       (device_id, cancellation_token, cancellation_expires_at)
     VALUES (?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       cancellation_token = excluded.cancellation_token,
       cancellation_expires_at = excluded.cancellation_expires_at`,
  );
  const remove = database.query(
    `DELETE FROM pending_device_cancellations WHERE device_id = ?`,
  );
  const selectAll = database.query<
    {
      device_id: string;
      cancellation_token: string;
      cancellation_expires_at: number;
    },
    []
  >(
    `SELECT device_id, cancellation_token, cancellation_expires_at
     FROM pending_device_cancellations ORDER BY device_id`,
  );

  return {
    list() {
      return selectAll.all().map((row) => ({
        deviceId: row.device_id,
        cancellationToken: row.cancellation_token,
        cancellationExpiresAt: row.cancellation_expires_at,
      }));
    },
    save(cancellation) {
      insert.run(
        cancellation.deviceId,
        cancellation.cancellationToken,
        cancellation.cancellationExpiresAt,
      );
    },
    delete(deviceId) {
      remove.run(deviceId);
    },
  };
}

/** 試験と、credential storeを持たない経路で使うin-memory実装。 */
export function createInMemoryPendingCancellationStore(): PendingCancellationStore {
  const cancellations = new Map<string, PendingDeviceCancellation>();

  return {
    list: () => [...cancellations.values()],
    save: (cancellation) => {
      cancellations.set(cancellation.deviceId, cancellation);
    },
    delete: (deviceId) => {
      cancellations.delete(deviceId);
    },
  };
}
