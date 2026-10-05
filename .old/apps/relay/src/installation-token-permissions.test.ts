import { describe, expect, it } from "vitest";

import {
  installationTokenPurposePermissions,
  minimalInstallationTokenPermissions,
  parseInstallationTokenPermissions,
  permissionsForPurpose,
} from "./installation-token-permissions";

describe("installation token permissions", () => {
  it("keeps only the permissions the product needs", () => {
    expect(minimalInstallationTokenPermissions).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      checks: "read",
      administration: "read",
      metadata: "read",
    });
  });

  it("accepts a configured subset that is not wider than the allowlist", () => {
    expect(
      parseInstallationTokenPermissions(
        JSON.stringify({ issues: "write", contents: "read", metadata: "read" }),
      ),
    ).toEqual({ issues: "write", contents: "read", metadata: "read" });
  });

  it("refuses permissions outside the allowlist", () => {
    expect(() =>
      parseInstallationTokenPermissions(
        JSON.stringify({ issues: "write", administration: "write" }),
      ),
    ).toThrow();
    expect(() =>
      parseInstallationTokenPermissions(
        JSON.stringify({
          members: "read",
          organization_administration: "read",
        }),
      ),
    ).toThrow();
  });

  it("refuses values wider than the allowlisted maximum", () => {
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ issues: "admin" })),
    ).toThrow();
    // metadataはreadだけを許す。
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ metadata: "write" })),
    ).toThrow();
  });

  it("separates the permission set of each purpose", () => {
    // Issue対話は書き込みをIssueだけに限り、codeへ触れない。
    expect(installationTokenPurposePermissions.issue_conversation).toEqual({
      issues: "write",
      metadata: "read",
    });
    // admissionの現在値確認は読み取りだけとする。
    expect(installationTokenPurposePermissions.admission).toEqual({
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
    // 実装の書き込みはcanonicalブランチの送信だけで、Issueへは書かない。
    expect(installationTokenPurposePermissions.implementation).toEqual({
      contents: "write",
      metadata: "read",
    });
    // レビュー可能なプルリクエストの作成はPR対応phaseだけの権限とする。
    expect(installationTokenPurposePermissions.pull_request).toEqual({
      contents: "read",
      pull_requests: "write",
      metadata: "read",
    });
    // PR対応Jobのdiscoveryと報告は読み取りとPRへのcomment投稿だけで、mergeや
    // contentsの書き込みは持たない(ADR 0007)。
    expect(installationTokenPurposePermissions.pr_response).toEqual({
      pull_requests: "read",
      checks: "read",
      administration: "read",
      issues: "write",
      metadata: "read",
    });
  });

  it("issues only the permissions of the requested purpose", () => {
    expect(
      permissionsForPurpose(
        minimalInstallationTokenPermissions,
        "issue_conversation",
      ),
    ).toEqual({ issues: "write", metadata: "read" });
    expect(
      permissionsForPurpose(minimalInstallationTokenPermissions, "admission"),
    ).toEqual({
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
  });

  it("never widens a purpose beyond the deployed allowlist", () => {
    // deploy設定がcontentsをreadへ絞っていれば、実装用途もreadを越えない。
    expect(
      permissionsForPurpose(
        { contents: "read", issues: "write", metadata: "read" },
        "implementation",
      ),
    ).toEqual({ contents: "read", metadata: "read" });
    // 設定が与えていない権限は用途が要求しても発行しない。
    expect(
      permissionsForPurpose({ issues: "write" }, "implementation"),
    ).toBeNull();
  });

  it("refuses an unknown purpose", () => {
    expect(
      permissionsForPurpose(minimalInstallationTokenPermissions, "admin"),
    ).toBeNull();
    expect(permissionsForPurpose(minimalInstallationTokenPermissions, "")) //
      .toBeNull();
  });

  it("refuses input that is not an object of string values", () => {
    expect(() => parseInstallationTokenPermissions("")).toThrow();
    expect(() => parseInstallationTokenPermissions("null")).toThrow();
    expect(() => parseInstallationTokenPermissions("[]")).toThrow();
    expect(() => parseInstallationTokenPermissions("{}")).toThrow();
    expect(() =>
      parseInstallationTokenPermissions(JSON.stringify({ issues: 1 })),
    ).toThrow();
    expect(() =>
      parseInstallationTokenPermissions('{"__proto__":{"issues":"write"}}'),
    ).toThrow();
  });
});
