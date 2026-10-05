import { createHash } from "node:crypto";

import { expect, test } from "bun:test";

import {
  approvalFingerprint,
  canonicalBranchName,
} from "./approval-fingerprint";

const approval = {
  repositoryId: "R_kgDOABCDEF",
  githubIssueNodeId: "I_kwDOABCDEF",
  githubTitle: "WHAT title",
  githubBody: "WHAT body",
  linearIssueUuid: "0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f",
  linearTitle: "HOW title",
  linearDescription: "HOW description",
};

test("the fingerprint is the ADR 0003 canonical encoding of the current WHAT and HOW", () => {
  expect(approvalFingerprint(approval)).toBe(
    createHash("sha256")
      .update(
        '["oriel/approval-fingerprint/v1","R_kgDOABCDEF","I_kwDOABCDEF","WHAT title","WHAT body","0f6f6a0c-1c1e-4a0a-9f6e-2f5f1f3f4f5f","HOW title","HOW description"]',
      )
      .digest("hex"),
  );
  expect(approvalFingerprint(approval)).toMatch(/^[0-9a-f]{64}$/);
});

test("an absent body or description is an empty string, and every element binds the version", () => {
  expect(
    approvalFingerprint({
      ...approval,
      githubBody: null,
      linearDescription: null,
    }),
  ).toBe(
    approvalFingerprint({ ...approval, githubBody: "", linearDescription: "" }),
  );

  const digests = new Set(
    [
      approval,
      { ...approval, repositoryId: "R_other" },
      { ...approval, githubIssueNodeId: "I_other" },
      { ...approval, githubTitle: "other" },
      { ...approval, githubBody: "other" },
      { ...approval, linearIssueUuid: "other" },
      { ...approval, linearTitle: "other" },
      { ...approval, linearDescription: "other" },
    ].map(approvalFingerprint),
  );

  expect(digests.size).toBe(8);
});

test("provider strings are never normalized before hashing", () => {
  expect(
    approvalFingerprint({ ...approval, githubTitle: " WHAT title " }),
  ).not.toBe(approvalFingerprint(approval));
  // NFCとNFDを同じ指紋にしない。
  expect(approvalFingerprint({ ...approval, githubTitle: "é" })).not.toBe(
    approvalFingerprint({ ...approval, githubTitle: "é" }),
  );
});

test("a value that is not a string fails closed", () => {
  for (const invalid of [
    { ...approval, githubTitle: undefined },
    { ...approval, githubTitle: 1 },
    { ...approval, repositoryId: "" },
    { ...approval, githubIssueNodeId: null },
    { ...approval, linearIssueUuid: undefined },
    { ...approval, githubBody: 0 },
  ]) {
    expect(() =>
      approvalFingerprint(invalid as unknown as typeof approval),
    ).toThrow();
  }
});

test("the canonical branch keeps the full digest and the routing part", () => {
  const fingerprint = approvalFingerprint(approval);

  expect(
    canonicalBranchName({
      linearIdentifier: "ENG-12",
      githubIssueNumber: 28,
      approvalFingerprint: fingerprint,
    }),
  ).toBe(`oriel/ENG-12-gh-28-${fingerprint}`);
});

test("a branch name that cannot be built exactly fails closed instead of being slugified", () => {
  const fingerprint = approvalFingerprint(approval);
  const valid = {
    linearIdentifier: "ENG-12",
    githubIssueNumber: 28,
    approvalFingerprint: fingerprint,
  };

  for (const invalid of [
    { ...valid, linearIdentifier: "" },
    { ...valid, linearIdentifier: "-ENG-12" },
    { ...valid, linearIdentifier: "ENG 12" },
    { ...valid, linearIdentifier: "ENG/12" },
    { ...valid, linearIdentifier: "ENG..12" },
    { ...valid, githubIssueNumber: 0 },
    { ...valid, githubIssueNumber: -1 },
    { ...valid, githubIssueNumber: 1.5 },
    { ...valid, approvalFingerprint: fingerprint.slice(0, 16) },
    { ...valid, approvalFingerprint: fingerprint.toUpperCase() },
  ]) {
    expect(() => canonicalBranchName(invalid)).toThrow();
  }

  // 表示部分の点区切りは許す。
  expect(
    canonicalBranchName({ ...valid, linearIdentifier: "ENG.core-12" }),
  ).toBe(`oriel/ENG.core-12-gh-28-${fingerprint}`);
});
