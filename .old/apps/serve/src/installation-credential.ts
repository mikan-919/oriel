import type { DeviceTokenStore } from "./device-registration";
import type { GitCredential } from "./git";
import type { RelayDeviceClient } from "./relay-client";

export interface InstallationGitCredentialOptions {
  relay: Pick<RelayDeviceClient, "requestInstallationToken">;
  tokenStore: DeviceTokenStore;
  repositoryId: number;
}

/**
 * canonicalブランチへの送信に使う一回限りのcredential。
 *
 * 実装用途に絞った短命installation tokenだけを取り、この送信の中だけで使う。
 * harnessのenv、argv、tool入力にも、worktreeにも、remote URLにも置かない。
 * 取れない場合、要求した用途と違うtokenが返った場合はnullでfail closedにする。
 */
export function createInstallationGitCredentialResolver({
  relay,
  tokenStore,
  repositoryId,
}: InstallationGitCredentialOptions): () => Promise<GitCredential | null> {
  return async () => {
    const deviceToken = await tokenStore.get(repositoryId);

    if (deviceToken === null) {
      return null;
    }

    const issued = await relay
      .requestInstallationToken(deviceToken, "implementation")
      .catch(() => null);

    return issued === null ||
      issued.repositoryId !== repositoryId ||
      issued.purpose !== "implementation"
      ? null
      : { username: "x-access-token", token: issued.token };
  };
}
