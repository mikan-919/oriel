import { expect, test } from "bun:test";

import { parseExecutionConfig } from "./execution-config";

const valid = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - [bun, run, typecheck]
    - [bun, test]
`;

test("a repository that declares the whole autonomous contract parses", () => {
  expect(parseExecutionConfig(valid)).toEqual({
    status: "parsed",
    config: {
      schemaVersion: 1,
      execution: {
        backend: "worktree",
        autonomous: true,
        verification: [
          ["bun", "run", "typecheck"],
          ["bun", "test"],
        ],
      },
    },
  });
});

test("a missing or unknown field fails closed rather than defaulting", () => {
  const missingAutonomous = `schemaVersion: 1
execution:
  backend: worktree
  verification:
    - [bun, test]
`;
  const unknownField = `${valid}extra: 1
`;
  const unknownExecutionField = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - [bun, test]
  timeoutMs: 1000
`;

  for (const source of [
    missingAutonomous,
    unknownField,
    unknownExecutionField,
  ]) {
    expect(parseExecutionConfig(source)).toEqual({
      status: "invalid",
      reason: "schema_violation",
    });
  }
});

test("an unknown schema version or a disallowed value fails closed", () => {
  const futureVersion = valid.replace("schemaVersion: 1", "schemaVersion: 2");
  const otherBackend = valid.replace("backend: worktree", "backend: docker");
  const notAutonomous = valid.replace("autonomous: true", "autonomous: false");

  for (const source of [futureVersion, otherBackend, notAutonomous]) {
    expect(parseExecutionConfig(source)).toEqual({
      status: "invalid",
      reason: "schema_violation",
    });
  }
});

test("verification is never an empty list, so nothing can be verified by omission", () => {
  const noVerification = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
`;
  const emptyVerification = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification: []
`;
  const emptyCommand = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - []
`;

  for (const source of [noVerification, emptyVerification, emptyCommand]) {
    expect(parseExecutionConfig(source)).toEqual({
      status: "invalid",
      reason: "schema_violation",
    });
  }
});

test("modelCapabilities is optional and, when present, constrains reasoning/image/context/output", () => {
  const withCapabilities = `${valid}modelCapabilities:
  reasoning: true
  image: true
  minContextWindow: 128000
  minMaxTokens: 8192
`;

  expect(parseExecutionConfig(withCapabilities)).toEqual({
    status: "parsed",
    config: {
      schemaVersion: 1,
      execution: {
        backend: "worktree",
        autonomous: true,
        verification: [
          ["bun", "run", "typecheck"],
          ["bun", "test"],
        ],
      },
      modelCapabilities: {
        reasoning: true,
        image: true,
        minContextWindow: 128000,
        minMaxTokens: 8192,
      },
    },
  });

  // 省略した既存の.oriel.yamlは変更なしで動作し続ける。
  expect(parseExecutionConfig(valid)).toEqual({
    status: "parsed",
    config: {
      schemaVersion: 1,
      execution: {
        backend: "worktree",
        autonomous: true,
        verification: [
          ["bun", "run", "typecheck"],
          ["bun", "test"],
        ],
      },
    },
  });
});

test("modelCapabilities rejects false, non-integers, and unknown fields", () => {
  const reasoningFalse = `${valid}modelCapabilities:
  reasoning: false
`;
  const nonInteger = `${valid}modelCapabilities:
  minContextWindow: 1.5
`;
  const zero = `${valid}modelCapabilities:
  minMaxTokens: 0
`;
  const unknownField = `${valid}modelCapabilities:
  providerId: openai
`;

  for (const source of [reasoningFalse, nonInteger, zero, unknownField]) {
    expect(parseExecutionConfig(source)).toEqual({
      status: "invalid",
      reason: "schema_violation",
    });
  }
});

test("YAML that does not parse, or that uses a custom tag, fails closed", () => {
  expect(parseExecutionConfig("schemaVersion: [1\n")).toEqual({
    status: "invalid",
    reason: "yaml_unparsable",
  });
  expect(
    parseExecutionConfig(
      valid.replace("schemaVersion: 1", "schemaVersion: !ruby/object 1"),
    ),
  ).toEqual({ status: "invalid", reason: "yaml_unparsable" });
});
