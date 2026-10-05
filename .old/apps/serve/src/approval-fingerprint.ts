import { createHash } from "node:crypto";

import { identity } from "@mikan-919/oriel-identity";

/**
 * [ADR 0003](../../../docs/adr/0003-approval-admission-and-reconciliation.md)の
 * approval fingerprintとcanonical branch。
 *
 * 指紋はseal時点で二度一致した現在のWHAT/HOWを束縛する版識別子であり、本文の
 * 正本でも承認receiptでもない。provider文字列は正規化せず、そのままの並びで
 * encodeする。
 */
const schemaMarker = `${identity.codeName}/approval-fingerprint/v1`;
const digestPattern = /^[0-9a-f]{64}$/;
/** ADR 0003が定めるLinear identifierの許容形。変換も切り詰めもしない。 */
const linearIdentifierPattern =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)*$/;

export interface ApprovalFingerprintInput {
  /** 対象GitHub repositoryのimmutable node ID。 */
  repositoryId: string;
  githubIssueNodeId: string;
  githubTitle: string;
  githubBody: string | null;
  linearIssueUuid: string;
  linearTitle: string;
  linearDescription: string | null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`approval fingerprint needs ${field} as a provider string`);
  }

  return value;
}

function optionalString(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value !== "string") {
    throw new Error(`approval fingerprint needs ${field} as a provider string`);
  }

  return value;
}

export function approvalFingerprint(input: ApprovalFingerprintInput): string {
  const encoded = JSON.stringify([
    schemaMarker,
    requiredString(input.repositoryId, "repositoryId"),
    requiredString(input.githubIssueNodeId, "githubIssueNodeId"),
    requiredString(input.githubTitle, "githubTitle"),
    optionalString(input.githubBody, "githubBody"),
    requiredString(input.linearIssueUuid, "linearIssueUuid"),
    requiredString(input.linearTitle, "linearTitle"),
    optionalString(input.linearDescription, "linearDescription"),
  ]);
  const digest = createHash("sha256")
    .update(Buffer.from(encoded, "utf8"))
    .digest("hex");

  if (!digestPattern.test(digest)) {
    throw new Error("approval fingerprint is not a 64 digit lowercase digest");
  }

  return digest;
}

export interface CanonicalBranchInput {
  linearIdentifier: string;
  githubIssueNumber: number;
  approvalFingerprint: string;
}

/**
 * `oriel/<Linear identifier>-gh-<GitHub issue number>-<full digest>`。
 * 表示部分はroutingのためだけにあり、版の束縛はdigestだけが担う。
 */
export function canonicalBranchName({
  linearIdentifier,
  githubIssueNumber,
  approvalFingerprint: fingerprint,
}: CanonicalBranchInput): string {
  if (
    typeof linearIdentifier !== "string" ||
    !linearIdentifierPattern.test(linearIdentifier)
  ) {
    throw new Error("the Linear identifier cannot become a canonical branch");
  }

  if (!Number.isInteger(githubIssueNumber) || githubIssueNumber <= 0) {
    throw new Error("the GitHub issue number cannot become a canonical branch");
  }

  if (typeof fingerprint !== "string" || !digestPattern.test(fingerprint)) {
    throw new Error(
      "the approval fingerprint cannot become a canonical branch",
    );
  }

  return `${identity.codeName}/${linearIdentifier}-gh-${githubIssueNumber}-${fingerprint}`;
}

export function canonicalRefName(branch: string): string {
  return `refs/heads/${branch}`;
}
