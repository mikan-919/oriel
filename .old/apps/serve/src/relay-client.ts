import {
  parseInstallationTokenResponse,
  parseDeviceTokenExchangeResponse,
  parseLinearRoutingResponse,
  type DeviceCancellationRequest,
  type DeviceTokenExchangeRequest,
  type DeviceTokenExchangeResponse,
  type InstallationTokenPurpose,
  type InstallationTokenResponse,
} from "@mikan-919/oriel-contracts";

/**
 * `serve`から公開relayのdevice APIを呼ぶ境界。応答は必ずcontractで検証する。
 * 結果が不明な場合は例外を投げ、呼び出し側が再調停できるようにする。
 */
export interface RelayDeviceClient {
  exchange(
    request: DeviceTokenExchangeRequest,
  ): Promise<DeviceTokenExchangeResponse | null>;
  cancelIssuedDevice(request: DeviceCancellationRequest): Promise<boolean>;
  /**
   * 登録済みdeviceのrepositoryと用途へ絞った短命installation tokenを取り寄せる。
   * 受け取ったtokenは保存せず、その要求の中だけで使う。
   */
  requestInstallationToken(
    deviceToken: string,
    purpose: InstallationTokenPurpose,
  ): Promise<InstallationTokenResponse | null>;
  /**
   * `serve`が自分のLinear teamをrelayへ登録する。ADR 0001のとおりrelayが
   * 永続化してよいのは「routingに使うLinear workspace IDとteam ID」だけで、
   * Linear tokenは保持しない。
   */
  registerLinearRouting(
    deviceToken: string,
    linearTeamId: string,
  ): Promise<boolean>;
}

/** testと製品経路で同じ形を使うための最小のfetch。 */
export type RelayFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export function createRelayDeviceClient({
  baseUrl,
  fetch: fetchImpl = fetch,
}: {
  baseUrl: URL | string;
  fetch?: RelayFetch;
}): RelayDeviceClient {
  function endpoint(path: string): string {
    return new URL(path, baseUrl).toString();
  }

  async function postJson(path: string, body: unknown) {
    return fetchImpl(endpoint(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** 4xxはrelayの拒否、それ以外の失敗は結果不明として投げ直す。 */
  function refusedOrThrow(response: Response, path: string): null {
    if (response.status >= 400 && response.status < 500) {
      return null;
    }

    throw new Error(`Relay responded ${response.status} for ${path}`);
  }

  return {
    async exchange(request) {
      const response = await postJson("/device/token", request);

      return response.ok
        ? parseDeviceTokenExchangeResponse(await response.json())
        : refusedOrThrow(response, "/device/token");
    },
    async requestInstallationToken(deviceToken, purpose) {
      const response = await fetchImpl(endpoint("/device/installation-token"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ purpose }),
      });

      return response.ok
        ? parseInstallationTokenResponse(await response.json())
        : refusedOrThrow(response, "/device/installation-token");
    },
    async cancelIssuedDevice(request) {
      const response = await postJson("/device/cancellation", request);

      if (response.ok) {
        return true;
      }

      refusedOrThrow(response, "/device/cancellation");
      return false;
    },
    async registerLinearRouting(deviceToken, linearTeamId) {
      const response = await fetchImpl(endpoint("/device/linear-routing"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${deviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ linearTeamId }),
      });

      if (response.ok) {
        parseLinearRoutingResponse(await response.json());
        return true;
      }

      refusedOrThrow(response, "/device/linear-routing");
      return false;
    },
  };
}
