import { expect, test } from "bun:test";

import {
  detectPrResponseTrigger,
  parseCanonicalBranchCandidate,
  type PrResponseActivity,
} from "./pr-response-admission";

const noActivity: PrResponseActivity = {
  reviews: [],
  comments: [],
  reviewComments: [],
  checkFailures: [],
};

test("parses the GitHub issue number and approval fingerprint out of a canonical branch name", () => {
  const fingerprint = "a".repeat(64);

  expect(
    parseCanonicalBranchCandidate(`oriel/eng-42-gh-7-${fingerprint}`),
  ).toEqual({
    githubIssueNumber: 7,
    approvalFingerprint: fingerprint,
  });
  expect(parseCanonicalBranchCandidate("feature/unrelated-branch")).toBeNull();
  expect(
    parseCanonicalBranchCandidate("oriel/eng-42-gh-7-tooshort"),
  ).toBeNull();
});

test("prioritizes a changes-requested review over comments and check failures", () => {
  const trigger = detectPrResponseTrigger({
    ...noActivity,
    reviews: [
      {
        authorIsActor: false,
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-08-17T00:00:00Z",
        body: "please fix X",
      },
    ],
    comments: [
      {
        authorIsActor: false,
        createdAt: "2026-08-17T00:01:00Z",
        body: "also this",
      },
    ],
    checkFailures: [{ checkName: "lint", conclusion: "failure", summary: "" }],
  });

  expect(trigger).toEqual({
    kind: "review",
    body: "please fix X",
    comments: [],
  });
});

test("ignores a review already superseded by the actor's own later comment", () => {
  const trigger = detectPrResponseTrigger({
    ...noActivity,
    reviews: [
      {
        authorIsActor: false,
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-08-17T00:00:00Z",
        body: "please fix X",
      },
    ],
    comments: [
      {
        authorIsActor: true,
        createdAt: "2026-08-17T00:05:00Z",
        body: "Pushed an update addressing the feedback above.",
      },
    ],
  });

  expect(trigger).toBeNull();
});

test("falls back to a comment trigger when there is no pending changes-requested review", () => {
  const trigger = detectPrResponseTrigger({
    ...noActivity,
    comments: [
      {
        authorIsActor: false,
        createdAt: "2026-08-17T00:00:00Z",
        body: "one more thing",
      },
    ],
  });

  expect(trigger).toEqual({
    kind: "comment",
    comments: [{ body: "one more thing" }],
  });
});

test("falls back to a check_failure trigger when nothing else is pending", () => {
  const trigger = detectPrResponseTrigger({
    ...noActivity,
    checkFailures: [
      { checkName: "lint", conclusion: "failure", summary: "boom" },
    ],
  });

  expect(trigger).toEqual({
    kind: "check_failure",
    checkName: "lint",
    conclusion: "failure",
    summary: "boom",
  });
});

test("detects nothing when there is no new activity", () => {
  expect(detectPrResponseTrigger(noActivity)).toBeNull();
});
