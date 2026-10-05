/**
 * relayがGitHub loginへ触る境界。user tokenは本人確認、installation管理権限、
 * repository選択の現在値確認にだけ使い、relayへ保存しない。
 */
export interface RelayGitHubClient {
  authorizeUrl(input: { state: string; redirectUri: string }): string;
  exchangeAuthorizationCode(input: {
    code: string;
    redirectUri: string;
  }): Promise<string | null>;
  getViewer(userToken: string): Promise<{ id: number; login: string } | null>;
  listInstallations(
    userToken: string,
  ): Promise<{ id: number; account: string }[]>;
  listInstallationRepositories(input: {
    userToken: string;
    installationId: number;
  }): Promise<{ id: number; owner: string; name: string }[]>;
  canAdministerInstallation(input: {
    userToken: string;
    installationId: number;
  }): Promise<boolean>;
  /**
   * repositoryとpermissionsを絞った短命installation token。relayは保存せず、
   * 要求した`serve`へその場で返す。
   */
  createInstallationAccessToken(input: {
    installationId: number;
    repositoryIds: number[];
    permissions: Record<string, string>;
  }): Promise<{ token: string; expiresAt: string } | null>;
}

import { createAppJwt } from "./crypto";

const githubApi = "https://api.github.com";

export function createGitHubClient({
  clientId,
  clientSecret,
  userAgent,
  appId,
  privateKeyPem,
  appJwtLifetimeSeconds,
  now = Date.now,
}: {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  appId: string;
  privateKeyPem: string;
  appJwtLifetimeSeconds: number;
  now?: () => number;
}): RelayGitHubClient {
  async function callApi<T>(
    userToken: string,
    path: string,
  ): Promise<T | null> {
    const response = await fetch(`${githubApi}${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${userToken}`,
        "user-agent": userAgent,
      },
    });

    if (response.status === 401 || response.status === 403) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`GitHub responded ${response.status} for ${path}`);
    }

    return (await response.json()) as T;
  }

  return {
    async createInstallationAccessToken({
      installationId,
      repositoryIds,
      permissions,
    }) {
      const jwt = await createAppJwt({
        appId,
        privateKeyPem,
        now: now(),
        lifetimeSeconds: appJwtLifetimeSeconds,
      });
      const response = await fetch(
        `${githubApi}/app/installations/${installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
            "user-agent": userAgent,
          },
          body: JSON.stringify({
            repository_ids: repositoryIds,
            permissions,
          }),
        },
      );

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as {
        token?: string;
        expires_at?: string;
      };

      return body.token === undefined || body.expires_at === undefined
        ? null
        : { token: body.token, expiresAt: body.expires_at };
    },
    authorizeUrl({ state, redirectUri }) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);

      return url.toString();
    },
    async exchangeAuthorizationCode({ code, redirectUri }) {
      const response = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "user-agent": userAgent,
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
            redirect_uri: redirectUri,
          }),
        },
      );

      if (!response.ok) {
        return null;
      }

      const body = (await response.json()) as { access_token?: string };

      return body.access_token ?? null;
    },
    async getViewer(userToken) {
      const viewer = await callApi<{ id: number; login: string }>(
        userToken,
        "/user",
      );

      return viewer === null ? null : { id: viewer.id, login: viewer.login };
    },
    async listInstallations(userToken) {
      const body = await callApi<{
        installations: { id: number; account: { login: string } | null }[];
      }>(userToken, "/user/installations");

      return (body?.installations ?? []).map((installation) => ({
        id: installation.id,
        account: installation.account?.login ?? "",
      }));
    },
    async listInstallationRepositories({ userToken, installationId }) {
      const body = await callApi<{
        repositories: { id: number; name: string; owner: { login: string } }[];
      }>(userToken, `/user/installations/${installationId}/repositories`);

      return (body?.repositories ?? []).map((repository) => ({
        id: repository.id,
        owner: repository.owner.login,
        name: repository.name,
      }));
    },
    async canAdministerInstallation({ userToken, installationId }) {
      const installations = await callApi<{
        installations: {
          id: number;
          account: { id: number; login: string; type: string } | null;
        }[];
      }>(userToken, "/user/installations");
      const installation = installations?.installations.find(
        (candidate) => candidate.id === installationId,
      );

      if (installation?.account == null) {
        return false;
      }

      if (installation.account.type !== "Organization") {
        const viewer = await callApi<{ id: number }>(userToken, "/user");
        return viewer !== null && viewer.id === installation.account.id;
      }

      const membership = await callApi<{ role: string; state: string }>(
        userToken,
        `/user/memberships/orgs/${installation.account.login}`,
      );

      return membership?.role === "admin" && membership.state === "active";
    },
  };
}
