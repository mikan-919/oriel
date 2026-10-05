import { expect, test } from "bun:test";

import { conversationJobSatisfiesModelCapabilities } from "./model-capability-gate";
import type { GitHubTargetBaseReader } from "./github-approval-ports";

const targetBaseOid = "1".repeat(40);

const capableModel = {
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 200000,
  maxTokens: 8192,
};

function port(source?: string): GitHubTargetBaseReader {
  return {
    async readTargetBase() {
      return { ref: "refs/heads/main", oid: targetBaseOid };
    },
    async readTargetBaseFile() {
      return source === undefined
        ? { status: "absent" }
        : { status: "present", content: source };
    },
  };
}

const withCapabilities = `schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - [bun, test]
modelCapabilities:
  reasoning: true
  minContextWindow: 128000
`;

test("a missing, unreadable, or unparseable .oriel.yaml never blocks a conversation Job", async () => {
  const getModelMetadata = async () => null;

  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => null,
      getModelMetadata,
    ),
  ).toBe(true);
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => port(undefined),
      getModelMetadata,
    ),
  ).toBe(true);
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => port("not: [valid"),
      getModelMetadata,
    ),
  ).toBe(true);
});

test("a loaded config without modelCapabilities never blocks a conversation Job", async () => {
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () =>
        port(`schemaVersion: 1
execution:
  backend: worktree
  autonomous: true
  verification:
    - [bun, test]
`),
      async () => null,
    ),
  ).toBe(true);
});

test("a satisfied modelCapabilities request allows the Job", async () => {
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => port(withCapabilities),
      async () => capableModel,
    ),
  ).toBe(true);
});

test("an unmet requirement, or an unresolvable model, refuses the Job", async () => {
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => port(withCapabilities),
      async () => ({ ...capableModel, reasoning: false }),
    ),
  ).toBe(false);
  expect(
    await conversationJobSatisfiesModelCapabilities(
      async () => port(withCapabilities),
      async () => null,
    ),
  ).toBe(false);
});
