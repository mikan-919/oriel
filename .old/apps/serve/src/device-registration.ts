import { createHash, randomBytes } from "node:crypto";

import {
  parseDeviceRegistrationCallback,
  type DeviceRecord,
  type DeviceRegistrationPurpose,
  type GitHubInstallation,
} from "@mikan-919/oriel-contracts";
import { identity } from "@mikan-919/oriel-identity";

import {
  createInMemoryPendingCancellationStore,
  type PendingCancellationStore,
  type PendingDeviceCancellation,
} from "./pending-cancellations";
import type { RelayDeviceClient } from "./relay-client";

/** device tokenの保存先。Secret Serviceを使えない場合はfail closedにする。 */
export interface DeviceTokenStore {
  set(input: { repositoryId: number; deviceToken: string }): Promise<void>;
  get(repositoryId: number): Promise<string | null>;
}

export function bunSecretsDeviceTokenStore(): DeviceTokenStore {
  const name = (repositoryId: number) => `device-token:${repositoryId}`;

  return {
    async set({ repositoryId, deviceToken }) {
      await Bun.secrets.set({
        service: identity.codeName,
        name: name(repositoryId),
        value: deviceToken,
      });
    },
    async get(repositoryId) {
      return (
        (await Bun.secrets.get({
          service: identity.codeName,
          name: name(repositoryId),
        })) ?? null
      );
    },
  };
}

export type DeviceRegistrationResult =
  | { status: "installations"; installations: GitHubInstallation[] }
  | { status: "registered"; deviceId: string }
  | { status: "devices"; devices: DeviceRecord[] }
  | { status: "revoked"; deviceId: string; revokedAt: number }
  | {
      status: "rejected";
      reason:
        | "invalid_callback"
        | "unknown_state"
        | "exchange_rejected"
        | "unexpected_purpose"
        | "registration_target_mismatch"
        | "credential_store_unavailable";
    }
  /** 発行済deviceを取り消せたか確認できない状態。再起動後も再調停を続ける。 */
  | { status: "reconciliation_required"; deviceId: string };

export interface DeviceRegistrationFlowOptions {
  relay: RelayDeviceClient;
  tokenStore: DeviceTokenStore;
  authorizeEndpoint: URL;
  redirectUri: URL;
  cancellationStore?: PendingCancellationStore;
  now?: () => number;
  newSecret?: () => string;
}

interface PendingAuthorization {
  codeVerifier: string;
  purpose: DeviceRegistrationPurpose;
  installationId: number;
  repositoryId: number;
}

/**
 * localhost UIから始めるdevice登録と管理。verifier、challenge、stateは`serve`が作り、
 * codeの交換にverifierを要求することで、開始したこの`serve`へ結び付ける。
 *
 * 一覧と失効も毎回GitHub loginをやり直し、relayがその場でinstallation管理権限を
 * 確かめる。再利用できるsessionもGitHub user tokenも持たない。
 */
export function createDeviceRegistrationFlow({
  relay,
  tokenStore,
  authorizeEndpoint,
  redirectUri,
  cancellationStore = createInMemoryPendingCancellationStore(),
  now = Date.now,
  newSecret = () => randomBytes(32).toString("base64url"),
}: DeviceRegistrationFlowOptions) {
  const pending = new Map<string, PendingAuthorization>();

  async function cancelIssuedDevice(issued: {
    deviceId: string;
    cancellationToken: string;
    cancellationExpiresAt: number;
  }): Promise<boolean> {
    const cancellation: PendingDeviceCancellation = {
      deviceId: issued.deviceId,
      cancellationToken: issued.cancellationToken,
      cancellationExpiresAt: issued.cancellationExpiresAt,
    };

    // 取消を確認できるまで、証明を`serve`のlocal stateへ残す。
    cancellationStore.save(cancellation);

    try {
      if (await relay.cancelIssuedDevice(cancellation)) {
        cancellationStore.delete(cancellation.deviceId);
        return true;
      }
    } catch {
      // 結果不明。保持したまま再調停へ回す。
    }

    return false;
  }

  return {
    begin({
      purpose,
      installationId = 0,
      repositoryId = 0,
      deviceId,
    }: {
      purpose: DeviceRegistrationPurpose;
      installationId?: number;
      repositoryId?: number;
      deviceId?: string;
    }): { authorizeUrl: URL } {
      const codeVerifier = newSecret();
      const state = newSecret();

      pending.set(state, {
        codeVerifier,
        purpose,
        installationId,
        repositoryId,
      });

      const authorizeUrl = new URL(authorizeEndpoint);
      authorizeUrl.searchParams.set("purpose", purpose);

      if (purpose !== "installations") {
        authorizeUrl.searchParams.set(
          "installation_id",
          String(installationId),
        );
        authorizeUrl.searchParams.set("repository_id", String(repositoryId));
      }

      if (deviceId !== undefined) {
        authorizeUrl.searchParams.set("device_id", deviceId);
      }

      authorizeUrl.searchParams.set(
        "code_challenge",
        createHash("sha256").update(codeVerifier).digest("base64url"),
      );
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri.toString());

      return { authorizeUrl };
    },
    async complete(
      callbackUrl: URL | string,
    ): Promise<DeviceRegistrationResult> {
      let callback;

      try {
        callback = parseDeviceRegistrationCallback(
          Object.fromEntries(new URL(callbackUrl).searchParams),
        );
      } catch {
        return { status: "rejected", reason: "invalid_callback" };
      }

      const started = pending.get(callback.state);

      // stateは一回限り。交換の成否によらず取り下げる。
      pending.delete(callback.state);

      if (started === undefined) {
        return { status: "rejected", reason: "unknown_state" };
      }

      const exchanged = await relay.exchange({
        code: callback.code,
        codeVerifier: started.codeVerifier,
      });

      if (exchanged === null) {
        return { status: "rejected", reason: "exchange_rejected" };
      }

      if (exchanged.purpose !== started.purpose) {
        return { status: "rejected", reason: "unexpected_purpose" };
      }

      if (exchanged.purpose === "installations") {
        return {
          status: "installations",
          installations: exchanged.installations,
        };
      }

      const sameTarget =
        exchanged.installationId === started.installationId &&
        exchanged.repositoryId === started.repositoryId;

      if (exchanged.purpose === "device_list") {
        return sameTarget
          ? { status: "devices", devices: exchanged.devices }
          : { status: "rejected", reason: "registration_target_mismatch" };
      }

      if (exchanged.purpose === "revocation") {
        return sameTarget
          ? {
              status: "revoked",
              deviceId: exchanged.deviceId,
              revokedAt: exchanged.revokedAt,
            }
          : { status: "rejected", reason: "registration_target_mismatch" };
      }

      if (!sameTarget) {
        return (await cancelIssuedDevice(exchanged))
          ? { status: "rejected", reason: "registration_target_mismatch" }
          : { status: "reconciliation_required", deviceId: exchanged.deviceId };
      }

      try {
        await tokenStore.set({
          repositoryId: exchanged.repositoryId,
          deviceToken: exchanged.deviceToken,
        });
      } catch {
        // tokenを保管できないまま有効なdeviceを残さない。
        return (await cancelIssuedDevice(exchanged))
          ? { status: "rejected", reason: "credential_store_unavailable" }
          : { status: "reconciliation_required", deviceId: exchanged.deviceId };
      }

      return { status: "registered", deviceId: exchanged.deviceId };
    },
    /** 取消を確認できなかった発行済device。空でない限り登録は完了していない。 */
    pendingCancellations(): PendingDeviceCancellation[] {
      return cancellationStore.list();
    },
    /**
     * 起動時と手動再試行から呼ぶ収束処理。期限切れの証明は自動収束できないため、
     * 報告したまま残す。
     */
    async resumePendingCancellations(): Promise<PendingDeviceCancellation[]> {
      for (const cancellation of cancellationStore.list()) {
        if (cancellation.cancellationExpiresAt > now()) {
          await cancelIssuedDevice(cancellation);
        }
      }

      return cancellationStore.list();
    },
  };
}

export type DeviceRegistrationFlow = ReturnType<
  typeof createDeviceRegistrationFlow
>;
