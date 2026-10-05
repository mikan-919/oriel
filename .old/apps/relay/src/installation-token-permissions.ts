import { identity } from "@mikan-919/oriel-identity";

/**
 * 短命installation tokenへ載せてよい最大権限。
 *
 * CONCEPT.md原則2の「制限された外部操作」を、relayが発行するtokenの権限そのもの
 * でも守る。製品が必要とするのは、canonicalブランチの送信（contents）、Issueと
 * Linear連携の書き込み（issues）、レビュー可能なプルリクエスト（pull_requests）、
 * repositoryの現在値読み取り（metadata）だけとする。これ以外のkey、およびここへ
 * 書いた値より広い値は受け付けない。PR対応Job([ADR 0007](../../../docs/adr/0007-pull-request-response-job.md))
 * のため、required checkの読み取り(checks)とbranch protectionの読み取り
 * (administration)も同じallowlistで絞る。
 */
export const maximumInstallationTokenPermissions = {
  contents: ["read", "write"],
  issues: ["read", "write"],
  pull_requests: ["read", "write"],
  checks: ["read"],
  administration: ["read"],
  metadata: ["read"],
} as const satisfies Record<string, readonly string[]>;

/** allowlistの最大値。設定を与えない場合の既定でもある。 */
export const minimalInstallationTokenPermissions: Record<string, string> =
  Object.fromEntries(
    Object.entries(maximumInstallationTokenPermissions).map(
      ([permission, values]) => [permission, values[values.length - 1]],
    ),
  );

/**
 * 用途ごとの権限集合。
 *
 * 一つのtokenへ製品全体の権限を載せず、その要求が行う外部操作に必要な権限だけを
 * 発行する。Issue対話はcodeへ触れず、admissionの現在値確認は読み取りだけを持ち、
 * 実装の書き込みはcanonicalブランチの送信だけを持つ。
 */
export const installationTokenPurposePermissions = {
  issue_conversation: { issues: "write", metadata: "read" },
  admission: {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
  implementation: { contents: "write", metadata: "read" },
  pull_request: {
    contents: "read",
    pull_requests: "write",
    metadata: "read",
  },
  /**
   * PR対応Jobのdiscoveryと報告。read only(pull_requests/checks/administration)
   * とPRへのcomment投稿(issues)だけを持ち、mergeやcontentsの書き込みは持たない。
   * canonicalブランチへの送信は既存の"implementation"用途を再利用する。
   */
  pr_response: {
    pull_requests: "read",
    checks: "read",
    administration: "read",
    issues: "write",
    metadata: "read",
  },
} as const satisfies Record<string, Record<string, string>>;

export type InstallationTokenPurpose =
  keyof typeof installationTokenPurposePermissions;

/**
 * 発行する権限を、用途とdeploy設定の狭いほうへ落とす。用途が未知の場合と、
 * 設定が与えていない権限を用途が必要とする場合はnullでfail closedにする。
 */
export function permissionsForPurpose(
  granted: Record<string, string>,
  purpose: string,
): Record<string, string> | null {
  if (!Object.hasOwn(installationTokenPurposePermissions, purpose)) {
    return null;
  }

  const required =
    installationTokenPurposePermissions[purpose as InstallationTokenPurpose];
  const issued: Record<string, string> = {};

  for (const [permission, value] of Object.entries(required)) {
    const configured = granted[permission];

    if (configured === undefined) {
      return null;
    }

    const allowed: readonly string[] =
      maximumInstallationTokenPermissions[
        permission as keyof typeof maximumInstallationTokenPermissions
      ];
    // allowlistの並びを広さの順序とし、狭いほうだけを載せる。
    issued[permission] =
      allowed.indexOf(configured) < allowed.indexOf(value) ? configured : value;
  }

  return issued;
}

function fail(detail: string): never {
  throw new Error(
    `${identity.environmentPrefix}INSTALLATION_TOKEN_PERMISSIONS ${detail}`,
  );
}

/**
 * 設定として受け取った権限を検証する。allowlist外のkey、許可した値より広い値、
 * string以外、空はfail closedにする。
 */
export function assertInstallationTokenPermissions(
  value: Record<string, string>,
): Record<string, string> {
  const entries = Object.entries(value);

  if (entries.length === 0) {
    fail("must grant at least one permission");
  }

  for (const [permission, granted] of entries) {
    const allowed: readonly string[] | undefined = Object.hasOwn(
      maximumInstallationTokenPermissions,
      permission,
    )
      ? maximumInstallationTokenPermissions[
          permission as keyof typeof maximumInstallationTokenPermissions
        ]
      : undefined;

    if (allowed === undefined) {
      fail(`must not grant ${permission}`);
    }

    if (typeof granted !== "string" || !allowed.includes(granted)) {
      fail(`must not grant ${permission} as ${String(granted)}`);
    }
  }

  return { ...value };
}

/** deploy設定のJSONを、allowlistを通った権限だけへ落とす。 */
export function parseInstallationTokenPermissions(
  json: string,
): Record<string, string> {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return fail("must be JSON");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.getOwnPropertySymbols(parsed).length > 0
  ) {
    return fail("must be a JSON object of permissions");
  }

  return assertInstallationTokenPermissions(parsed as Record<string, string>);
}
