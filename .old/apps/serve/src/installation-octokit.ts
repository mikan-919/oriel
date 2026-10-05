import type { InstallationTokenPurpose } from "@mikan-919/oriel-contracts";
import { Octokit } from "@octokit/rest";

import type { DeviceTokenStore } from "./device-registration";
import type { RelayDeviceClient } from "./relay-client";

export interface InstallationOctokitOptions {
  relay: Pick<RelayDeviceClient, "requestInstallationToken">;
  tokenStore: DeviceTokenStore;
  repositoryId: number;
  /** この呼び出しが行う外部操作の用途。関係のない権限は求めない。 */
  purpose: InstallationTokenPurpose;
  newOctokit?: (auth: string) => Octokit;
}

/**
 * 外部書き込みに使う認証済みOctokitを、要求のたびに組み立てる。
 *
 * device tokenは`Bun.secrets`から読み、relayが返す短命installation tokenは
 * この呼び出しの中だけで使い、どこにも保存しない。harnessのenv、argv、tool
 * 入力へは渡さない。tokenを取れない場合、要求した用途と違うtokenが返った場合は
 * nullを返してfail closedにする。
 */
export function createInstallationOctokitResolver({
  relay,
  tokenStore,
  repositoryId,
  purpose,
  newOctokit = (auth) => new Octokit({ auth }),
}: InstallationOctokitOptions): () => Promise<Octokit | null> {
  return async () => {
    const deviceToken = await tokenStore.get(repositoryId);

    if (deviceToken === null) {
      return null;
    }

    const issued = await relay
      .requestInstallationToken(deviceToken, purpose)
      .catch(() => null);

    return issued === null ||
      issued.repositoryId !== repositoryId ||
      issued.purpose !== purpose
      ? null
      : newOctokit(issued.token);
  };
}
